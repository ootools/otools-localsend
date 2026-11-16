import { useEffect, useState } from "react";
import { previewFile, type FileResourceQuery, type FilePreview } from "../api";

export type ImagePreviewState = Omit<FilePreview, "status"> & { status: "loading" | "ready" | "unavailable" };

type CachedPreview = { value: FilePreview; expires: number; bytes: number };
const cache = new Map<string, CachedPreview>();
const pending = new Map<string, Promise<FilePreview>>();
const queue: Array<() => void> = [];
let active = 0;
let cacheBytes = 0;
const CACHE_TTL = 30_000;
const CACHE_BYTES = 8 * 1024 * 1024;

function identity(query: FileResourceQuery | null, version: string): string {
  if (!query) return "";
  return JSON.stringify("path" in query ? ["path", query.path, version] : ["transfer", query.sessionId, query.fileId, version]);
}

function safePreview(value: FilePreview): FilePreview {
  if (value.status !== "ready") return { status: "unavailable", reason: value.reason || "unavailable" };
  if (typeof value.dataUrl !== "string" || value.dataUrl.length > 700_000 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl) ||
      !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
      value.width! <= 0 || value.height! <= 0 || value.width! > 16384 || value.height! > 16384 ||
      value.width! * value.height! > 16 * 1024 * 1024) {
    return { status: "unavailable", reason: "invalid-image" };
  }
  return value;
}

function remember(key: string, value: FilePreview): void {
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.bytes;
  cache.delete(key);
  const bytes = (value.dataUrl?.length ?? 0) * 2 + 256;
  cache.set(key, { value, bytes, expires: Date.now() + CACHE_TTL });
  cacheBytes += bytes;
  while (cache.size > 64 || cacheBytes > CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}

function cached(key: string): CachedPreview | undefined {
  const entry = cache.get(key);
  if (!entry) return;
  if (entry.expires <= Date.now()) {
    cacheBytes -= entry.bytes;
    cache.delete(key);
    return;
  }
  return entry;
}

function pump(): void {
  while (active < 2 && queue.length) queue.shift()!();
}

function request(key: string, query: FileResourceQuery): Promise<FilePreview> {
  const existing = pending.get(key);
  if (existing) return existing;
  if (queue.length >= 128) return Promise.resolve({ status: "unavailable", reason: "busy" });
  let finish!: (value: FilePreview) => void;
  const promise = new Promise<FilePreview>((resolve) => { finish = resolve; });
  pending.set(key, promise);
  queue.push(() => {
    active++;
    void previewFile(query)
      .then(safePreview, () => ({ status: "unavailable", reason: "unavailable" } as FilePreview))
      .then((value) => { remember(key, value); finish(value); })
      .finally(() => {
        active--;
        if (pending.get(key) === promise) pending.delete(key);
        pump();
      });
  });
  pump();
  return promise;
}

export function useFilePreview(query: FileResourceQuery | null, enabled = true, version = ""): ImagePreviewState {
  const key = enabled ? identity(query, version) : "";
  const [snapshot, setSnapshot] = useState<{ key: string; value: ImagePreviewState }>(() => ({
    key,
    value: key ? cached(key)?.value ?? { status: "loading" } : { status: "unavailable", reason: "not-received" },
  }));

  useEffect(() => {
    if (!key || !query) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const existing = cached(key);
      const value = existing?.value ?? await request(key, query);
      if (!alive) return;
      setSnapshot({ key, value });
      const delay = Math.max(1, (cached(key)?.expires ?? Date.now() + CACHE_TTL) - Date.now());
      timer = setTimeout(() => { if (alive) void refresh(); }, delay);
    };
    void refresh();
    return () => { alive = false; if (timer !== undefined) clearTimeout(timer); };
  }, [key]);

  if (!key) return { status: "unavailable", reason: "not-received" };
  return snapshot.key === key ? snapshot.value : cached(key)?.value ?? { status: "loading" };
}
