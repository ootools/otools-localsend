import type { DeviceEntry } from "../api";

// Native lastSeenMs is elapsed time; the UI stores unix milliseconds.
function fromWire(entry: DeviceEntry, now: number): DeviceEntry {
  return { ...entry, lastSeenMs: now - Math.max(0, entry.lastSeenMs ?? 0) };
}

function newestFirst(list: DeviceEntry[]): DeviceEntry[] {
  return list.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}

export function devicesFromWire(list: DeviceEntry[], now: number): DeviceEntry[] {
  return newestFirst(list.map((entry) => fromWire(entry, now)));
}

export function upsertDeviceFromWire(
  list: DeviceEntry[],
  entry: DeviceEntry,
  now: number,
): DeviceEntry[] {
  const incoming = fromWire(entry, now);
  const index = list.findIndex((item) => item.info.fingerprint === entry.info.fingerprint);
  if (index < 0) return newestFirst([...list, incoming]);
  const next = [...list];
  next[index] = {
    ...incoming,
    lastSeenMs: Math.max(list[index].lastSeenMs, incoming.lastSeenMs),
  };
  return newestFirst(next);
}
