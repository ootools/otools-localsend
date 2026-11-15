#!/usr/bin/env python3
"""Independent loopback DLL wire regression; run with python -I.

No phone/installed-host access, native DTO imports, or mock-peer reuse. Literals
follow LocalSend protocol v2.2 register/prepare/upload. The approved design
separately identifies official 1.17 (no client certificate required) and 1.18.2
(default client certificate required); neither app is launched here. Node TLS
requests certificates but enforces presence + SHA256 DER in HTTP handlers; this
complements (does not replace) the native mandatory-handshake fixture.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
API = "/api/localsend/v2"
PIN = "fixture-url-pin-not-a-secret"
SENSITIVE = (PIN, "fixture-upload-token-not-a-secret", "fixture-body-pin-not-a-secret",
             "fixture-body-token-not-a-secret")
CONTENT = b"Independent LocalSend wire fixture\n" + b"0123456789abcdef\n" * 2048
FILE_NAME = "official-wire.txt"


def safe_error(error):
    text = str(error)
    for marker in SENSITIVE:
        text = text.replace(marker, "[fixture value redacted]")
    return text


def service_port():
    start = 20000 + int.from_bytes(os.urandom(2), "big") % 24000
    for offset in range(256):
        port = 20000 + (start - 20000 + offset) % 24000
        try:
            with socket.socket() as tcp, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                tcp.bind(("127.0.0.1", port))
                udp.bind(("127.0.0.1", port))
                return port
        except OSError:
            pass
    raise RuntimeError("No idle loopback TCP/UDP service port")


def request(port, method, path, body=b"", protocol="https", content_type="application/json"):
    options = {"timeout": 12, "source_address": ("127.0.0.1", 0)}
    if protocol == "https":
        # Fresh fixture certificates only; do not load system/user CA material.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        connection = http.client.HTTPSConnection("127.0.0.1", port, context=context, **options)
    else:
        assert protocol == "http"
        connection = http.client.HTTPConnection("127.0.0.1", port, **options)
    try:
        connection.connect()
        assert connection.sock.getsockname()[0] == "127.0.0.1", "Non-loopback source"
        assert connection.sock.getpeername()[0] == "127.0.0.1", "Non-loopback destination"
        connection.request(method, path, body=body, headers={"Content-Type": content_type})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


class Peer:
    """One bounded Node listener, with process cleanup even after a failed case."""
    def __init__(self, run, mode):
        directory = run.directory / ("peer-" + mode)
        directory.mkdir()
        config = directory / "config.json"
        config.write_text(json.dumps({"mode": mode, "clientFingerprint": run.fingerprint,
                                     "fileName": FILE_NAME, "size": len(CONTENT),
                                     "sha256": hashlib.sha256(CONTENT).hexdigest(), "pin": PIN}), encoding="utf-8")
        self.messages, self.queue = [], queue.Queue()
        environment = os.environ.copy()
        environment.pop("NODE_OPTIONS", None)
        self.process = subprocess.Popen(["node", str(ROOT / "scripts" / "official-wire-peer.mjs"), str(config)],
                                        cwd=ROOT, env=environment, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, encoding="utf-8")
        self.reader = threading.Thread(target=self.read, name="official-wire-peer-output")
        self.reader.start()
        try:
            self.ready = self.event("ready", timeout=15)
        except BaseException:
            self.close()
            raise

    def read(self):
        for line in self.process.stdout:
            try:
                self.queue.put(json.loads(line))
            except json.JSONDecodeError:
                self.queue.put({"kind": "fixture-error", "message": "Non-JSON peer diagnostic"})
        self.queue.put(None)

    def event(self, kind, timeout=8):
        deadline = time.monotonic() + timeout
        while True:
            for message in self.messages:
                if message.get("kind") == "fixture-error":
                    raise AssertionError("Independent peer rejected the wire request: " + message["message"])
                if message.get("kind") == kind:
                    return message
            remaining = deadline - time.monotonic()
            assert remaining > 0, "Independent peer did not observe " + kind
            try:
                message = self.queue.get(timeout=remaining)
            except queue.Empty:
                raise AssertionError("Independent peer did not observe " + kind) from None
            assert message is not None, "Independent peer exited before " + kind
            self.messages.append(message)

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.reader.join(timeout=3)
        self.process.stdout.close()
        assert not self.reader.is_alive(), "Peer output reader did not stop"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class WireRun:
    def __init__(self, directory, ffi):
        self.directory, self.ffi = directory, ffi
        self.raw, self.packets, self.requests = [], [], []
        self.data = directory / "data"
        self.downloads = directory / "downloads"
        self.data.mkdir()
        self.downloads.mkdir()
        self.file = directory / FILE_NAME
        self.file.write_bytes(CONTENT)

    def call(self, method, payload=None):
        result = self.ffi.invoke(method, payload)
        assert result.get("ok") is True, method + " rejected the fixture invocation"
        return result["data"]

    def poll(self):
        # Raw invoke ONLY: never smoke-native drain_events/frontend normalize.
        response = self.ffi.invoke("poll_events")
        assert response.get("ok") is True, "Raw poll_events failed"
        data = response.get("data")
        events = data.get("events") if isinstance(data, dict) else data
        assert isinstance(events, list), "Raw event list missing"
        self.raw.extend(events)
        for event in events:
            if not isinstance(event, dict):
                continue
            # Exact listen.rs semantics: topic (or event only if absent), but
            # payload ONLY. Re-serialize the host's emitted bridge packet.
            topic = event.get("topic") if "topic" in event else event.get("event")
            if isinstance(topic, str) and topic.strip():
                packet = {"topic": topic.strip(), "payload": event.get("payload")}
                self.packets.append(json.loads(json.dumps(packet)))
        return events

    def raw_gate(self, start):
        for event in self.raw[start:]:
            assert isinstance(event, dict) and set(event) == {"topic", "payload"}, (
                "Raw DLL events are not canonical {topic,payload}; host payload-only parser loses data")
            assert isinstance(event["topic"], str) and event["topic"].strip(), "Empty raw topic"
            assert event["payload"] is not None, "Host would emit a null bridge payload"
            assert {"topic": event["topic"].strip(), "payload": event["payload"]} in self.packets, (
                "Raw event contents did not survive the emitted host bridge packet")

    def record(self, session):
        return next((r for r in self.call("transfer_list")["transfers"] if r["sessionId"] == session), None)

    def terminal(self, session):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.poll()
            record = self.record(session)
            if record and record["status"] in ("Done", "Failed", "Cancelled"):
                return record
            time.sleep(0.04)
        raise AssertionError("DLL transfer never became terminal")

    def event(self, topic, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.poll()
            for packet in self.packets:
                if packet["topic"] == topic and isinstance(packet["payload"], dict) and predicate(packet["payload"]):
                    return packet["payload"]
            time.sleep(0.04)
        raise AssertionError("Host payload-only bridge did not deliver " + topic)

    def done(self, session, expected="Done"):
        record = self.terminal(session)
        assert record["status"] == expected, "DLL transfer status " + record["status"] + ", expected " + expected
        assert record.get("stage") == "finished", "Terminal DLL record stage was not finished"
        packet = self.event("transfer-done", lambda p: p.get("sessionId") == session)
        assert packet.get("status") == expected.lower(), "Bridge lost terminal transfer status"
        assert packet.get("stage") == "finished", "Bridge lost finished stage"
        assert packet.get("error") == record.get("error"), "Bridge lost saved failure detail"
        # The host drained first. A subsequent frontend fallback cannot recover
        # this critical event; it must already have survived the emitted packet.
        next_drain = self.poll()
        self.raw_gate(0)
        assert sum(p["topic"] == "transfer-done" and isinstance(p["payload"], dict)
                   and p["payload"].get("sessionId") == session for p in self.packets) == 1, "Terminal event was emitted twice"
        assert not any(e.get("topic") == "transfer-done" and e.get("payload", {}).get("sessionId") == session
                       for e in next_drain), "Terminal event was not drained"
        return record

    def send(self, peer):
        return self.call("send_files", {"ip": "127.0.0.1", "port": peer.ready["port"],
                                       "protocol": peer.ready["protocol"], "pin": PIN,
                                       "files": [{"path": str(self.file)}]})["sessionId"]

    def prepare(self, files):
        body = {"info": {"alias": "Literal inbound peer", "version": "2.2", "fingerprint": "d" * 64,
                         "port": 53317, "protocol": "https"}, "files": files}
        result = queue.Queue()
        def worker():
            try:
                result.put(request(self.port, "POST", API + "/prepare-upload", json.dumps(body).encode()))
            except Exception as error:
                result.put(error)
        thread = threading.Thread(target=worker, name="official-wire-held-prepare")
        self.requests.append(thread)
        thread.start()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            self.poll()
            if not result.empty():
                early = result.get_nowait()
                if isinstance(early, Exception):
                    raise AssertionError("Literal HTTPS prepare failed: " + type(early).__name__)
                raise AssertionError("Literal optional fields rejected before manual accept: HTTP " + str(early[0]))
            for packet in self.packets:
                payload = packet["payload"]
                if packet["topic"] == "incoming-request" and isinstance(payload, dict):
                    if {f["id"] for f in payload.get("files", [])} == set(files):
                        assert payload["sender"]["alias"] == "Literal inbound peer"
                        assert payload["sender"]["download"] is False, "Omitted download did not default false"
                        session = payload["sessionId"]
                        record = self.record(session)
                        assert record["status"] == "Pending" and record.get("stage") == "waiting"
                        time.sleep(0.1)
                        assert result.empty(), "Prepare answered without manual confirmation"
                        return session, result
            time.sleep(0.04)
        raise AssertionError("Canonical incoming-request missing for literal prepare")

    def accepted_response(self, result, expected):
        value = result.get(timeout=8)
        assert not isinstance(value, Exception), "Held HTTPS prepare connection failed"
        status, body = value
        assert status == expected, "Prepare returned HTTP " + str(status) + ", expected " + str(expected)
        return json.loads(body) if body else None


def http_send(run):
    with Peer(run, "http") as peer:
        status, body = request(peer.ready["port"], "GET", API + "/info", protocol="http")
        assert status == 200 and set(json.loads(body)) == {"alias", "version", "fingerprint"}
        session = run.send(peer)
        record = run.done(session)
        assert not record.get("error"), "Successful HTTP send saved an error"
        upload = peer.event("upload")
        assert upload["status"] == 200 and upload["size"] == len(CONTENT)
        assert upload["sha256"] == hashlib.sha256(CONTENT).hexdigest()
        progress = run.event("transfer-progress", lambda p: p.get("sessionId") == session and p.get("percent") == 100)
        assert progress["fileId"] == upload["id"], "Bridge lost final file progress"
        # Unicast announcement solely to our fresh DLL UDP endpoint. Identity,
        # source IP, and exact contacted port prevent installed-host alias mixups.
        announcement = {"alias": "Before register response", "version": "2.2", "fingerprint": peer.ready["fingerprint"],
                        "port": peer.ready["port"], "protocol": "http", "download": False, "announce": True}
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            udp.bind(("127.0.0.1", 0))
            udp.sendto(json.dumps(announcement).encode() + b"\n", ("127.0.0.1", run.udp_port))
        peer.event("register")
        deadline = time.monotonic() + 4
        matched = None
        while time.monotonic() < deadline:
            matched = next((d for d in run.call("device_list")["devices"]
                            if d["ip"] == "127.0.0.1" and d["info"]["fingerprint"] == peer.ready["fingerprint"]
                            and d["info"]["port"] == peer.ready["port"]
                            and d["info"]["alias"] == peer.ready["info"]["alias"]), None)
            if matched:
                break
            time.sleep(0.04)
        assert matched, "DLL did not decode minimal register response without port/protocol/download"
        assert matched["info"]["protocol"] == "http" and matched["info"]["download"] is False
    return "HTTP prepare/token/upload byte size+SHA256, minimal register retains contacted endpoint, Done/finished"


def tls_identity(run):
    with Peer(run, "tls-identity") as peer:
        status, _ = request(peer.ready["port"], "POST", API + "/prepare-upload", b"{}")
        assert status == 403, "No-client-certificate control bypassed TLS fixture policy"
        assert peer.event("client-rejected")["certificatePresent"] is False
        run.done(run.send(peer))
        prepare, upload = peer.event("prepare"), peer.event("upload")
        assert prepare["clientFingerprint"] == upload["clientFingerprint"] == run.fingerprint
        assert prepare["infoFingerprint"] == run.fingerprint and upload["status"] == 200
        assert upload["size"] == len(CONTENT) and upload["sha256"] == hashlib.sha256(CONTENT).hexdigest()
    return "HTTPS client SHA256 DER matches DLL server_status; no-cert control HTTP 403; full file uploaded"


def inbound(run):
    text = b"Independent inbound text\n"
    image = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                          "0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082")
    contents = {"literal-text": text, "literal-image": image}
    files = {"literal-text": {"id": "literal-text", "fileName": "inbound.txt", "size": len(text), "fileType": "text/plain"},
             "literal-image": {"id": "literal-image", "fileName": "inbound.png", "size": len(image), "fileType": "image/png"}}
    session, held = run.prepare(files)  # download/sha256/metadata/preview absent on wire.
    incoming = run.event("incoming-request", lambda p: p.get("sessionId") == session)
    assert {(f["id"], f["fileName"], f["size"], f["fileType"]) for f in incoming["files"]} == {
        ("literal-text", "inbound.txt", len(text), "text/plain"), ("literal-image", "inbound.png", len(image), "image/png")}
    assert not any(e.get("topic") == "incoming-request" and e.get("payload", {}).get("sessionId") == session
                   for e in run.poll()), "Host did not drain incoming-request before frontend fallback"
    assert run.call("session_accept", {"sessionId": session})["accepted"] == sorted(files)
    response = run.accepted_response(held, 200)
    assert response["sessionId"] == session and set(response["files"]) == set(files)
    from urllib.parse import urlencode
    for file_id, content in contents.items():
        token = response["files"][file_id]
        assert isinstance(token, str) and token
        status, _ = request(run.port, "POST", API + "/upload?" + urlencode(
            {"sessionId": session, "fileId": file_id, "token": token}), content, content_type="application/octet-stream")
        assert status == 200, "Literal inbound upload failed: HTTP " + str(status)
    record = run.done(session)
    for file_id, content in contents.items():
        expected = run.downloads / files[file_id]["fileName"]
        assert Path(record["destinations"][file_id]).resolve() == expected.resolve(), "Destination escaped fixture directory"
        assert expected.stat().st_size == len(content)
        assert hashlib.sha256(expected.read_bytes()).digest() == hashlib.sha256(content).digest()
    # 204 means explicitly accepting NO files, not falsely implementing an
    # official message accept-all. Preview remains a valid optional message field.
    preview = "Independent literal preview"
    message = {"literal-message": {"id": "literal-message", "fileName": "00000000-0000-4000-8000-000000000001.txt",
                                   "size": len(preview.encode()), "fileType": "text/plain", "preview": preview}}
    empty_session, empty_held = run.prepare(message)
    assert run.call("session_accept", {"sessionId": empty_session, "fileIds": []})["accepted"] == []
    assert run.accepted_response(empty_held, 204) is None
    empty_record = run.done(empty_session)
    assert not empty_record.get("destinations") and not (run.downloads / message["literal-message"]["fileName"]).exists()
    return "HTTPS literal optional fields, raw incoming bridge, manual 200+uploads and explicit empty-accept 204; source 127.0.0.1"


def failures(run):
    for mode, status in (("prepare401", 401), ("upload403", 403)):
        with Peer(run, mode) as peer:
            session = run.send(peer)
            record = run.terminal(session)
            assert record["status"] == "Failed", "HTTP failure did not save Failed"
            error = record.get("error")
            assert isinstance(error, str) and "HTTP " + str(status) in error, "Saved failure lacks HTTP " + str(status)
            assert record.get("stage") == "finished", "Failed stage did not finish"
            assert all(marker not in error for marker in (*SENSITIVE, "http://", "https://", "?", "pin=", "token=")), (
                "Saved failure leaked body/query/fixture secret")
            done = run.done(session, "Failed")
            assert done["error"] == error
            peer.event("prepare" if status == 401 else "upload")
            saved = json.loads((run.data / "transfers.json").read_text(encoding="utf-8"))
            persisted = next(r for r in saved["transfers"] if r["sessionId"] == session)
            assert persisted["error"] == error and persisted["stage"] == "finished"
            assert all(marker not in json.dumps(saved) for marker in SENSITIVE), "Persisted history leaked a fixture secret"
    return "Prepare HTTP 401 / upload HTTP 403 save only status diagnostics; Failed/finished raw transfer-done, no body/query"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default = "Windows.dll" if sys.platform == "win32" else "macOS.dylib" if sys.platform == "darwin" else "Linux.so"
    parser.add_argument("--library", type=Path, default=ROOT / "lib" / default)
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("Run this private fixture with python -I")
    if shutil.which("node") is None:
        print("SKIP: Node unavailable; 0/4 DLL wire scenarios executed (no dependencies installed)")
        return 77
    library = args.library.resolve(strict=True)
    module = importlib.util.spec_from_file_location("official_wire_ffi", ROOT / "scripts" / "smoke-native.py")
    ffi = importlib.util.module_from_spec(module)
    module.loader.exec_module(ffi)  # Safe existing load_dll/invoke only.
    print("DLL SHA256 " + hashlib.sha256(library.read_bytes()).hexdigest())
    failed = 0
    previous_data = os.environ.get("OTOOLS_DATA_DIR")
    with tempfile.TemporaryDirectory(prefix="otools-official-wire-") as directory:
        run = WireRun(Path(directory), ffi)
        os.environ["OTOOLS_DATA_DIR"] = str(run.data)
        (run.data / "settings.json").write_text(json.dumps({
            "alias": "Official DLL loopback fixture", "deviceModel": "Private wire test", "deviceType": "desktop",
            "port": service_port(), "downloadDir": str(run.downloads), "pin": None, "autoSave": False,
            "notifyOnIncoming": True}), encoding="utf-8")
        loaded = False
        try:
            ffi.load_dll(library)
            loaded = True
            run.call("start_localsend")
            deadline = time.monotonic() + 8
            status = run.call("server_status")
            while status["state"] == "starting" and time.monotonic() < deadline:
                time.sleep(0.04)
                status = run.call("server_status")
            assert status["state"] == "running", "Fresh DLL service failed to start"
            run.port, run.udp_port, run.fingerprint = status["port"], status["udpPort"], status["fingerprint"]
            assert len(run.fingerprint) == 64 and run.port > 0 and run.udp_port > 0
            scenarios = (http_send, tls_identity, inbound, failures)
            for number, scenario in enumerate(scenarios, 1):
                start, issues, detail = len(run.raw), [], ""
                try:
                    detail = scenario(run)
                except Exception as error:
                    issues.append(safe_error(error))
                try:
                    run.poll()
                    run.raw_gate(start)
                except Exception as error:
                    issues.append(safe_error(error))
                if issues:
                    failed += 1
                    print(f"FAIL {number}/4 {scenario.__name__}: " + "; ".join(issues))
                    run.call("stop_localsend", {"force": True})
                    deadline = time.monotonic() + 15
                    while run.call("server_status")["state"] != "stopped" and time.monotonic() < deadline:
                        time.sleep(0.04)
                    run.call("start_localsend")
                    deadline = time.monotonic() + 8
                    while run.call("server_status")["state"] == "starting" and time.monotonic() < deadline:
                        time.sleep(0.04)
                    status = run.call("server_status")
                    assert status["state"] == "running", "DLL recovery failed"
                    run.port, run.udp_port = status["port"], status["udpPort"]
                else:
                    print(f"PASS {number}/4 {scenario.__name__}: " + detail)
        finally:
            try:
                if loaded:
                    run.call("stop_localsend", {"force": True})
                    deadline = time.monotonic() + 15
                    while run.call("server_status")["state"] != "stopped" and time.monotonic() < deadline:
                        time.sleep(0.04)
                    assert run.call("server_status")["state"] == "stopped", "Fixture service did not stop"
            finally:
                try:
                    if loaded:
                        run.call("__otools_shutdown__")
                finally:
                    try:
                        for thread in run.requests:
                            thread.join(timeout=15)
                        assert not any(t.is_alive() for t in run.requests), "Held prepare worker did not stop"
                    finally:
                        if previous_data is None:
                            os.environ.pop("OTOOLS_DATA_DIR", None)
                        else:
                            os.environ["OTOOLS_DATA_DIR"] = previous_data
    print(f"SUMMARY: {4 - failed} PASS, {failed} FAIL, 0 SKIP; loopback DLL wire only, no official phone test")
    print("TLS scope: Node optional handshake + enforced HTTP client DER identity; strict mandatory handshake is native-fixture coverage.")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        if os.environ.get("OTOOLS_OFFICIAL_WIRE_WORKER") == "1":
            sys.exit(main())
        # Older DLLs write full query strings straight to Rust stderr. Capture
        # the private worker in memory and redact BEFORE any native diagnostic
        # reaches a terminal/CI log; never write certificate/body contents out.
        environment = os.environ.copy()
        environment["OTOOLS_OFFICIAL_WIRE_WORKER"] = "1"
        child = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), *sys.argv[1:]],
                                 cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding="utf-8")
        try:
            output, _ = child.communicate()
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        print(safe_error(output), end="")
        sys.exit(child.returncode)
    except Exception as error:
        print("FAIL fixture setup/cleanup: " + safe_error(error))
        sys.exit(1)
