"""Minimal FFI smoke driver for the plugin DLL.

Helpers (load_dll, invoke, drain_events) are reused by the later interop
scripts; the run itself always points OTOOLS_DATA_DIR at an isolated temp
directory so the real ~/.otools is never touched.
"""

import argparse
import ctypes
import json
import os
import socket
import tempfile
import time
from pathlib import Path

_NATIVE = None


def load_dll(path):
    """Load the plugin library and configure the FFI signatures."""
    global _NATIVE
    native = ctypes.CDLL(str(path))
    native.otools_plugin_invoke.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    native.otools_plugin_invoke.restype = ctypes.c_void_p
    native.otools_plugin_free.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    native.otools_plugin_free.restype = None
    _NATIVE = native
    return native


def invoke(method, payload=None):
    """Send {method, payload} over the FFI and return the raw {ok, data|error} envelope."""
    encoded = json.dumps({"method": method, "payload": payload or {}}).encode()
    buffer = ctypes.create_string_buffer(encoded)
    size = ctypes.c_size_t()
    ptr = _NATIVE.otools_plugin_invoke(buffer, len(encoded), ctypes.byref(size))
    assert ptr, f"{method}: null FFI response"
    try:
        return json.loads(ctypes.string_at(ptr, size.value))
    finally:
        _NATIVE.otools_plugin_free(ptr, size.value)


def drain_events():
    """Poll the plugin event queue and return the drained event list."""
    result = invoke("poll_events")
    assert result.get("ok") is True, f"poll_events: {result.get('error')}"
    return result["data"]["events"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--library", type=Path, default=Path(__file__).resolve().parents[1] / "lib" / "Windows.dll")
    args = parser.parse_args()
    library = args.library.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="otools-localsend-smoke-") as directory:
        os.environ["OTOOLS_DATA_DIR"] = directory
        load_dll(library)

        settings = invoke("settings_get")
        assert settings["ok"] is True, f"settings_get: {settings.get('error')}"
        assert settings["data"]["port"] == 53317, f"unexpected default port: {settings['data']['port']}"
        assert drain_events() == []
        unknown = invoke("nonexistent_method")
        assert unknown["ok"] is False, f"unknown method must fail: {unknown}"
        print("PASS: settings_get defaults, empty event drain, unknown method rejected")

        updated = invoke("settings_set", {"settings": {"alias": "Smoke设备", "port": 53318}})
        assert updated["ok"] is True, f"settings_set: {updated.get('error')}"
        reloaded = invoke("settings_get")
        assert reloaded["data"]["alias"] == "Smoke设备", f"alias lost: {reloaded['data']}"
        assert reloaded["data"]["port"] == 53318, f"port not persisted: {reloaded['data']}"
        assert (Path(directory) / "settings.json").is_file(), "settings.json not written to the isolated data dir"
        print("PASS: settings_set persists into the isolated data directory")

        # Task 6: discovery surface. No real network peers are required.
        # Before start_background the table is empty, no socket is bound, and
        # discover_now is a no-op that still answers ok.
        pre_devices = invoke("device_list")
        assert pre_devices["ok"] is True, f"device_list before start: {pre_devices.get('error')}"
        assert pre_devices["data"]["devices"] == [], f"unexpected devices before start: {pre_devices['data']}"
        assert pre_devices["data"]["udpPort"] == 0, f"udpPort must be 0 before start: {pre_devices['data']}"
        pre_now = invoke("discover_now")
        assert pre_now["ok"] is True and pre_now["data"]["ok"] is True, f"discover_now before start: {pre_now}"
        print("PASS: device_list empty (udpPort 0) and discover_now ok before start_background")

        pre_status = invoke("server_status")
        assert pre_status["ok"] is True and pre_status["data"].get("state") == "stopped", pre_status
        assert pre_status["data"]["port"] == 0 and pre_status["data"]["udpPort"] == 0, pre_status
        assert isinstance(pre_status["data"]["revision"], int), pre_status
        print("PASS: service state before autostart is explicitly stopped, not indefinitely starting")
        started = invoke("start_localsend")
        assert started["ok"] is True, f"start_localsend: {started.get('error')}"
        assert started["data"]["status"]["state"] in ("starting", "running"), started

        # The discovery task binds asynchronously; poll for the actual port.
        # Settings above switched the port to 53318, so discovery binds there
        # first and may fall back up to +10 on a busy machine.
        devices = invoke("device_list")
        assert devices["ok"] is True, f"device_list after start: {devices.get('error')}"
        assert isinstance(devices["data"]["devices"], list), "devices must be a list"
        udp_port = devices["data"]["udpPort"]
        deadline = time.monotonic() + 5
        while udp_port == 0 and time.monotonic() < deadline:
            time.sleep(0.1)
            devices = invoke("device_list")
            udp_port = devices["data"]["udpPort"]
        assert 53318 <= udp_port <= 53328, f"udpPort outside the fallback range: {udp_port}"
        now = invoke("discover_now")
        assert now["ok"] is True and now["data"]["ok"] is True, f"discover_now after start: {now}"
        print(f"PASS: start_localsend binds discovery on UDP {udp_port}, device_list/discover_now ok")

        # Task 7: HTTPS v2 server. The server binds TCP independently of the
        # UDP discovery socket (own fallback window); poll server_status for
        # the actual port.
        status = invoke("server_status")
        assert status["ok"] is True, f"server_status: {status.get('error')}"
        assert status["data"]["protocol"] == "https", f"unexpected protocol: {status['data']}"
        deadline = time.monotonic() + 5
        while status["data"]["port"] == 0 and time.monotonic() < deadline:
            time.sleep(0.1)
            status = invoke("server_status")
        https_port = status["data"]["port"]
        assert 53318 <= https_port <= 53328, f"https port outside the fallback range: {https_port}"
        assert status["data"]["state"] == "running", status
        assert status["data"]["udpPort"] == udp_port, status
        assert status["data"]["activeTransfers"] == 0, status
        assert isinstance(status["data"]["revision"], int), status
        fingerprint = status["data"]["fingerprint"]
        assert isinstance(fingerprint, str) and len(fingerprint) == 64, f"fingerprint: {fingerprint}"
        assert status["data"]["error"] is None, f"unexpected bind error: {status['data']}"
        print(f"PASS: server_status records the actual HTTPS port TCP {https_port} with fingerprint")

        events = drain_events()
        status_events = [e for e in events if e["event"] == "server-status" and "port" in e["data"]]
        assert status_events, f"server-status event missing after start: {events}"
        latest = status_events[-1]["data"]
        assert latest["port"] == https_port, f"event port mismatch: {latest}"
        assert latest["protocol"] == "https", f"event protocol: {latest}"
        assert latest["fingerprint"] == fingerprint, f"event fingerprint mismatch: {latest}"
        assert latest["state"] == "running" and latest["udpPort"] == udp_port, latest
        assert isinstance(latest["revision"], int) and latest["activeTransfers"] == 0, latest
        print("PASS: server-status event carries the actual ports, lifecycle, revision and fingerprint")

        transfers = invoke("transfer_list")
        assert transfers["ok"] is True, f"transfer_list: {transfers.get('error')}"
        assert transfers["data"]["transfers"] == [], f"unexpected history: {transfers['data']}"
        for method in ("session_accept", "session_decline", "session_cancel"):
            bogus = invoke(method, {"sessionId": "bogus"})
            assert bogus["ok"] is False, f"{method} with a bogus id must fail: {bogus}"
            assert "session not found" in bogus.get("error", ""), f"unexpected error: {bogus}"
        print("PASS: transfer_list ok and bogus session ids rejected on all session endpoints")

        # Ordinary stop is restartable and never retires the plugin library.
        cert_bytes = (Path(directory) / "cert.pem").read_bytes()
        key_bytes = (Path(directory) / "key.pem").read_bytes()
        stop = invoke("stop_localsend")
        assert stop["ok"] is True, f"manual stop unavailable: {stop}"
        assert stop["data"]["confirmationRequired"] is False, stop
        deadline = time.monotonic() + 15
        stopped = invoke("server_status")
        while stopped["data"].get("state") != "stopped" and time.monotonic() < deadline:
            time.sleep(0.05)
            stopped = invoke("server_status")
        assert stopped["data"]["state"] == "stopped", f"stop never completed: {stopped}"
        assert stopped["data"]["port"] == 0 and stopped["data"]["udpPort"] == 0, stopped
        assert invoke("settings_get")["data"]["alias"] == "Smoke设备"
        assert (Path(directory) / "cert.pem").read_bytes() == cert_bytes
        assert (Path(directory) / "key.pem").read_bytes() == key_bytes
        repeated_stop = invoke("stop_localsend")
        assert repeated_stop["ok"] is True and repeated_stop["data"]["status"]["state"] == "stopped", repeated_stop
        devices_after_stop = invoke("device_list")
        assert devices_after_stop["data"] == {"devices": [], "udpPort": 0}, devices_after_stop
        print("PASS: ordinary stop is idempotent, releases live state and preserves settings/certificate")

        # A private endpoint avoids mistaking another same-host LocalSend
        # socket for our own when asserting actual port release.
        private_port = None
        for _ in range(20):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp_probe:
                tcp_probe.bind(("0.0.0.0", 0))
                candidate = tcp_probe.getsockname()[1]
                if candidate > 65525:
                    continue
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp_probe:
                    try:
                        udp_probe.bind(("0.0.0.0", candidate))
                    except OSError:
                        continue
                    private_port = candidate
                    break
        assert private_port is not None, "no idle TCP/UDP endpoint for restart smoke"
        changed = invoke("settings_get")["data"]
        changed["port"] = private_port
        assert invoke("settings_set", {"settings": changed})["ok"] is True
        restarted = invoke("start_localsend")
        assert restarted["ok"] is True and restarted["data"]["started"] is True, restarted
        deadline = time.monotonic() + 5
        running = invoke("server_status")
        while running["data"].get("state") != "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            running = invoke("server_status")
        assert running["data"]["state"] == "running", f"restart failed: {running}"
        assert running["data"]["port"] == private_port, f"saved port not applied: {running}"
        assert running["data"]["fingerprint"] == fingerprint
        assert running["data"]["revision"] > stopped["data"]["revision"], "restart reset status revision"
        assert invoke("stop_localsend")["ok"] is True
        deadline = time.monotonic() + 15
        final_stop = invoke("server_status")
        while final_stop["data"].get("state") != "stopped" and time.monotonic() < deadline:
            time.sleep(0.05)
            final_stop = invoke("server_status")
        assert final_stop["data"]["state"] == "stopped", final_stop
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp_probe:
            tcp_probe.bind(("0.0.0.0", private_port))
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp_probe:
            udp_probe.bind(("0.0.0.0", private_port))
        print("PASS: same-library restart applies saved port, retains fingerprint and releases TCP/UDP sockets")

        assert invoke("__otools_shutdown__")["ok"] is True
        retired = invoke("settings_get")
        assert retired["ok"] is False and retired.get("error") == "plugin retired", f"expected retired: {retired}"
        retired_poll = invoke("poll_events")
        assert retired_poll["ok"] is True, "poll_events must stay answerable after retirement"
        assert retired_poll["data"]["events"] == [], f"retired poll_events must drain empty: {retired_poll}"
        print("PASS: shutdown retires the plugin while poll_events remains available")


if __name__ == "__main__":
    main()
