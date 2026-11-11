export type CaptureErrorCode = 'unsupported' | 'permissionDenied' | 'busy' | 'cancelled' | 'timeout' | 'notFound' | 'invalidRequest' | 'forbidden' | 'captureFailed' | 'outputFailed';
export interface CaptureFailure { code: CaptureErrorCode; message: string }
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface CaptureImage { imageId: string; mimeType: 'image/png'; width: number; height: number; expiresAt: number }
export interface CaptureFrame extends CaptureImage {
  displayId: string; name: string; logicalBounds: CaptureRect;
  windows: Array<{ id: string; title: string; appName: string; rect: CaptureRect }>;
}
export interface CaptureCapabilities {
  available: boolean; platform: string; interactive: boolean; screen: boolean;
  region: boolean; window: boolean; edit: boolean; pin: boolean; reason?: string;
}
export interface CapturePermission { granted: boolean; canRequest: boolean }
export type CaptureRepairResult = { status: 'reset'; restartRequired: boolean } | { status: 'cancelled'; restartRequired: boolean };
export type CaptureCompletedResult = { status: 'completed'; captureId: string; image: CaptureImage; displayId: string; rect: CaptureRect; action: 'complete' | 'copy' | 'pin' };
export type CaptureResult = CaptureCompletedResult | { status: 'cancelled'; captureId: string } | { status: 'error'; captureId: string; error: CaptureFailure };
export interface CaptureSelectOptions {
  edit?: boolean;
  hideHost?: boolean;
  /** Select an area (default) or confirm one physical screen pixel. */
  mode?: 'region' | 'color';
  /** Restore windows hidden by capture on completion/cancellation; defaults to true. */
  restoreHost?: boolean;
  /** Color selection: false (default) samples the live screen; true freezes it. Region selection always freezes. */
  freezeScreen?: boolean;
}
export interface CaptureScreenOptions { displayId?: string; hideHost?: boolean }
export interface CaptureRegionOptions { displayId: string; rect: CaptureRect; hideHost?: boolean }
export interface CaptureWindowOptions { windowId?: string; hideHost?: boolean }
export interface CaptureTransport {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen?: (event: string, handler: (event: { payload: { captureId: string } }) => void) => Promise<() => void | Promise<void>>;
}
export interface CaptureApi {
  capabilities(): Promise<CaptureCapabilities>;
  permissionStatus(): Promise<CapturePermission>;
  requestPermission(): Promise<CapturePermission>;
  repairPermission(): Promise<CaptureRepairResult>;
  select(options?: CaptureSelectOptions, signal?: AbortSignal): Promise<CaptureResult>;
  screen(options?: CaptureScreenOptions): Promise<CaptureCompletedResult>;
  region(options: CaptureRegionOptions): Promise<CaptureCompletedResult>;
  window(options?: CaptureWindowOptions): Promise<CaptureCompletedResult>;
  pin(options: { dataUrl: string; logicalBounds?: CaptureRect }): Promise<{ pinId: string }>;
  readImage(imageId: string): Promise<Uint8Array>;
  retain(imageId: string): Promise<CaptureImage>;
  release(imageId: string): Promise<void>;
}

export class CaptureError extends Error implements CaptureFailure {
  constructor(public readonly code: CaptureErrorCode, message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

const errorCodes: CaptureErrorCode[] = ['unsupported', 'permissionDenied', 'busy', 'cancelled', 'timeout', 'notFound', 'invalidRequest', 'forbidden', 'captureFailed', 'outputFailed'];
function normalizeError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error;
  let value = error;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* A plain transport error. */ }
  }
  const record = value && typeof value === 'object' ? value as Partial<CaptureFailure> : undefined;
  const message = record?.message || String(error);
  const code = record?.code && errorCodes.includes(record.code) ? record.code
    : /runtime.*unavailable|bridge.*unavailable|not supported|unknown command|command .*not found/i.test(message) ? 'unsupported' : 'captureFailed';
  return new CaptureError(code, message);
}

// Dependency-free protocol implementation, also bundled into the plain webview init script.
export function createCaptureApi(transport: CaptureTransport): CaptureApi {
  const call = async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
    try { return await transport.invoke(`otools_host_capture_${method}`, args) as T; }
    catch (error) { throw normalizeError(error); }
  };
  return {
    capabilities: () => call('capabilities'),
    permissionStatus: () => call('permission_status'),
    requestPermission: () => call('request_permission'),
    repairPermission: () => call('repair_permission'),
    screen: (options = {}) => call('screen', { options }),
    region: options => call('region', { options }),
    window: (options = {}) => call('window', { options }),
    pin: options => call('pin', { options }),
    retain: imageId => call('retain', { imageId }),
    release: imageId => call('release', { imageId }),
    select(options = {}, signal) {
      return new Promise<CaptureResult>((resolve, reject) => {
        let done = false;
        let captureId: string | undefined;
        let stop: (() => void | Promise<void>) | undefined;
        let poll: ReturnType<typeof setTimeout> | undefined;
        let inFlight = false;
        const released = new Set<string>();
        const releaseAbandoned = (result: CaptureResult | null) => {
          if (result?.status === 'completed' && result.captureId === captureId && !released.has(result.image.imageId)) {
            released.add(result.image.imageId);
            void call('release', { imageId: result.image.imageId }).catch(() => {});
          }
        };
        const cancel = (id: string) => {
          // A result may have completed between polls. Cancel is idempotent; fetch
          // the retained terminal result once to release an otherwise orphaned lease.
          void call('cancel', { captureId: id })
            .then(() => call<CaptureResult | null>('result', { captureId: id }))
            .then(releaseAbandoned).catch(() => {});
        };
        const unlisten = () => {
          const cleanup = stop;
          stop = undefined;
          if (cleanup) { try { void Promise.resolve(cleanup()).catch(() => {}); } catch { /* Cleanup is best effort. */ } }
        };
        const finish = (result?: CaptureResult, error?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          clearTimeout(poll);
          signal?.removeEventListener('abort', abort);
          unlisten();
          if (error) {
            if (captureId) cancel(captureId);
            reject(normalizeError(error));
          } else resolve(result!);
        };
        const abort = () => finish(undefined, new CaptureError('cancelled', 'Capture aborted'));
        // Includes listener setup, begin, and stalled IPC; never leave a timer/session indefinitely.
        const deadline = setTimeout(() => finish(undefined, new CaptureError('timeout', 'Capture timed out')), 10 * 60 * 1000);
        const query = async () => {
          if (done || !captureId || inFlight) return;
          clearTimeout(poll);
          inFlight = true;
          try {
            const result = await call<CaptureResult | null>('result', { captureId });
            if (done) {
              releaseAbandoned(result);
              return;
            }
            if (result) {
              if (result.captureId !== captureId || !['completed', 'cancelled', 'error'].includes(result.status)) {
                throw new CaptureError('captureFailed', 'Invalid capture result');
              }
              finish(result);
            }
          } catch (error) { finish(undefined, error); }
          finally {
            inFlight = false;
            if (!done) poll = setTimeout(() => { void query(); }, 250);
          }
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        void (async () => {
          try {
            if (transport.listen) {
              try {
                stop = await transport.listen('otools-capture-result', event => {
                  if (event.payload?.captureId === captureId) void query();
                });
              } catch { /* Notifications are hints; polling still delivers retained results. */ }
            }
            if (done) { unlisten(); return; }
            const started = await call<{ captureId: string }>('begin', { options });
            if (!started?.captureId) throw new CaptureError('captureFailed', 'Missing capture id');
            captureId = started.captureId;
            if (done) { cancel(captureId); return; }
            // Always query once: completion may have preceded the begin response or its hint.
            void query();
          } catch (error) { finish(undefined, error); }
        })();
      });
    },
    async readImage(imageId) {
      const chunkSize = 1024 * 1024;
      const maxBytes = 64 * 1024 * 1024;
      let offset = 0;
      let bytes: Uint8Array | undefined;
      do {
        const chunk = await call<{ dataBase64: string; nextOffset: number; totalBytes: number }>('read_chunk', { imageId, offset, length: chunkSize });
        const invalid = () => new CaptureError('captureFailed', 'Invalid capture image chunk');
        if (!chunk || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes <= 0 || chunk.totalBytes > maxBytes
          || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= offset || chunk.nextOffset > chunk.totalBytes
          || chunk.nextOffset - offset > chunkSize || typeof chunk.dataBase64 !== 'string'
          || chunk.dataBase64.length > Math.ceil(chunkSize / 3) * 4
          || (bytes && bytes.length !== chunk.totalBytes)) throw invalid();
        let binary: string;
        try { binary = atob(chunk.dataBase64); } catch { throw invalid(); }
        if (binary.length !== chunk.nextOffset - offset) throw invalid();
        bytes ??= new Uint8Array(chunk.totalBytes);
        for (let index = 0; index < binary.length; index++) bytes[offset + index] = binary.charCodeAt(index);
        offset = chunk.nextOffset;
      } while (offset < bytes!.length);
      return bytes!;
    },
  };
}
