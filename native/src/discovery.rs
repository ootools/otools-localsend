//! UDP multicast discovery (Task 6): LocalSend v2 announcements on
//! 224.0.0.167:53317 and the fingerprint-keyed device table behind it.
//!
//! Protocol facts (localsend/protocol v2.2):
//! - Announcements are JSON objects (`alias`, `version`, `deviceModel`,
//!   `deviceType`, `fingerprint`, `port`, `protocol`, `download`, `announce`)
//!   followed by a trailing newline.
//! - A receiver of `announce: true` replies to the origin over HTTP with
//!   `POST /api/localsend/v2/register` (origin IP from the UDP datagram, port
//!   from the announce payload). That HTTP call belongs to Task 9's sender
//!   http client, so [`DiscoveryShared`] only queues
//!   `(ip, port, our-info)` register replies for that wiring to consume —
//!   no HTTP stack lives in this module.
//! - The fingerprint is the SHA-256 hex digest of the TLS certificate DER
//!   (Task 4 [`crate::crypto`]) and doubles as the device table key.

use crate::event_bridge::WebEventBroadcaster;
use crate::models::DeviceInfo;
use crate::settings::Settings;
use serde::Serialize;
use serde_json::Value;
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket as StdUdpSocket};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, Notify};

/// Multicast group shared by all LocalSend v2 devices.
pub const MULTICAST_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
/// Canonical UDP discovery port; binding falls back to the next ports.
pub const DISCOVERY_PORT: u16 = 53317;
/// Fallback window: after `port` fails, try `port + 1` .. `port + 10`.
pub const PORT_FALLBACK_ATTEMPTS: u16 = 10;
/// Protocol version announced as major.minor (we implement v2.2).
pub const PROTOCOL_VERSION: &str = "2.2";
/// How often an `announce: true` frame is re-sent.
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(5);
/// How often stale devices are reaped from the table.
pub const GC_INTERVAL: Duration = Duration::from_secs(15);
/// Device TTL (the official app reaps on the same schedule).
pub const DEVICE_TTL: Duration = Duration::from_secs(75);
/// UDP payload buffer size; announce frames are tiny but stay tolerant.
const MAX_DATAGRAM: usize = 65536;
/// Pause before rebinding attempts (total bind failure or a dead socket).
const RETRY_PAUSE: Duration = Duration::from_secs(5);
/// Pause after a `recv_from` error (Windows can surface WSAECONNRESET here
/// after a send towards an unreachable peer) to avoid hot-looping.
const RECV_ERROR_PAUSE: Duration = Duration::from_millis(100);

/// One discovered device as surfaced to the frontend (in `device_list` and
/// the `device-found` event). `lastSeenMs` is the elapsed time in
/// milliseconds since the device was last seen in an announcement frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub info: DeviceInfo,
    pub ip: String,
    pub last_seen_ms: u64,
}

struct DeviceRecord {
    info: DeviceInfo,
    ip: IpAddr,
    last_seen: Instant,
}

/// Fingerprint-keyed registry of discovered devices.
///
/// [`DeviceTable::upsert`] ignores frames whose fingerprint equals the local
/// fingerprint, so this instance never appears in its own table.
pub struct DeviceTable {
    local_fingerprint: String,
    devices: Mutex<HashMap<String, DeviceRecord>>,
}

impl DeviceTable {
    pub fn new(local_fingerprint: impl Into<String>) -> Self {
        Self {
            local_fingerprint: local_fingerprint.into(),
            devices: Mutex::new(HashMap::new()),
        }
    }

    pub fn local_fingerprint(&self) -> &str {
        &self.local_fingerprint
    }

    /// Insert or refresh a device keyed by fingerprint. Returns `true` when
    /// the fingerprint was not in the table before (a genuinely new device,
    /// which the caller turns into a `device-found` event). Re-upserts
    /// replace the payload, source IP and `last_seen`; frames carrying the
    /// local fingerprint are ignored and return `false`.
    pub fn upsert(&self, info: DeviceInfo, ip: IpAddr) -> bool {
        if info.fingerprint == self.local_fingerprint {
            return false;
        }
        let mut devices = self
            .devices
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let was_new = !devices.contains_key(&info.fingerprint);
        devices.insert(
            info.fingerprint.clone(),
            DeviceRecord {
                info,
                ip,
                last_seen: Instant::now(),
            },
        );
        was_new
    }

    /// Snapshot of the table, ordered by fingerprint for stable output.
    pub fn list(&self) -> Vec<DeviceEntry> {
        let devices = self
            .devices
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut entries: Vec<DeviceEntry> = devices
            .values()
            .map(|record| DeviceEntry {
                info: record.info.clone(),
                ip: record.ip.to_string(),
                last_seen_ms: record.last_seen.elapsed().as_millis() as u64,
            })
            .collect();
        entries.sort_by(|a, b| a.info.fingerprint.cmp(&b.info.fingerprint));
        entries
    }

    /// Drop devices not seen within `ttl` and return their fingerprints (the
    /// caller emits one `device-lost` event per expired fingerprint).
    pub fn gc(&self, ttl: Duration) -> Vec<String> {
        let mut devices = self
            .devices
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let expired: Vec<String> = devices
            .iter()
            .filter(|(_, record)| record.last_seen.elapsed() >= ttl)
            .map(|(fingerprint, _)| fingerprint.clone())
            .collect();
        for fingerprint in &expired {
            devices.remove(fingerprint);
        }
        expired
    }
}

/// Serialize an announcement frame: the device info JSON plus the `announce`
/// flag, followed by a trailing newline per the v2 wire format.
pub fn announce_frame(info: &DeviceInfo, announce: bool) -> Vec<u8> {
    let mut value = serde_json::to_value(info).expect("DeviceInfo always serializes");
    let object = value
        .as_object_mut()
        .expect("DeviceInfo serializes to a JSON object");
    object.insert("announce".to_owned(), Value::Bool(announce));
    let mut bytes = serde_json::to_vec(&value).expect("Value always serializes");
    bytes.push(b'\n');
    bytes
}

/// Tolerant parse of one datagram into `(DeviceInfo, announce)`.
///
/// Accepts frames with or without a trailing newline (plus stray surrounding
/// whitespace). A missing `announce` field (older v2 peers) parses as
/// `false`; malformed JSON, invalid UTF-8, non-object payloads or missing
/// required device fields return `None`.
pub fn parse_frame(bytes: &[u8]) -> Option<(DeviceInfo, bool)> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    if !value.is_object() {
        return None;
    }
    let announce = value
        .get("announce")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let info: DeviceInfo = serde_json::from_value(value).ok()?;
    Some((info, announce))
}

/// One queued register reply. Announce frames carrying `announce: true` are
/// answered over HTTP by POSTing our own info to `<ip>:<port>
/// /api/localsend/v2/register`; Task 6 only queues, Task 9's sender wiring
/// drains this queue with its http client.
pub type RegisterReply = (String, u16, DeviceInfo);

/// State shared between the discovery loop and the runtime dispatch methods.
pub struct DiscoveryShared {
    pub devices: DeviceTable,
    pub local_fingerprint: String,
    pub event: Arc<WebEventBroadcaster>,
    /// The UDP port discovery actually bound (0 while unbound). Discovery
    /// falls back from the canonical 53317 when that port is taken.
    pub udp_port: AtomicU16,
    /// Our own announcement payload (settings + fingerprint + HTTPS port).
    local_info: Mutex<DeviceInfo>,
    /// `discover_now` pokes this; the loop answers with an immediate
    /// `announce: true` send.
    announce_notify: Notify,
    register_tx: mpsc::UnboundedSender<RegisterReply>,
    register_rx: Mutex<mpsc::UnboundedReceiver<RegisterReply>>,
}

impl DiscoveryShared {
    pub fn new(local_info: DeviceInfo, event: Arc<WebEventBroadcaster>) -> Self {
        let (register_tx, register_rx) = mpsc::unbounded_channel();
        Self {
            devices: DeviceTable::new(local_info.fingerprint.clone()),
            local_fingerprint: local_info.fingerprint.clone(),
            event,
            udp_port: AtomicU16::new(0),
            local_info: Mutex::new(local_info),
            announce_notify: Notify::new(),
            register_tx,
            register_rx: Mutex::new(register_rx),
        }
    }

    /// Snapshot of the payload announced for this instance.
    pub fn snapshot_local_info(&self) -> DeviceInfo {
        self.local_info
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Replace our announcement payload. Called from `settings_set` and,
    /// later, by Task 7 when the HTTPS port fallback changes the announced
    /// port.
    pub fn update_local_info(&self, info: DeviceInfo) {
        *self
            .local_info
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = info;
    }

    /// Actual bound UDP discovery port (0 while unbound).
    pub fn udp_port(&self) -> u16 {
        self.udp_port.load(Ordering::SeqCst)
    }

    /// `discover_now`: ask the loop for an immediate `announce: true` send.
    /// Permits are sticky, so calls made while the loop is busy are honored
    /// on the next iteration instead of being lost.
    pub fn request_announce(&self) {
        self.announce_notify.notify_one();
    }

    /// Queue a register reply for Task 9's http client. Sending never fails:
    /// the receiver lives in `self` and is only dropped together with it.
    pub fn queue_register_reply(&self, ip: String, port: u16, info: DeviceInfo) {
        let _ = self.register_tx.send((ip, port, info));
    }

    /// Drain all queued register replies. Task 9's wiring consumes these and
    /// POSTs `/api/localsend/v2/register` to each origin.
    pub fn take_register_replies(&self) -> Vec<RegisterReply> {
        let mut receiver = self
            .register_rx
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut replies = Vec::new();
        while let Ok(reply) = receiver.try_recv() {
            replies.push(reply);
        }
        replies
    }
}

/// Build our own announcement payload from settings and the certificate
/// fingerprint. `download` mirrors `auto_save` (the v2 flag marks a device
/// that auto-accepts downloads); the announced `port` is the HTTPS server
/// port, reconciled with Task 7's actual bind via
/// [`DiscoveryShared::update_local_info`].
pub fn local_info_from_settings(settings: &Settings, fingerprint: &str) -> DeviceInfo {
    DeviceInfo {
        alias: settings.alias.clone(),
        version: PROTOCOL_VERSION.to_string(),
        device_model: settings.device_model.clone(),
        device_type: Some(settings.device_type.clone()),
        fingerprint: fingerprint.to_string(),
        port: settings.port,
        protocol: "https".to_string(),
        download: settings.auto_save,
    }
}

/// Discovery loop: bind UDP (with port fallback), join the multicast group,
/// announce every 5s, reap the table every 15s, and parse incoming frames.
/// Runs until the owning runtime is dropped.
pub async fn run_discovery(state: Arc<DiscoveryShared>, settings_port: u16) {
    loop {
        let socket = match bind_discovery_socket(settings_port) {
            Ok((socket, port)) => {
                state.udp_port.store(port, Ordering::SeqCst);
                match UdpSocket::from_std(socket) {
                    Ok(socket) => socket,
                    Err(error) => {
                        state.udp_port.store(0, Ordering::SeqCst);
                        eprintln!("otools-localsend discovery: async socket: {error}");
                        tokio::time::sleep(RETRY_PAUSE).await;
                        continue;
                    }
                }
            }
            Err(error) => {
                // User-facing bind-failure surfacing belongs to the Task 7
                // server status event; discovery retries quietly so it heals
                // once the port frees up.
                eprintln!(
                    "otools-localsend discovery: bind {settings_port}..+{} failed: {error}",
                    PORT_FALLBACK_ATTEMPTS
                );
                tokio::time::sleep(RETRY_PAUSE).await;
                continue;
            }
        };
        discovery_session(&state, &socket).await;
        // The session only ends on a dead socket; rebind after a pause.
        state.udp_port.store(0, Ordering::SeqCst);
        tokio::time::sleep(RETRY_PAUSE).await;
    }
}

async fn discovery_session(state: &DiscoveryShared, socket: &UdpSocket) {
    // The first announce goes out immediately after binding.
    let mut next_announce = Instant::now();
    let mut next_gc = Instant::now() + GC_INTERVAL;
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    loop {
        // Due work runs at the top so every wake source (timers, packets,
        // discover_now) shares one code path.
        let now = Instant::now();
        if now >= next_announce {
            send_announce(state, socket).await;
            next_announce = Instant::now() + ANNOUNCE_INTERVAL;
        }
        if now >= next_gc {
            for fingerprint in state.devices.gc(DEVICE_TTL) {
                state.event.send(
                    "device-lost",
                    serde_json::json!({ "fingerprint": fingerprint }),
                );
            }
            next_gc = Instant::now() + GC_INTERVAL;
        }

        enum Wake {
            Timer,
            Packet(io::Result<(usize, SocketAddr)>),
            AnnounceNow,
        }
        let wake = tokio::select! {
            _ = tokio::time::sleep_until(next_announce.min(next_gc).into()) => Wake::Timer,
            result = socket.recv_from(&mut buffer) => Wake::Packet(result),
            _ = state.announce_notify.notified() => Wake::AnnounceNow,
        };
        // The select's futures (which borrow `buffer`) are dropped here, so
        // the packet handler below can read the buffer again.
        match wake {
            Wake::Timer => {}
            Wake::AnnounceNow => {
                send_announce(state, socket).await;
                next_announce = Instant::now() + ANNOUNCE_INTERVAL;
            }
            Wake::Packet(Ok((len, source))) => {
                handle_frame(state, &buffer[..len], source).await;
            }
            Wake::Packet(Err(error)) => {
                eprintln!("otools-localsend discovery: recv: {error}");
                tokio::time::sleep(RECV_ERROR_PAUSE).await;
            }
        }
    }
}

async fn send_announce(state: &DiscoveryShared, socket: &UdpSocket) {
    let info = state.snapshot_local_info();
    let frame = announce_frame(&info, true);
    if let Err(error) = socket
        .send_to(&frame, (MULTICAST_GROUP, DISCOVERY_PORT))
        .await
    {
        eprintln!("otools-localsend discovery: send announce: {error}");
    }
}

async fn handle_frame(state: &DiscoveryShared, bytes: &[u8], source: SocketAddr) {
    let Some((info, announce)) = parse_frame(bytes) else {
        return;
    };
    if info.fingerprint == state.local_fingerprint {
        // Self echo: multicast loopback is intentionally ON (see
        // `bind_multicast_socket` — disabling it makes same-host peers
        // invisible on Windows), so our own announce frames legitimately
        // come back to us; filter them by fingerprint here.
        return;
    }
    let is_new = state.devices.upsert(info.clone(), source.ip());
    if is_new {
        let entry = serde_json::to_value(DeviceEntry {
            info: info.clone(),
            ip: source.ip().to_string(),
            last_seen_ms: 0,
        })
        .unwrap_or_else(|_| serde_json::json!({ "fingerprint": info.fingerprint }));
        state.event.send("device-found", entry);
    }
    if announce {
        // The register HTTP POST belongs to Task 9's sender http client;
        // queue the reply for that wiring.
        let our_info = state.snapshot_local_info();
        state.queue_register_reply(source.ip().to_string(), info.port, our_info);
    }
}

/// Bind the discovery UDP socket on `0.0.0.0:port`, falling back to the next
/// ports up to `port + PORT_FALLBACK_ATTEMPTS`. Returns the socket and the
/// port it actually bound (the caller records it in
/// [`DiscoveryShared::udp_port`]).
fn bind_discovery_socket(port: u16) -> io::Result<(StdUdpSocket, u16)> {
    let mut last_error = None;
    for candidate in port..=port.saturating_add(PORT_FALLBACK_ATTEMPTS) {
        match bind_multicast_socket(candidate) {
            Ok(socket) => return Ok((socket, candidate)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::AddrNotAvailable, "no discovery port candidate")
    }))
}

fn bind_multicast_socket(port: u16) -> io::Result<StdUdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // Share the port with other multicast listeners (the official LocalSend
    // client sets the same option); harmless when we are the only listener.
    socket.set_reuse_address(true)?;
    socket.bind(&SockAddr::from(SocketAddr::from((
        Ipv4Addr::UNSPECIFIED,
        port,
    ))))?;
    socket.join_multicast_v4(&MULTICAST_GROUP, &Ipv4Addr::UNSPECIFIED)?;
    // NOTE: IP_MULTICAST_LOOP stays at the Windows default (enabled). On
    // Windows the flag gates the delivery of ALL local loop-copies TO this
    // socket, not just our own sends — disabling it makes same-host peers
    // (the official LocalSend app next to us, integration tests) invisible.
    // Our own echoed frames are filtered by fingerprint in `handle_frame`.
    socket.set_multicast_ttl_v4(1)?; // LAN scope
    let socket: StdUdpSocket = socket.into();
    socket.set_nonblocking(true)?;
    Ok(socket)
}

#[cfg(test)]
mod tests {
    use super::{announce_frame, parse_frame, DeviceTable};
    use crate::models::DeviceInfo;
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::Duration;

    fn sample_info(fingerprint: &str, alias: &str) -> DeviceInfo {
        DeviceInfo {
            alias: alias.to_string(),
            version: "2.2".into(),
            device_model: Some("ThinkPad".into()),
            device_type: Some("desktop".into()),
            fingerprint: fingerprint.to_string(),
            port: 53317,
            protocol: "https".into(),
            download: false,
        }
    }

    fn ipv4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn announce_frame_roundtrip() {
        let info = sample_info(&"a".repeat(64), "测试机");
        for announce in [true, false] {
            let frame = announce_frame(&info, announce);
            assert!(frame.ends_with(b"\n"), "frame must end with a newline");
            assert_eq!(parse_frame(&frame), Some((info.clone(), announce)));
            // Tolerant: the trailing newline is optional.
            assert_eq!(
                parse_frame(&frame[..frame.len() - 1]),
                Some((info.clone(), announce)),
                "parse must accept frames without the trailing newline"
            );
        }
        let value: serde_json::Value =
            serde_json::from_slice(&announce_frame(&info, true)).expect("frame is JSON");
        assert_eq!(value["alias"], "测试机");
        assert_eq!(value["fingerprint"], "a".repeat(64));
        assert_eq!(value["port"], 53317);
        assert_eq!(value["protocol"], "https");
        assert_eq!(value["announce"], true);
    }

    #[test]
    fn device_table_upsert_dedupes_by_fingerprint() {
        let table = DeviceTable::new("l".repeat(64));
        let fingerprint = "a".repeat(64);
        assert!(
            table.upsert(sample_info(&fingerprint, "First"), ipv4(192, 168, 1, 10)),
            "first upsert is a new device"
        );
        assert_eq!(table.list().len(), 1);

        assert!(
            !table.upsert(sample_info(&fingerprint, "Second"), ipv4(192, 168, 1, 11)),
            "same fingerprint must dedupe"
        );
        let list = table.list();
        assert_eq!(list.len(), 1, "one entry per fingerprint");
        assert_eq!(list[0].info.alias, "Second", "newest payload wins");
        assert_eq!(list[0].ip, "192.168.1.11", "newest source ip wins");
        assert!(
            list[0].last_seen_ms < 1000,
            "lastSeen must be refreshed by the re-upsert"
        );
        assert!(
            table.gc(Duration::from_millis(20)).is_empty(),
            "a freshly refreshed device survives even a tiny ttl"
        );

        assert!(
            table.upsert(sample_info(&"b".repeat(64), "Other"), ipv4(192, 168, 1, 12)),
            "a different fingerprint is a separate entry"
        );
        assert_eq!(table.list().len(), 2);
    }

    #[test]
    fn device_table_gc_expires_stale() {
        let table = DeviceTable::new("l".repeat(64));
        let stale_fingerprint = "a".repeat(64);
        table.upsert(sample_info(&stale_fingerprint, "Stale"), ipv4(192, 168, 1, 10));

        assert_eq!(
            table.gc(Duration::ZERO),
            vec![stale_fingerprint.clone()],
            "a tiny ttl expires the stale device and returns its fingerprint"
        );
        assert!(table.list().is_empty(), "gc removed the expired entry");

        let fresh_fingerprint = "b".repeat(64);
        table.upsert(sample_info(&fresh_fingerprint, "Fresh"), ipv4(192, 168, 1, 11));
        assert!(
            table.gc(Duration::from_secs(75)).is_empty(),
            "the official 75s ttl keeps fresh devices"
        );
        assert_eq!(table.list().len(), 1);
        assert_eq!(table.list()[0].info.fingerprint, fresh_fingerprint);
    }

    #[test]
    fn parse_rejects_garbage() {
        let garbage: &[&[u8]] = &[
            b"",
            b"\n",
            b"   \n",
            b"not json",
            b"42\n",
            b"[1,2,3]\n",
            br#"{"alias":"only-alias"}"#,
            // Missing the required port field.
            br#"{"alias":"x","version":"2.2","fingerprint":"ff","protocol":"https","download":false}"#,
            // Port of the wrong type.
            br#"{"alias":"x","version":"2.2","fingerprint":"ff","port":"53317","protocol":"https","download":false}"#,
            // Invalid UTF-8.
            b"\xff\xfe\x00garbage\n",
        ];
        for frame in garbage {
            assert_eq!(parse_frame(frame), None, "must reject: {frame:?}");
        }

        // Minimal valid frame: optional fields omitted, missing announce
        // (older v2 peers) parses as false.
        let minimal = br#"{"alias":"m","version":"2.2","fingerprint":"ab","port":53317,"protocol":"https","download":false}"#;
        assert_eq!(
            parse_frame(minimal),
            Some((
                DeviceInfo {
                    alias: "m".into(),
                    version: "2.2".into(),
                    device_model: None,
                    device_type: None,
                    fingerprint: "ab".into(),
                    port: 53317,
                    protocol: "https".into(),
                    download: false,
                },
                false,
            )),
        );
    }

    #[test]
    fn local_fingerprint_filtered() {
        let local_fingerprint = "c".repeat(64);
        let table = DeviceTable::new(local_fingerprint.clone());
        assert!(
            !table.upsert(sample_info(&local_fingerprint, "Self"), ipv4(127, 0, 0, 1)),
            "upsert must ignore frames carrying the local fingerprint"
        );
        assert!(table.list().is_empty(), "self frames never enter the table");

        assert!(
            table.upsert(sample_info(&"d".repeat(64), "Peer"), ipv4(192, 168, 1, 5)),
            "real peers still land in the table"
        );
        assert_eq!(table.list().len(), 1);
    }
}
