//! Independent loopback HTTP/TLS peer for native transport regressions.
//! Requests are interpreted as literal HTTP and JSON, never plugin DTOs.

use crate::crypto::sha256_hex;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, Error, SignatureScheme};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CERTIFICATE: &[u8] = include_bytes!("../tests/fixtures/peer-cert.der");
const PRIVATE_KEY: &[u8] = include_bytes!("../tests/fixtures/peer-key.der");

pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
    pub client_fingerprint: Option<String>,
}

pub(crate) struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }
}

pub(crate) struct Peer {
    pub port: u16,
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Peer {
    pub fn http(handler: impl Fn(Request) -> Response + Send + 'static) -> Self {
        Self::serve(None, handler)
    }

    pub fn https(
        required_client_fingerprint: Option<String>,
        handler: impl Fn(Request) -> Response + Send + 'static,
    ) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let builder = rustls::ServerConfig::builder();
        let builder = match required_client_fingerprint {
            Some(expected) => {
                builder.with_client_cert_verifier(Arc::new(ExpectedClientCert::new(expected)))
            }
            None => builder.with_no_client_auth(),
        };
        let config = builder
            .with_single_cert(
                vec![CertificateDer::from(CERTIFICATE.to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(PRIVATE_KEY.to_vec())),
            )
            .expect("independent TLS fixture");
        Self::serve(Some(Arc::new(config)), handler)
    }

    fn serve(
        tls: Option<Arc<rustls::ServerConfig>>,
        handler: impl Fn(Request) -> Response + Send + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("isolated peer listener");
        let port = listener.local_addr().unwrap().port();
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let worker = std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_nonblocking(false)
                            .expect("blocking accepted stream");
                        socket
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        socket
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        if let Some(tls) = &tls {
                            let mut connection =
                                rustls::ServerConnection::new(Arc::clone(tls)).unwrap();
                            let deadline = Instant::now() + Duration::from_secs(3);
                            let mut handshake_ok = true;
                            while connection.is_handshaking() {
                                if Instant::now() >= deadline {
                                    handshake_ok = false;
                                    break;
                                }
                                if let Err(error) = connection.complete_io(&mut socket) {
                                    eprintln!("isolated peer handshake: {error}");
                                    handshake_ok = false;
                                    break;
                                }
                            }
                            if !handshake_ok {
                                // Deliver the fatal alert before closing; unread client bytes
                                // otherwise turn this fixture failure into a Winsock reset.
                                while connection.wants_write() {
                                    if connection.write_tls(&mut socket).is_err() {
                                        break;
                                    }
                                }
                                let _ = socket.flush();
                                let _ = socket.shutdown(std::net::Shutdown::Write);
                                let _ = socket.set_read_timeout(Some(Duration::from_millis(200)));
                                let mut remaining = [0; 1024];
                                while socket.read(&mut remaining).is_ok_and(|size| size > 0) {}
                                continue;
                            }
                            let fingerprint = connection
                                .peer_certificates()
                                .and_then(|certificates| certificates.first())
                                .map(|certificate| sha256_hex(certificate.as_ref()));
                            let mut stream = rustls::StreamOwned::new(connection, socket);
                            exchange(&mut stream, fingerprint, &handler);
                        } else {
                            exchange(&mut socket, None, &handler);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            port,
            stopped,
            worker: Some(worker),
        }
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().expect("isolated peer worker");
        }
    }
}

fn exchange(
    stream: &mut (impl Read + Write),
    client_fingerprint: Option<String>,
    handler: &impl Fn(Request) -> Response,
) {
    let mut headers = Vec::new();
    let mut byte = [0u8; 1];
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() >= 16 * 1024 || stream.read_exact(&mut byte).is_err() {
            return;
        }
        headers.push(byte[0]);
    }
    let Ok(headers) = std::str::from_utf8(&headers) else {
        return;
    };
    let mut lines = headers.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let size = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, size)| size.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if size > 128 * 1024 {
        return;
    }
    let mut body = vec![0; size];
    if stream.read_exact(&mut body).is_err() {
        return;
    }
    let response = handler(Request {
        method,
        path,
        body,
        client_fingerprint,
    });
    let head = format!(
        "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status, response.body.len(),
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(response.body.as_bytes());
    let _ = stream.flush();
}

/// Mirrors the official modern server's custom mTLS policy: require the
/// expected certificate and verify handshake signatures, not a public CA.
#[derive(Debug)]
struct ExpectedClientCert {
    expected: String,
    signatures: Arc<dyn ClientCertVerifier>,
}

impl ExpectedClientCert {
    fn new(expected: String) -> Self {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(CertificateDer::from(CERTIFICATE.to_vec()))
            .expect("fixture root");
        Self {
            expected,
            signatures: rustls::server::WebPkiClientVerifier::builder(Arc::new(roots))
                .build()
                .unwrap(),
        }
    }
}

impl ClientCertVerifier for ExpectedClientCert {
    fn offer_client_auth(&self) -> bool {
        true
    }
    fn client_auth_mandatory(&self) -> bool {
        true
    }
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        certificate: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        if sha256_hex(certificate.as_ref()) != self.expected {
            return Err(Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, Error> {
        self.signatures
            .verify_tls12_signature(message, certificate, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, Error> {
        self.signatures
            .verify_tls13_signature(message, certificate, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.signatures.supported_verify_schemes()
    }
}

pub(crate) fn observed() -> Arc<Mutex<Vec<Request>>> {
    Arc::new(Mutex::new(Vec::new()))
}
