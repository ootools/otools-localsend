import type { OToolsAPI, TauriEventPluginInternals } from "./otools-globals";

type UnlistenFn = () => Promise<void> | void;
type TransformCallback = (payload: { payload: unknown }) => unknown;
type RuntimeHandler<T = unknown> = (payload: T) => void | Promise<void>;
type RuntimeListener = {
  topic: string;
  handlerId?: number;
};
type NativeEnvelope = {
  topic: string;
  payload: unknown;
};

const transformCallbacks = new Map<
  number,
  { callback: TransformCallback; once: boolean }
>();
const transformCallbackRefs = new Map<number, number>();
const runtimeListeners = new Map<number, RuntimeListener>();
const topicBuckets = new Map<string, Map<number, RuntimeHandler>>();

let transformCallbackSequence = 0;
let runtimeListenerSequence = 0;
let nativeSubscription: Promise<UnlistenFn> | null = null;

function resolveOtoolsApi(): OToolsAPI | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.otools ?? window.utools;
}

function normalizeEnvelope(event: unknown): NativeEnvelope | null {
  const raw =
    event && typeof event === "object" && "payload" in (event as Record<string, unknown>)
      ? (event as { payload?: unknown }).payload
      : event;

  if (!raw || typeof raw !== "object") {
    return null;
  }

  const topic = (raw as { topic?: unknown }).topic;
  if (typeof topic !== "string" || !topic) {
    return null;
  }

  return {
    topic,
    payload: (raw as { payload?: unknown }).payload ?? null,
  };
}

function dispatchNativeEnvelope(envelope: NativeEnvelope) {
  const listeners = topicBuckets.get(envelope.topic);
  if (!listeners) {
    return;
  }

  for (const listener of listeners.values()) {
    void listener(envelope.payload);
  }
}

async function ensureNativeSubscription() {
  if (nativeSubscription) {
    return nativeSubscription;
  }

  const otools = resolveOtoolsApi();
  if (!otools?.listenNative) {
    nativeSubscription = Promise.resolve(async () => {});
    return nativeSubscription;
  }

  nativeSubscription = otools.listenNative((event) => {
    const envelope = normalizeEnvelope(event);
    if (!envelope) {
      return;
    }
    dispatchNativeEnvelope(envelope);
  });

  return nativeSubscription;
}

async function shutdownNativeSubscriptionIfIdle() {
  if (topicBuckets.size > 0 || !nativeSubscription) {
    return;
  }

  // Detach before awaiting: a new listener may acquire its own subscription
  // while the previous host release is still pending.
  const subscription = nativeSubscription;
  nativeSubscription = null;
  const unsubscribe = await subscription;
  await unsubscribe();
}

function retainTransformCallback(handlerId: number) {
  const count = transformCallbackRefs.get(handlerId) ?? 0;
  transformCallbackRefs.set(handlerId, count + 1);
}

function releaseTransformCallback(handlerId: number) {
  const count = transformCallbackRefs.get(handlerId);
  if (!count || count <= 1) {
    transformCallbackRefs.delete(handlerId);
    transformCallbacks.delete(handlerId);
    return;
  }

  transformCallbackRefs.set(handlerId, count - 1);
}

function ensureEventPluginInternals() {
  if (typeof window === "undefined") {
    return;
  }

  const existing = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
  if (typeof existing?.unregisterListener === "function") {
    return;
  }

  const shim: TauriEventPluginInternals = {
    unregisterListener(_event, eventId) {
      void detachTransformListener(eventId);
    },
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = shim;
}

export function registerTransformCallback(
  callback: TransformCallback,
  once = false,
) {
  ensureEventPluginInternals();
  const id = ++transformCallbackSequence;
  transformCallbacks.set(id, { callback, once });
  return id;
}

export async function attachTransformListener(topic: string, handlerId: number) {
  ensureEventPluginInternals();

  const listenerId = ++runtimeListenerSequence;
  const bucket = topicBuckets.get(topic) ?? new Map<number, RuntimeHandler>();
  bucket.set(listenerId, (payload) => {
    const entry = transformCallbacks.get(handlerId);
    if (!entry) {
      return;
    }

    entry.callback({ payload });
    if (entry.once) {
      transformCallbacks.delete(handlerId);
      transformCallbackRefs.delete(handlerId);
    }
  });

  topicBuckets.set(topic, bucket);
  runtimeListeners.set(listenerId, { topic, handlerId });
  retainTransformCallback(handlerId);
  await ensureNativeSubscription();

  return listenerId;
}

export async function detachTransformListener(listenerId: number) {
  const listener = runtimeListeners.get(listenerId);
  if (!listener) {
    return;
  }

  runtimeListeners.delete(listenerId);

  const bucket = topicBuckets.get(listener.topic);
  bucket?.delete(listenerId);
  if (bucket && bucket.size === 0) {
    topicBuckets.delete(listener.topic);
  }

  if (typeof listener.handlerId === "number") {
    releaseTransformCallback(listener.handlerId);
  }

  await shutdownNativeSubscriptionIfIdle();
}

export async function listenNativeTopic<T>(
  topic: string,
  handler: RuntimeHandler<T>,
): Promise<UnlistenFn> {
  ensureEventPluginInternals();

  const listenerId = ++runtimeListenerSequence;
  const bucket = topicBuckets.get(topic) ?? new Map<number, RuntimeHandler>();
  bucket.set(listenerId, handler as RuntimeHandler);
  topicBuckets.set(topic, bucket);
  runtimeListeners.set(listenerId, { topic });
  await ensureNativeSubscription();

  return async () => {
    await detachTransformListener(listenerId);
  };
}
