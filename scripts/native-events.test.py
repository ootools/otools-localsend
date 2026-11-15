"""Canonical host event contract checks independent of native implementation."""
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("smoke_native", Path(__file__).with_name("smoke-native.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class NativeEventTests(unittest.TestCase):
    def test_raw_host_events_require_topic_and_payload(self):
        events = [
            {"topic": "incoming-request", "payload": {"sessionId": "receiver"}},
            {"topic": "transfer-done", "payload": {"sessionId": "sender", "status": "failed"}},
        ]
        with patch.object(smoke, "invoke", return_value={"ok": True, "data": {"events": events}}):
            self.assertEqual(smoke.drain_host_events(), events)
            self.assertEqual(smoke.drain_events(), [
                {"event": "incoming-request", "data": {"sessionId": "receiver"}},
                {"event": "transfer-done", "data": {"sessionId": "sender", "status": "failed"}},
            ])

    def test_legacy_data_only_queue_is_rejected_by_the_host_smoke_gate(self):
        with patch.object(smoke, "invoke", return_value={"ok": True, "data": {"events": [
            {"event": "incoming-request", "data": {"sessionId": "invisible"}},
        ]}}):
            with self.assertRaisesRegex(AssertionError, "host event envelope"):
                smoke.drain_host_events()

    def test_empty_queue_and_null_payload_keep_their_meaning(self):
        for events in [[], [{"topic": "optional", "payload": None}]]:
            with patch.object(smoke, "invoke", return_value={"ok": True, "data": {"events": events}}):
                self.assertEqual(smoke.drain_host_events(), events)


if __name__ == "__main__":
    unittest.main(verbosity=2)
