"""DLL interop matrix (Task 8, PART C): drives lib/Windows.dll over ctypes
against live `scripts/mock-peer.mjs` subprocesses — real UDP multicast
discovery, real HTTPS v2 exchanges, no mocks of the protocol itself.

Run: `python -I scripts/interop-test.py` (the script re-execs itself with
-I when invoked otherwise). `OTOOLS_DATA_DIR` is pointed at a fresh temp
directory for every run, every child process is killed on exit (atexit +
finally), and each scenario prints a PASS/FAIL/SKIP line with details.
"""

import atexit
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
LIBRARY = ROOT / "lib" / "Windows.dll"

# Isolated mode is a hard rule (no ambient site packages, no cwd on sys.path).
if not sys.flags.isolated:
    os.execv(sys.executable, [sys.executable, "-I", str(Path(__file__).resolve()), *sys.argv[1:]])

# Reuse the ctypes FFI helpers from Task 3's smoke driver.
_spec = importlib.util.spec_from_file_location("smoke_native", SCRIPTS / "smoke-native.py")
smoke_native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke_native)

MB = 1024 * 1024

_children: list[subprocess.Popen] = []


def register_child(proc: subprocess.Popen) -> subprocess.Popen:
    _children.append(proc)
    return proc


def kill_children() -> None:
    for proc in _children:
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
    for proc in _children:
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


atexit.register(kill_children)


class SkipScenario(Exception):
    """Raised by a scenario that cannot run on this machine (not a failure)."""


# ---------------------------------------------------------------------------
# DLL surface
# ---------------------------------------------------------------------------

def invoke(method: str, payload=None):
    return smoke_native.invoke(method, payload)


def ok_data(method: str, payload=None):
    result = invoke(method, payload)
    assert result.get("ok") is True, f"{method} failed: {result}"
    return result["data"]


def drain_events():
    return smoke_native.drain_events()


def wait_dll_event(name, predicate=lambda data: True, timeout=15.0):
    """Poll poll_events until `name` matching `predicate` arrives (drains everything)."""
    deadline = time.monotonic() + timeout
    seen = 0
    while time.monotonic() < deadline:
        for event in drain_events():
            seen += 1
            if event["event"] == name and predicate(event["data"]):
                return event["data"]
        time.sleep(0.05)
    raise TimeoutError(f"DLL event {name} not seen within {timeout}s ({seen} events drained)")


def server_status():
    return ok_data("server_status")


def device_list():
    return ok_data("device_list")


def transfer_list():
    return ok_data("transfer_list")["transfers"]


def find_record(session_id):
    matches = [r for r in transfer_list() if r["sessionId"] == session_id]
    assert len(matches) == 1, f"expected exactly one record for {session_id}: {len(matches)}"
    return matches[0]


def record_by_file_name(name):
    matches = [r for r in transfer_list() if any(f["fileName"] == name for f in r["files"])]
    assert matches, f"no transfer record carries the file {name}"
    return matches[0]


def set_settings(mutate):
    current = ok_data("settings_get")
    mutate(current)
    return ok_data("settings_set", {"settings": current})


def reset_pin():
    current = ok_data("settings_get")
    current.pop("pin", None)  # omitted key deserializes to None (PIN off)
    ok_data("settings_set", {"settings": current})


# ---------------------------------------------------------------------------
# mock-peer subprocess wrapper
# ---------------------------------------------------------------------------

class MockPeer:
    """A `node scripts/mock-peer.mjs` subprocess; stdout JSON lines are the events."""

    def __init__(self, args, label="mock"):
        self.label = label
        self.events = []
        self.stderr_lines = []
        self._lock = threading.Lock()
        self.proc = register_child(
            subprocess.Popen(
                ["node", str(SCRIPTS / "mock-peer.mjs"), *args],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(ROOT),
            )
        )
        threading.Thread(target=self._pump, args=(self.proc.stdout, self.events), daemon=True).start()
        threading.Thread(target=self._pump, args=(self.proc.stderr, self.stderr_lines), daemon=True).start()

    def _pump(self, stream, sink):
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                item = {"event": "raw", "line": line}
            with self._lock:
                sink.append(item)

    def snapshot(self):
        with self._lock:
            return list(self.events), list(self.stderr_lines)

    def of_type(self, name):
        events, _ = self.snapshot()
        return [e for e in events if e.get("event") == name]

    def wait_event(self, name, predicate=lambda e: True, timeout=15.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in self.of_type(name):
                if predicate(event):
                    return event
            time.sleep(0.05)
        return None

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            pass

    def diagnostics(self):
        events, stderr = self.snapshot()
        return f"events={json.dumps(events[-8:])} stderr={stderr[-5:]}"


# ---------------------------------------------------------------------------
# scenario harness
# ---------------------------------------------------------------------------

RESULTS: list[tuple[str, str, str]] = []
CTX = {}


def report(name, status, detail=""):
    RESULTS.append((name, status, detail))
    suffix = f" [{detail}]" if detail else ""
    print(f"{status}: {name}{suffix}", flush=True)


def scenario(fn):
    def wrapper():
        name = fn.__name__
        started = time.monotonic()
        children_before = len(_children)
        try:
            detail = fn()
            report(name, "PASS", f"{detail} [{time.monotonic() - started:.1f}s]")
        except SkipScenario as skip:
            report(name, "SKIP", str(skip))
        except Exception as error:
            report(name, "FAIL", f"{type(error).__name__}: {error} [{time.monotonic() - started:.1f}s]")
        finally:
            # A failed scenario must not leak its senders into the next one.
            for proc in _children[children_before:]:
                if proc.poll() is None:
                    proc.kill()

    wrapper.__name__ = fn.__name__
    return wrapper


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(MB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_random_file(directory: Path, name: str, size: int) -> Path:
    path = directory / name
    with open(path, "wb") as handle:
        remaining = size
        while remaining > 0:
            chunk = os.urandom(min(MB, remaining))
            handle.write(chunk)
            remaining -= len(chunk)
    return path


def make_text_file(directory: Path, name: str, text: str) -> Path:
    path = directory / name
    path.write_text(text, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def start_dll():
    """Load the DLL, point OTOOLS_DATA_DIR at a fresh dir, start the shell."""
    data_dir = Path(tempfile.mkdtemp(prefix="otools-localsend-interop-"))
    os.environ["OTOOLS_DATA_DIR"] = str(data_dir)
    atexit.register(shutil.rmtree, data_dir, ignore_errors=True)

    smoke_native.load_dll(LIBRARY)
    settings = ok_data("settings_get")
    assert settings["port"] == 53317, f"unexpected default port: {settings}"
    assert ok_data("start_localsend") == {"started": True}

    deadline = time.monotonic() + 30
    status = server_status()
    while status["port"] == 0 and time.monotonic() < deadline:
        time.sleep(0.1)
        status = server_status()
    assert status["port"] != 0, f"HTTPS server never bound: {status}"
    devices = device_list()
    while devices["udpPort"] == 0 and time.monotonic() < deadline:
        time.sleep(0.1)
        devices = device_list()
    assert devices["udpPort"] != 0, f"discovery never bound: {devices}"
    return data_dir, status["port"], devices["udpPort"]


def main():
    data_dir, tcp_port, udp_port = start_dll()
    work = Path(tempfile.mkdtemp(prefix="otools-localsend-interop-work-"))
    atexit.register(shutil.rmtree, work, ignore_errors=True)
    (work / "downloads").mkdir()
    CTX.update(
        data_dir=data_dir,
        work=work,
        src=work / "src",
        downloads=work / "downloads",
        tcp_port=tcp_port,
        udp_port=udp_port,
        fingerprint=server_status()["fingerprint"],
        alias=ok_data("settings_get")["alias"],
    )
    CTX["src"].mkdir()

    started = time.monotonic()
    print(
        f"interop: DLL started (tcp {tcp_port}, udp {udp_port}, alias {CTX['alias']!r});"
        f" data dir {data_dir}",
        flush=True,
    )
    try:
        for test in SCENARIOS:
            test()
    finally:
        kill_children()
        try:
            invoke("__otools_shutdown__")
        except Exception:
            pass

    failed = [name for name, status, _ in RESULTS if status == "FAIL"]
    print(
        f"--- interop summary: {len(RESULTS) - len(failed)}/{len(RESULTS)} passed,"
        f" total {time.monotonic() - started:.1f}s ---",
        flush=True,
    )
    for name, status, detail in RESULTS:
        print(f"{status}: {name} [{detail}]", flush=True)
    sys.exit(1 if failed else 0)


# ===========================================================================
# Scenarios
# ===========================================================================

SCENARIOS = []


def register_scenario(fn):
    SCENARIOS.append(fn)
    return fn


@register_scenario
@scenario
def discovery():
    """DLL and mock discover each other via real UDP multicast + register."""
    # (1) fallback ports recorded and consistent; 53317 is occupied by the
    # official LocalSend app on this machine, so >= 53317 (53318 typical).
    assert CTX["tcp_port"] >= 53317, f"tcp port: {CTX['tcp_port']}"
    assert CTX["udp_port"] >= 53317, f"udp port: {CTX['udp_port']}"
    time.sleep(1.0)
    assert server_status()["port"] == CTX["tcp_port"], "tcp port not consistent"
    assert device_list()["udpPort"] == CTX["udp_port"], "udp port not consistent"

    mock = MockPeer(
        ["serve", "--alias", "MockPeer", "--dir", str(CTX["work"] / "mock-download")],
        label="serve",
    )
    listening = mock.wait_event("listening", timeout=15)
    assert listening, f"mock never listened: {mock.diagnostics()}"
    assert listening["udpPort"] >= 53317, f"mock udp port: {listening}"

    # (2) the DLL's device_list contains MockPeer within 15s — identified by
    # the freshly started mock's fingerprint (other same-alias peers may exist).
    entry = None
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and entry is None:
        for device in device_list()["devices"]:
            if device["info"]["fingerprint"] == listening["fingerprint"]:
                entry = device
        time.sleep(0.2)
    assert entry, (
        f"MockPeer not discovered; devices="
        f"{[d['info']['alias'] for d in device_list()['devices']]}; mock: {mock.diagnostics()}"
    )
    assert entry["info"]["alias"] == "MockPeer", f"unexpected alias: {entry['info']}"

    # (3) the mock completes its protocol register POST against the DLL and
    # sees the DLL's device info (the "register" stdout event).
    register = mock.wait_event(
        "register", lambda e: e.get("peer", {}).get("alias") == CTX["alias"], timeout=15
    )
    assert register, f"mock never registered against the DLL: {mock.diagnostics()}"
    assert register["peer"]["fingerprint"] == CTX["fingerprint"], "register fingerprint mismatch"
    assert register["peer"]["port"] == CTX["tcp_port"], (
        f"announced port {register['peer']['port']} != bound tcp port {CTX['tcp_port']}"
    )
    return f"udp {CTX['udp_port']} tcp {CTX['tcp_port']}, peer ip {entry['ip']}"


@register_scenario
@scenario
def receive_files():
    """Mock sends a 64MB file + 测试文件.txt; DLL receives, verifies, cleans tmp."""
    drain_events()
    set_settings(lambda s: s.update(downloadDir=str(CTX["downloads"])))

    big = make_random_file(CTX["src"], "big-64mb.bin", 64 * MB)
    small = make_text_file(
        CTX["src"], "测试文件.txt", "你好，LocalSend — 非ASCII文件名互传测试\n第二行\n"
    )
    expected = {"big-64mb.bin": sha256_file(big), "测试文件.txt": sha256_file(small)}

    mock = MockPeer(
        [
            "send",
            "--to",
            f"127.0.0.1:{CTX['tcp_port']}",
            "--file",
            str(big),
            "--file",
            str(small),
        ]
    )
    incoming = wait_dll_event("incoming-request", timeout=30)
    session_id = incoming["sessionId"]
    names = {f["fileName"] for f in incoming["files"]}
    assert names == {"big-64mb.bin", "测试文件.txt"}, f"unexpected file list: {names}"
    sizes = {f["fileName"]: f["size"] for f in incoming["files"]}
    assert sizes["big-64mb.bin"] == 64 * MB, f"announced size: {sizes}"

    accepted = ok_data("session_accept", {"sessionId": session_id})
    assert len(accepted["accepted"]) == 2, f"accept-all: {accepted}"

    done = mock.wait_event("done", timeout=180)
    assert done and done.get("status") == "done", (
        f"mock send did not finish cleanly: {done}; {mock.diagnostics()}"
    )
    uploads = mock.of_type("uploaded")
    assert {u["fileName"] for u in uploads} == {"big-64mb.bin", "测试文件.txt"}

    wait_dll_event(
        "transfer-done",
        lambda d: d["sessionId"] == session_id and d["status"] == "done",
        timeout=60,
    )
    record = find_record(session_id)
    assert record["status"] == "Done", f"record status: {record['status']}"
    assert record["peerAlias"] == "MockSender"

    # Destinations: byte-identical files under the download dir, exact names.
    by_id = {f["id"]: f for f in incoming["files"]}
    assert set(record["destinations"]) == set(by_id), (
        f"destinations {list(record['destinations'])} vs files {list(by_id)}"
    )
    for file_id, destination in record["destinations"].items():
        entry = by_id[file_id]
        assert Path(destination).name == entry["fileName"], (
            f"non-ASCII name lost: {destination}"
        )
        assert Path(destination).parent == CTX["downloads"], f"moved: {destination}"
        assert sha256_file(destination) == expected[entry["fileName"]], (
            f"bytes differ for {entry['fileName']}"
        )

    # The per-session temp dirs are cleaned after the move (Review Focus #2/3).
    tmp_root = CTX["data_dir"] / "tmp"
    leftovers = list(tmp_root.iterdir()) if tmp_root.exists() else []
    assert leftovers == [], f"tmp not cleaned: {leftovers}"
    drain_events()
    return "64MB + 测试文件.txt byte-identical, tmp cleaned"


@register_scenario
@scenario
def receive_pin():
    """Wrong/missing PIN is 401 without side effects; correct PIN succeeds; reset."""
    drain_events()
    set_settings(lambda s: s.update(pin="123456"))
    records_before = len(transfer_list())

    # Missing PIN: the DLL must answer 401 ("PIN required") immediately —
    # no incoming-request, no transfer record.
    wrong = make_text_file(CTX["src"], "pin-wrong.txt", "sent without a pin")
    mock = MockPeer(["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(wrong)])
    done = mock.wait_event("done", timeout=20)
    assert done and done["status"] == "pin-rejected", f"expected 401: {done} {mock.diagnostics()}"
    prep = mock.of_type("prepare")
    assert prep and prep[0]["status"] == 401 and "PIN" in prep[0].get("error", ""), prep
    assert len(transfer_list()) == records_before, "401 attempt created a record"
    assert not [e for e in drain_events() if e["event"] == "incoming-request"], (
        "401 attempt emitted incoming-request"
    )

    # Correct PIN: the held prepare is accepted through session_accept.
    right = make_text_file(CTX["src"], "pin-right.txt", "sent with pin 123456")
    mock2 = MockPeer(
        ["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(right), "--pin", "123456"]
    )
    incoming = wait_dll_event("incoming-request", timeout=30)
    ok_data("session_accept", {"sessionId": incoming["sessionId"]})
    done = mock2.wait_event("done", timeout=60)
    assert done and done["status"] == "done", f"pin accept failed: {done} {mock2.diagnostics()}"
    wait_dll_event(
        "transfer-done",
        lambda d: d["sessionId"] == incoming["sessionId"] and d["status"] == "done",
        timeout=30,
    )
    assert find_record(incoming["sessionId"])["status"] == "Done"

    reset_pin()
    assert ok_data("settings_get").get("pin") is None, "pin not reset"
    drain_events()
    return "401 without pin / success with pin=123456 / pin reset"


@register_scenario
@scenario
def receive_decline_cancel():
    """(a) decline → sender sees 403; (b) cancel mid-upload kills the upload;
    (c) a dead sender frees the single slot for the next prepare (PART A hardening 1)."""
    drain_events()

    # (a) decline: the held prepare resolves 403 "Rejected" to the sender.
    decline_file = make_text_file(CTX["src"], "decline-me.txt", "decline payload")
    mock = MockPeer(
        ["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(decline_file), "--decline"]
    )
    incoming = wait_dll_event("incoming-request", timeout=30)
    ok_data("session_decline", {"sessionId": incoming["sessionId"]})
    done = mock.wait_event("done", timeout=30)
    assert done and done["status"] == "declined", f"sender must see the 403: {done} {mock.diagnostics()}"
    prep = mock.of_type("prepare")
    assert prep and prep[0]["status"] == 403 and "Rejected" in prep[0].get("error", ""), prep
    assert find_record(incoming["sessionId"])["status"] == "Cancelled"

    # (b) cancel mid-upload: the in-flight upload fails once the session is gone.
    mid_file = make_random_file(CTX["src"], "cancel-mid.bin", 16 * MB)
    mock2 = MockPeer(
        ["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(mid_file), "--slow-ms", "25"]
    )
    incoming2 = wait_dll_event("incoming-request", timeout=30)
    ok_data("session_accept", {"sessionId": incoming2["sessionId"]})
    started = mock2.wait_event("upload-start", timeout=30)
    assert started, f"mock never started uploading: {mock2.diagnostics()}"
    time.sleep(0.5)  # let a few hundred KB flow first
    ok_data("session_cancel", {"sessionId": incoming2["sessionId"]})
    done2 = mock2.wait_event("done", timeout=60)
    assert done2, f"mock never finished: {mock2.diagnostics()}"
    failures = mock2.of_type("upload-failed")
    assert done2["status"] == "failed" and failures, (
        f"in-flight upload must fail after cancel: {done2} {mock2.diagnostics()}"
    )
    assert find_record(incoming2["sessionId"])["status"] == "Cancelled"

    # (c) dead sender: the prepare connection is destroyed before any decision;
    # the next normal send must NOT be answered 409 (dead pending slot reclaimed).
    ghost_file = make_text_file(CTX["src"], "dead-sender.txt", "vanishing sender")
    ghost = MockPeer(
        ["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(ghost_file), "--abort-prepare"]
    )
    aborted = ghost.wait_event("aborted", timeout=20)
    assert aborted, f"ghost never aborted its prepare: {ghost.diagnostics()}"

    after_file = make_text_file(CTX["src"], "after-ghost.txt", "normal send after ghost")
    accepted_id = None
    for _attempt in range(20):
        drain_events()
        probe = MockPeer(["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(after_file)])
        try:
            incoming3 = wait_dll_event("incoming-request", timeout=5)
        except TimeoutError:
            blocked = probe.wait_event("done", timeout=10)
            probe.kill()
            if blocked and blocked.get("status") == "blocked":
                continue  # the dead session was not yet reclaimed; retry
            raise AssertionError(f"second send failed in an unexpected way: {blocked}")
        ok_data("session_accept", {"sessionId": incoming3["sessionId"]})
        done3 = probe.wait_event("done", timeout=60)
        assert done3 and done3["status"] == "done", (
            f"post-reclaim transfer failed: {done3} {probe.diagnostics()}"
        )
        accepted_id = incoming3["sessionId"]
        break
    assert accepted_id, "dead pending slot was never reclaimed (still 409)"

    # The ghost session was aborted → its record is Cancelled, slot freed.
    ghost_record = record_by_file_name("dead-sender.txt")
    assert ghost_record["status"] == "Cancelled", f"ghost record: {ghost_record['status']}"
    drain_events()
    return "403 decline / mid-upload cancel failed / dead slot reclaimed"


@register_scenario
@scenario
def panel_closed_rebuild():
    """A full transfer without any poll_events call; transfer_list rebuilds it
    completely afterwards (Review Focus #3)."""
    drain_events()
    payload = make_random_file(CTX["src"], "panel-closed.bin", 4 * MB)
    expected = sha256_file(payload)

    mock = MockPeer(["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(payload)])
    # The "panel is closed": NO poll_events until the transfer is over. The
    # pending session is discovered via transfer_list (the rebuild path).
    session_id = None
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and session_id is None:
        for record in transfer_list():
            if record["status"] == "Pending":
                session_id = record["sessionId"]
        time.sleep(0.1)
    assert session_id, f"no Pending record appeared: {mock.diagnostics()}"

    ok_data("session_accept", {"sessionId": session_id})
    done = mock.wait_event("done", timeout=120)
    assert done and done["status"] == "done", f"transfer failed: {done} {mock.diagnostics()}"

    # Still no poll_events: the finished record must be complete.
    record = find_record(session_id)
    assert record["status"] == "Done", f"record status: {record['status']}"
    assert record["files"][0]["fileName"] == "panel-closed.bin"
    destinations = list(record["destinations"].values())
    assert len(destinations) == 1, f"destinations: {record['destinations']}"
    assert sha256_file(destinations[0]) == expected, "payload bytes differ"

    # Now "reopen the panel": the queued events must still carry transfer-done.
    events = drain_events()
    matching = [
        e for e in events
        if e["event"] == "transfer-done" and e["data"]["sessionId"] == session_id
    ]
    assert matching and matching[-1]["data"]["status"] == "done", (
        f"queued transfer-done lost while the panel was closed: {len(events)} events"
    )
    return "transfer_list rebuilt a completed transfer without poll_events"


@register_scenario
@scenario
def sha256_mismatch():
    """A sender lying about sha256 gets 422 and retries the same token up to
    3 attempts; then the file is Failed in transfer_list."""
    drain_events()
    payload = make_text_file(CTX["src"], "corrupt-me.txt", "payload whose sha the sender lies about")
    mock = MockPeer(
        ["send", "--to", f"127.0.0.1:{CTX['tcp_port']}", "--file", str(payload), "--corrupt-sha"]
    )
    incoming = wait_dll_event("incoming-request", timeout=30)
    session_id = incoming["sessionId"]
    ok_data("session_accept", {"sessionId": session_id})

    done = mock.wait_event("done", timeout=90)
    assert done and done["status"] == "failed", f"corrupt send must fail: {done} {mock.diagnostics()}"
    starts = mock.of_type("upload-start")
    retries = mock.of_type("upload-retry")
    failures = mock.of_type("upload-failed")
    assert len(starts) == 3 and len(retries) == 2, (
        "sender must attempt exactly 3 uploads on the same token: "
        f"{len(starts)} starts, {len(retries)} retries, {len(failures)} failures; "
        f"events={json.dumps(mock.of_type('upload-start') + mock.of_type('upload-retry') + failures)}"
    )

    wait_dll_event(
        "transfer-done",
        lambda d: d["sessionId"] == session_id and d["status"] == "failed",
        timeout=60,
    )
    record = find_record(session_id)
    assert record["status"] == "Failed", f"record status: {record['status']}"

    # The corrupt temp file was deleted: no file left in the session tmp dir.
    tmp_session = CTX["data_dir"] / "tmp" / session_id
    leftovers = list(tmp_session.iterdir()) if tmp_session.exists() else []
    assert leftovers == [], f"mismatched temp file not deleted: {leftovers}"
    drain_events()
    return "422 x3 with same token, then Failed + temp cleaned"


@register_scenario
@scenario
def pin_rate_limit():
    """3 wrong PINs from a distinct loopback source IP are 401; the 4th attempt
    is 429 even with the correct PIN (per-IP budget, official MAX_PIN_ATTEMPTS).
    Skipped (not failed) when binding the source IP is not practical."""
    drain_events()
    set_settings(lambda s: s.update(pin="654321"))
    statuses = []
    for index in range(3):
        wrong = make_text_file(CTX["src"], f"wrong-pin-{index}.txt", "wrong pin")
        mock = MockPeer(
            [
                "send",
                "--to",
                f"127.0.0.1:{CTX['tcp_port']}",
                "--file",
                str(wrong),
                "--pin",
                "000000",
                "--local-ip",
                "127.0.0.2",
            ]
        )
        done = mock.wait_event("done", timeout=30)
        prep = mock.of_type("prepare")
        if not prep:
            bind_failed = any(
                "EADDRNOTAVAIL" in line or "EINVAL" in line or "localAddress" in line
                for line in mock.stderr_lines
            )
            if bind_failed:
                reset_pin()
                raise SkipScenario("source IP binding unavailable on this loopback")
            raise AssertionError(f"no prepare event: {done} {mock.diagnostics()}")
        statuses.append(prep[0]["status"])
    assert statuses == [401, 401, 401], f"three wrong pins must 401: {statuses}"

    # The 4th attempt is rate limited BEFORE the pin is even compared.
    fourth = make_text_file(CTX["src"], "rate-limited.txt", "correct pin but exhausted")
    mock = MockPeer(
        [
            "send",
            "--to",
            f"127.0.0.1:{CTX['tcp_port']}",
            "--file",
            str(fourth),
            "--pin",
            "654321",
            "--local-ip",
            "127.0.0.2",
        ]
    )
    done = mock.wait_event("done", timeout=30)
    prep = mock.of_type("prepare")
    assert prep and prep[0]["status"] == 429, f"expected 429: {prep} {done} {mock.diagnostics()}"
    assert "Too many requests" in prep[0].get("error", ""), prep

    reset_pin()
    drain_events()
    return "401 x3 then 429 from 127.0.0.2 (per-IP budget)"


@register_scenario
@scenario
def send_files():
    """DLL send_files -> mock serve (accept-all): 2 files received byte-exact
    (one ~8MB, one named 中文发送.txt); then a slow send is cancelled mid-upload:
    the mock sees POST /cancel and the DLL record turns Cancelled."""
    drain_events()
    mock = MockPeer(
        ["serve", "--alias", "SendTarget", "--dir", str(CTX["work"] / "mock-receive")]
    )
    listening = mock.wait_event("listening", timeout=15)
    assert listening, f"mock never listened: {mock.diagnostics()}"

    big = make_random_file(CTX["src"], "send-8mb.bin", 8 * MB)
    chinese = make_text_file(CTX["src"], "中文发送.txt", "中文文件名发送测试\n")
    result = ok_data(
        "send_files",
        {
            "ip": "127.0.0.1",
            "port": listening["port"],
            "files": [{"path": str(big)}, {"path": str(chinese)}],
        },
    )
    session_id = result["sessionId"]
    assert session_id, f"no sessionId: {result}"

    done = mock.wait_event("done", lambda e: e.get("status") == "done", timeout=120)
    assert done, f"mock never saw the whole transfer: {mock.diagnostics()}"
    uploads = mock.of_type("uploaded")
    assert {u["fileName"] for u in uploads} == {"send-8mb.bin", "中文发送.txt"}, uploads
    expected_bytes = {"send-8mb.bin": 8 * MB, "中文发送.txt": chinese.stat().st_size}
    for upload in uploads:
        assert upload["bytes"] == expected_bytes[upload["fileName"]], (
            f"uploaded bytes mismatch: {upload}"
        )

    # DLL side: per-file monotonic progress ending at 100, transfer-done done.
    percents_by_file = {}
    finished = None
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and finished is None:
        for event in drain_events():
            if event["event"] == "transfer-progress":
                percents_by_file.setdefault(event["data"]["fileId"], []).append(
                    event["data"]["percent"]
                )
            elif (
                event["event"] == "transfer-done"
                and event["data"]["sessionId"] == session_id
            ):
                finished = event["data"]
        if finished is None:
            time.sleep(0.05)
    assert finished and finished["status"] == "done", f"no transfer-done: {finished}"
    assert percents_by_file, "no transfer-progress events drained"
    for file_id, percents in percents_by_file.items():
        assert all(b >= a for a, b in zip(percents, percents[1:])), (
            f"non-monotonic percent for {file_id}: {percents}"
        )
        assert percents[-1] == 100, f"final percent for {file_id}: {percents[-1]}"

    record = find_record(session_id)
    assert record["status"] == "Done", f"record status: {record['status']}"
    assert record["direction"] == "Send", f"record direction: {record['direction']}"
    assert {f["fileName"] for f in record["files"]} == {"send-8mb.bin", "中文发送.txt"}
    assert all(f["sha256"] for f in record["files"]), "checksums must be recorded"

    # Cancel test: a throttled receiver keeps the upload in flight long enough
    # for session_cancel to abort it (8 MB at --slow-ms 60 ≈ 8s).
    slow = MockPeer(
        [
            "serve",
            "--alias",
            "SlowTarget",
            "--dir",
            str(CTX["work"] / "mock-slow"),
            "--slow-ms",
            "60",
        ]
    )
    slow_listening = slow.wait_event("listening", timeout=15)
    assert slow_listening, f"slow mock never listened: {slow.diagnostics()}"
    payload = make_random_file(CTX["src"], "cancel-slow.bin", 8 * MB)
    result2 = ok_data(
        "send_files",
        {
            "ip": "127.0.0.1",
            "port": slow_listening["port"],
            "files": [{"path": str(payload)}],
        },
    )
    session2 = result2["sessionId"]
    prepared = slow.wait_event("prepare", lambda e: e.get("status") == 200, timeout=30)
    assert prepared, f"slow mock never accepted the prepare: {slow.diagnostics()}"
    # Let a few hundred KB flow before cancelling.
    deadline = time.monotonic() + 15
    flowing = False
    while time.monotonic() < deadline and not flowing:
        for event in drain_events():
            if (
                event["event"] == "transfer-progress"
                and event["data"]["sessionId"] == session2
            ):
                flowing = True
        time.sleep(0.05)
    assert flowing, "no progress before the cancel (upload never started)"

    ok_data("session_cancel", {"sessionId": session2})
    cancel_seen = slow.wait_event("cancel", timeout=15)
    assert cancel_seen, (
        f"mock must see POST /cancel: {slow.diagnostics()}"
    )
    cancelled = wait_dll_event(
        "transfer-done",
        lambda d: d["sessionId"] == session2 and d["status"] == "cancelled",
        timeout=15,
    )
    assert cancelled, "DLL must report the cancelled send"
    record2 = find_record(session2)
    assert record2["status"] == "Cancelled", f"record2 status: {record2['status']}"
    drain_events()
    return "8MB + 中文发送.txt uploaded byte-exact; slow send cancelled at both ends"


@register_scenario
@scenario
def send_text():
    """DLL send_text -> mock serve: message.txt arrives with the exact utf8
    bytes; the DLL record is Done."""
    drain_events()
    mock = MockPeer(
        ["serve", "--alias", "TextTarget", "--dir", str(CTX["work"] / "mock-text")]
    )
    listening = mock.wait_event("listening", timeout=15)
    assert listening, f"mock never listened: {mock.diagnostics()}"

    text = "你好，LocalSend"
    result = ok_data(
        "send_text", {"ip": "127.0.0.1", "port": listening["port"], "text": text}
    )
    session_id = result["sessionId"]

    done = mock.wait_event("done", lambda e: e.get("status") == "done", timeout=60)
    assert done, f"mock never saw the message: {mock.diagnostics()}"
    uploads = mock.of_type("uploaded")
    assert len(uploads) == 1, f"exactly one virtual file expected: {uploads}"
    upload = uploads[0]
    assert upload["fileName"] == "message.txt", f"unexpected wire name: {upload}"
    expected = text.encode("utf-8")
    assert upload["bytes"] == len(expected), f"byte length mismatch: {upload}"
    content = Path(upload["path"]).read_bytes()
    assert content == expected, "message.txt bytes must match the text exactly"

    wait_dll_event(
        "transfer-done",
        lambda d: d["sessionId"] == session_id and d["status"] == "done",
        timeout=15,
    )
    record = find_record(session_id)
    assert record["status"] == "Done", f"record status: {record['status']}"
    assert record["direction"] == "Send"
    assert record["files"][0]["fileName"] == "message.txt"
    assert record["files"][0]["fileType"] == "text/plain"
    drain_events()
    return "message.txt received with exact utf8 bytes, record Done"


if __name__ == "__main__":
    main()
