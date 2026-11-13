"""Regression tests for isolated service-test endpoint selection."""

import errno
import importlib.util
import socket
import unittest
from pathlib import Path
from unittest.mock import patch

_spec = importlib.util.spec_from_file_location("smoke_native", Path(__file__).with_name("smoke-native.py"))
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)


class ProbeSocket:
    def __init__(self, kind, attempts):
        self.kind = kind
        self.attempts = attempts
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.closed = True

    def bind(self, address):
        self.attempts.append((self.kind, address))
        port = address[1]
        if port == 21000:
            raise OSError(errno.EADDRINUSE, "occupied test port")
        if port == 21001 and self.kind == socket.SOCK_DGRAM:
            raise OSError(errno.EACCES, "reserved UDP test port")


class ServicePortTests(unittest.TestCase):
    def test_skips_occupied_and_reserved_endpoints_and_checks_both_protocols(self):
        attempts = []
        probes = []

        def make_probe(family, kind):
            self.assertEqual(family, socket.AF_INET)
            probe = ProbeSocket(kind, attempts)
            probes.append(probe)
            return probe

        with patch.object(smoke.socket, "socket", side_effect=make_probe):
            port = smoke.find_service_test_port([21000, 21001, 21002])
        self.assertEqual(port, 21002)
        self.assertEqual(attempts, [
            (socket.SOCK_STREAM, ("0.0.0.0", 21000)),
            (socket.SOCK_STREAM, ("0.0.0.0", 21001)),
            (socket.SOCK_DGRAM, ("0.0.0.0", 21001)),
            (socket.SOCK_STREAM, ("0.0.0.0", 21002)),
            (socket.SOCK_DGRAM, ("0.0.0.0", 21002)),
        ])
        self.assertTrue(all(probe.closed for probe in probes), "selection leaked a probe socket")

    def test_invalid_candidates_do_not_exhaust_the_native_fallback_window(self):
        attempts = []
        with patch.object(smoke.socket, "socket", side_effect=lambda _, kind: ProbeSocket(kind, attempts)):
            port = smoke.find_service_test_port([0, -1, 65530, 22000])
        self.assertEqual(port, 22000)
        self.assertEqual([address[1] for _, address in attempts], [22000, 22000])

    def test_no_available_endpoint_reports_actual_bind_errors(self):
        attempts = []
        with patch.object(smoke.socket, "socket", side_effect=lambda _, kind: ProbeSocket(kind, attempts)):
            with self.assertRaisesRegex(RuntimeError, "occupied test port.*reserved UDP test port"):
                smoke.find_service_test_port([21000, 21001])

    def test_default_selection_is_within_safe_range_and_rebindable(self):
        port = smoke.find_service_test_port()
        self.assertGreaterEqual(port, 20000)
        self.assertLess(port, 45000)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp:
            tcp.bind(("0.0.0.0", port))
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                udp.bind(("0.0.0.0", port))


if __name__ == "__main__":
    unittest.main(verbosity=2)
