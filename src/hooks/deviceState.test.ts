import assert from "node:assert/strict";
import { test } from "node:test";
import { devicesFromWire, upsertDeviceFromWire } from "./deviceState.ts";
import type { DeviceEntry } from "../api";

const device = (fingerprint: string, elapsed: number): DeviceEntry => ({
  ip: "192.168.1.2",
  lastSeenMs: elapsed,
  info: {
    alias: fingerprint,
    version: "2.2",
    deviceModel: null,
    deviceType: "desktop",
    fingerprint,
    port: 53317,
    protocol: "https",
    download: false,
  },
});

const now = 1_800_000_000_000;

test("new announcements show the actual recent time", () => {
  const list = upsertDeviceFromWire([], device("new", 0), now);
  assert.equal(list[0].lastSeenMs, 1_800_000_000_000);
});

test("snapshots normalize elapsed milliseconds and put fresh devices first", () => {
  const list = devicesFromWire([device("old", 30_000), device("fresh", 2_000)], now);
  assert.deepEqual(list.map((item) => item.info.fingerprint), ["fresh", "old"]);
  assert.equal(list[0].lastSeenMs, 1_799_999_998_000);
  assert.equal(list[1].lastSeenMs, 1_799_999_970_000);
});

test("announcements refresh rather than duplicate an existing device", () => {
  const initial = devicesFromWire([device("same", 30_000), device("other", 2_000)], now);
  const refreshed = upsertDeviceFromWire(initial, device("same", 0), now);
  assert.equal(refreshed.length, 2);
  assert.equal(refreshed[0].info.fingerprint, "same");
  assert.equal(refreshed[0].lastSeenMs, 1_800_000_000_000);
});

test("a stale announcement does not move the last-seen time backwards", () => {
  const initial = devicesFromWire([device("same", 1_000)], now);
  const updated = upsertDeviceFromWire(initial, device("same", 30_000), now);
  assert.equal(updated[0].lastSeenMs, 1_799_999_999_000);
});
