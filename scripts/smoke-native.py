"""Minimal FFI smoke driver for the plugin DLL.

Helpers (load_dll, invoke, drain_events) are reused by the later interop
scripts; the run itself always points OTOOLS_DATA_DIR at an isolated temp
directory so the real ~/.otools is never touched.
"""

import argparse
import ctypes
import json
import os
import tempfile
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

        assert invoke("__otools_shutdown__")["ok"] is True
        retired = invoke("settings_get")
        assert retired["ok"] is False and retired.get("error") == "plugin retired", f"expected retired: {retired}"
        assert invoke("poll_events")["ok"] is True, "poll_events must stay answerable after retirement"
        print("PASS: shutdown retires the plugin while poll_events remains available")


if __name__ == "__main__":
    main()
