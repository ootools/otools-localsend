#!/usr/bin/env python3
"""Isolated local-image/receive-save tests against the real plugin ABI.

Run with python -I. Only generated fixtures and loopback peers are used; this
never invokes the installed host, its clipboard, user files or public peers.
"""
import argparse
import base64
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import ssl
import struct
import tempfile
import threading
import time
from urllib.parse import urlencode
import zlib

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("content_smoke", ROOT / "scripts" / "smoke-native.py")
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)
API = "/api/localsend/v2"


def data(method, payload=None):
    result = smoke.invoke(method, payload)
    assert result.get("ok") is True, f"{method}: {result.get('error')}"
    return result["data"]


def wait_for(predicate, description, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting for {description}")


def png(width, height):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)
    rows = b"".join(b"\0" + bytes([60, 140, 205]) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def dimensions(body):
    assert body[:8] == b"\x89PNG\r\n\x1a\n", "not an encoded PNG"
    return struct.unpack(">II", body[16:24])


def request(port, path, body):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    connection = http.client.HTTPSConnection("127.0.0.1", port, context=context, timeout=15)
    try:
        connection.connect()
        assert connection.sock.getpeername()[0] == "127.0.0.1"
        connection.request("POST", path, body=body, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def receive_image(port, picture, target, expected_existing):
    offer = {
        "info": {"alias": "Image fixture", "version": "2.2", "fingerprint": "content-test-peer",
                 "port": 53317, "protocol": "https"},
        "files": {"photo": {"id": "photo", "fileName": "photo.png", "size": len(picture),
                              "fileType": "image/png", "sha256": hashlib.sha256(picture).hexdigest()}},
    }
    response = {}
    def prepare():
        try:
            response["value"] = request(port, API + "/prepare-upload", json.dumps(offer).encode())
        except BaseException as error:
            response["error"] = error
    thread = threading.Thread(target=prepare)
    thread.start()
    try:
        record = wait_for(lambda: next((record for record in data("transfer_list")["transfers"]
                          if record["direction"] == "Receive" and record["status"] == "Pending"), None), "incoming Pending")
        session = record["sessionId"]
        assert data("file_preview", {"sessionId": session, "fileId": "photo"})["status"] == "unavailable"
        assert not response, "preview resolved prepare without consent"
        bad = smoke.invoke("session_accept", {"sessionId": session, "fileIds": ["photo"], "destinations": {"other": str(target)}})
        assert bad.get("ok") is False, "save target outside accepted files was authorized"
        assert not response, "invalid target resolved prepare"
        data("session_accept", {"sessionId": session, "fileIds": ["photo"], "destinations": {"photo": str(target)}})
        thread.join(timeout=15)
        assert not thread.is_alive(), "prepare did not resolve after explicit accept"
        if "error" in response:
            raise response["error"]
        status, body = response["value"]
        assert status == 200, status
        accepted = json.loads(body)
        params = urlencode({"sessionId": accepted["sessionId"], "fileId": "photo", "token": accepted["files"]["photo"]})
        status, _ = request(port, API + "/upload?" + params, picture)
        assert status == 200, f"image upload returned {status}"
        final = wait_for(lambda: next((record for record in data("transfer_list")["transfers"]
                         if record["sessionId"] == session and record["status"] == "Done"), None), "saved image history")
        destination = Path(final["destinations"]["photo"])
        assert destination.parent == target.parent
        assert destination != target, "existing file was overwritten instead of choosing a new name"
        assert target.read_bytes() == expected_existing, "original file content changed"
        assert destination.read_bytes() == picture, "saved image bytes differ"
        preview = data("file_preview", {"sessionId": session, "fileId": "photo"})
        assert preview["status"] == "ready", preview
        assert (preview["width"], preview["height"]) == (640, 480)
        assert smoke.invoke("resolve_transfer_file", {"sessionId": session, "fileId": "other"}).get("ok") is False
        assert Path(data("resolve_transfer_file", {"sessionId": session, "fileId": "photo"})["path"]) == destination
        return destination
    finally:
        thread.join(timeout=16)
        assert not thread.is_alive(), "prepare fixture leaked a worker"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--library", type=Path, default=ROOT / "lib" / "Windows.dll")
    args = parser.parse_args()
    library = args.library.resolve(strict=True)
    previous_data = os.environ.get("OTOOLS_DATA_DIR")
    with tempfile.TemporaryDirectory(prefix="otools-file-content-") as directory:
        root = Path(directory).resolve()
        os.environ["OTOOLS_DATA_DIR"] = str(root / "data")
        smoke.load_dll(library)
        try:
            settings = data("settings_get")
            assert settings["downloadDir"] == "~/Download/OToolsLocalSend", settings["downloadDir"]
            settings.update(port=smoke.find_service_test_port(), downloadDir=str(root / "Download" / "OToolsLocalSend"), notifyOnIncoming=False)
            data("settings_set", {"settings": settings})
            assert not (root / "Download").exists(), "settings query created download directory"
            print("PASS: exact default and explicit isolated save directory")

            source = root / "fixture.png"
            picture = png(640, 480)
            source.write_bytes(picture)
            preview = data("file_preview", {"path": str(source)})
            assert preview["status"] == "ready", preview
            small = base64.b64decode(preview["dataUrl"].removeprefix("data:image/png;base64,"), validate=True)
            assert max(dimensions(small)) <= 384 and len(small) <= 512 * 1024
            assert (preview["width"], preview["height"]) == (640, 480)
            assert data("file_preview", {"path": "https://peer/not-an-image"})["status"] == "unavailable"
            print("PASS: real bounded PNG thumbnail and no remote preview URL")

            copied = data("prepare_image_copy", {"path": str(source)})
            copy_path = Path(copied["path"])
            assert copy_path.is_relative_to(root / "data"), "copy resource escaped isolated data root"
            assert dimensions(copy_path.read_bytes()) == (640, 480), "clipboard preparation copied the thumbnail"
            source.unlink()
            assert copy_path.exists(), "copy input was not stable after original removal"
            assert smoke.invoke("release_image_copy", {"resourceId": str(root / "user-file")}).get("ok") is False
            data("release_image_copy", {"resourceId": copied["resourceId"]})
            assert not copy_path.exists(), "generated copy resource was not released"
            print("PASS: full-resolution stable image-copy resource and opaque release")

            data("start_localsend")
            running = wait_for(lambda: (status if (status := data("server_status"))["state"] == "running" else None), "service running")
            save_dir = root / "selected"
            save_dir.mkdir()
            existing = save_dir / "saved-photo.png"
            existing.write_bytes(b"do not replace the preexisting file")
            saved = receive_image(running["port"], picture, existing, b"do not replace the preexisting file")
            print("PASS: manual-consent image save target, truthful history and no overwrite")
            data("stop_localsend", {"force": True})
            wait_for(lambda: data("server_status")["state"] == "stopped", "service stopped")
            assert saved.read_bytes() == picture
            assert data("file_preview", {"sessionId": data("transfer_list")["transfers"][0]["sessionId"], "fileId": "photo"})["status"] == "ready"
            print("PASS: image resources remain usable after ordinary service stop")
        finally:
            try:
                smoke.invoke("stop_localsend", {"force": True})
                smoke.invoke("__otools_shutdown__")
            finally:
                if previous_data is None:
                    os.environ.pop("OTOOLS_DATA_DIR", None)
                else:
                    os.environ["OTOOLS_DATA_DIR"] = previous_data


if __name__ == "__main__":
    main()
