#!/usr/bin/env node
/**
 * Mock LocalSend v2 peer (Task 8, PART B).
 *
 * A standalone Node implementation of the LocalSend protocol v2 wire surface.
 * It deliberately shares NO code with the plugin's native implementation —
 * the only dependency beyond the Node stdlib is the `selfsigned`
 * devDependency used for the throwaway TLS certificate. Protocol facts
 * follow https://github.com/localsend/protocol v2.2.
 *
 * Subcommands:
 *   serve [--alias MockPeer] [--port N] [--dir tmpdir]
 *       [--pin N] [--decline] [--slow-ms N] [--message-204]
 *       A standalone receiver: UDP multicast announce on 224.0.0.167:53317
 *       every 5s while listening for peer frames (Windows ECONNRESET is
 *       swallowed), answering announce:true frames with a POST /register to
 *       the origin; self-signed HTTPS v2 endpoints register / prepare-upload
 *       / upload / cancel / info. prepare-upload ACCEPTS all files by
 *       default; --decline / --pin N (or the control endpoint) change that.
 *       --message-204 mirrors the official message path: a single text/plain
 *       file carrying a non-empty preview is accepted with 204 and no upload
 *       (the text already rode in the preview). Uploaded bytes stream to
 *       --dir. Every observation is printed as one JSON line per event, e.g.
 *       {"event":"prepare","sessionId":...,"previews":[...]},
 *       {"event":"uploaded","fileId":...,"bytes":N},{"event":"done"}.
 *   send --to <ip:port> --file <path> [--file <path2> ...] [--pin N]
 *        [--text "..."] [--decline] [--corrupt-sha] [--abort-prepare]
 *        [--cancel] [--slow-ms N] [--local-ip X]
 *       An official sender: announce, POST prepare-upload with metadata
 *       (fileName/size/fileType/sha256 — --corrupt-sha sends a wrong
 *       sha256), HOLD the request open until the receiver answers, then
 *       parallel uploads (concurrency 2) that retry a 422 checksum mismatch
 *       with the same token up to 3 attempts (official MAX_UPLOAD_ATTEMPTS).
 *       204 → "nothing accepted", 403 → declined, 409 → blocked.
 *       --decline / --decline-expect-403 only mark the expectation that the
 *       held prepare comes back 403 (declining is the receiver's decision).
 *       --abort-prepare destroys the connection before the decision (dead
 *       sender); --cancel mirrors the official abort via POST /cancel
 *       without a sessionId from the same source.
 */

import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';

const MULTICAST_GROUP = '224.0.0.167';
const UDP_PORT = 53317;
const API = '/api/localsend/v2';
const ANNOUNCE_INTERVAL_MS = 5000;
const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_CONCURRENCY = 2;

/** Print one JSON line for test observation. */
function emit(event) {
  console.log(JSON.stringify(event));
}

function fail(message) {
  console.error(`mock-peer: ${message}`);
  process.exit(2);
}

/** Minimal flag parser: `--flag value` options plus bare boolean flags. */
function parseArgs(argv, valueFlags) {
  const opts = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (valueFlags.includes(name)) {
      index += 1;
      if (index >= argv.length) fail(`missing value for --${name}`);
      if (name === 'file') (opts.files ??= []).push(argv[index]);
      else opts[name] = argv[index];
    } else {
      opts[name] = true;
    }
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mimeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.txt':
    case '.md':
    case '.log':
      return 'text/plain';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.pdf':
      return 'application/pdf';
    case '.mp4':
      return 'video/mp4';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

function derFromPem(pem) {
  return Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

/** sha256 hex of a file, streamed (never buffered whole). */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Open an HTTP(S) request without ending it. Returns the raw `req` (so a
 * caller can stream the body or destroy the connection) and `done`, a
 * promise of {status, headers, body} that never times out — the sender
 * officially HOLDS prepare-upload open until the receiver decides.
 */
function openRequest(urlString, { method = 'GET', headers = {}, localAddress = null } = {}) {
  const url = new URL(urlString);
  const isTls = url.protocol === 'https:';
  const options = {
    method,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    headers,
    agent: false, // no keep-alive pooling: the process exits as soon as done
  };
  if (isTls) options.rejectUnauthorized = false; // official: accept invalid certs
  if (localAddress) options.localAddress = localAddress;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const req = (isTls ? https : http).request(options, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () =>
      resolveDone({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
    );
    res.on('error', rejectDone);
  });
  req.on('error', rejectDone);
  return { req, done };
}

const wrote = (req, chunk) =>
  new Promise((resolve, reject) => req.write(chunk, (error) => (error ? reject(error) : resolve())));

/** One-shot request with an in-memory body. */
async function requestRaw(urlString, { method = 'GET', body = null, localAddress = null } = {}) {
  const headers = {};
  if (body !== null) headers['Content-Length'] = Buffer.byteLength(body);
  const { req, done } = openRequest(urlString, { method, headers, localAddress });
  if (body !== null) req.end(body);
  else req.end();
  return done;
}

/** Read a request body with a hard cap (for JSON endpoints). */
function readBody(req, cap = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const bytes = await readBody(req);
  if (bytes.length === 0) return null;
  return JSON.parse(bytes.toString('utf8'));
}

function jsonReply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(value === undefined ? '' : JSON.stringify(value));
}

/** Stream a file (or buffer) into the request with optional throttling. */
async function writeBody(req, { filePath = null, content = null, slowMs = 0 }) {
  if (content !== null) {
    await wrote(req, content);
    req.end();
    return;
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      await wrote(req, buffer.subarray(0, bytesRead));
      if (slowMs) await sleep(slowMs);
    }
    req.end();
  } finally {
    await handle.close();
  }
}

/** Fixed-size worker pool (official sender uploads with parallelism); returns each worker's result. */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await worker(items[current]);
      }
    }),
  );
  return results;
}

/** The device-info DTO announced/registered on the wire. */
function deviceInfo({ alias, fingerprint, port }) {
  return {
    alias,
    version: '2.2',
    deviceModel: 'MockPeer Model',
    deviceType: 'headless',
    fingerprint,
    port,
    protocol: 'https',
    download: false,
  };
}

function announceFrame(info, announce) {
  return Buffer.from(`${JSON.stringify({ ...info, announce })}\n`, 'utf8');
}

function parseAnnounce(bytes) {
  const text = bytes.toString('utf8').trim();
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { alias, fingerprint, port } = value;
  if (typeof alias !== 'string' || typeof fingerprint !== 'string' || typeof port !== 'number') {
    return null;
  }
  return { ...value, announce: value.announce === true };
}

/**
 * Bind the discovery UDP socket on `port` (fallback +1..+10), join the
 * multicast group, keep multicast loop ON so same-host peers (the DLL in
 * integration tests) hear our frames.
 */
async function bindUdp({ preferredPort, multicast = true }) {
  let lastError = null;
  for (let candidate = preferredPort; candidate <= preferredPort + 10; candidate++) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(candidate, () => {
          socket.removeListener('error', reject);
          resolve();
        });
      });
      socket.setMulticastTTL(1);
      socket.setMulticastLoopback(true);
      if (multicast) socket.addMembership(MULTICAST_GROUP);
      // Windows surfaces WSAECONNRESET on UDP sends to unreachable peers;
      // swallow it instead of dying (the announce loop just continues).
      socket.on('error', (error) => emit({ event: 'udp-error', message: String(error) }));
      return { socket, port: candidate };
    } catch (error) {
      lastError = error;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }
  throw lastError ?? new Error('no UDP port candidate');
}

// ---------------------------------------------------------------------------
// serve — a standalone LocalSend v2 receiver
// ---------------------------------------------------------------------------

async function cmdServe(opts) {
  const alias = opts.alias ?? 'MockPeer';
  const dir = path.resolve(opts.dir ?? path.join(os.tmpdir(), `otools-mock-peer-${process.pid}`));
  await fs.promises.mkdir(dir, { recursive: true });

  const pems = await selfsigned.generate([{ name: 'commonName', value: alias }], {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
  });
  // Official fingerprint algorithm: sha256 hex of the certificate DER.
  const fingerprint = crypto.createHash('sha256').update(derFromPem(pems.cert)).digest('hex');

  const info = deviceInfo({ alias, fingerprint, port: 0 });
  const receiver = {
    // prepare-upload behavior: accept all by default, configurable.
    mode: opts.decline ? 'decline' : opts.pin ? 'pin' : 'accept-all',
    pin: opts.pin ?? null,
    slowMs: Number(opts['slow-ms'] ?? 0),
    // Official message path: accept a single text/plain entry with a
    // non-empty preview by answering 204 (no upload happens at all).
    message204: opts['message-204'] === true,
  };
  /** sessionId → {id, status, sender, files: Map(fileId → entry), tokens: Map, uploaded: Set} */
  const sessions = new Map();

  const announce = () => {
    const frame = announceFrame(info, true);
    udp.socket.send(frame, UDP_PORT, MULTICAST_GROUP, (error) => {
      if (error) emit({ event: 'udp-error', message: String(error) });
    });
  };

  const udp = await bindUdp({ preferredPort: UDP_PORT });
  info.port = 0; // replaced by the real HTTPS port once bound
  udp.socket.on('message', (bytes, rinfo) => {
    const frame = parseAnnounce(bytes);
    if (!frame || frame.fingerprint === fingerprint) return;
    emit({
      event: 'announce-seen',
      alias: frame.alias,
      ip: rinfo.address,
      port: frame.port,
      fingerprint: frame.fingerprint,
      announce: frame.announce,
    });
    if (frame.announce && frame.port > 0) {
      // Official v2: answer announce:true with POST /register to the origin.
      requestRaw(`https://${rinfo.address}:${frame.port}${API}/register`, {
        method: 'POST',
        body: JSON.stringify(info),
      })
        .then((res) => {
          if (res.status !== 200) throw new Error(`register answered ${res.status}`);
          emit({
            event: 'register',
            origin: `${rinfo.address}:${frame.port}`,
            peer: JSON.parse(res.body.toString('utf8')),
          });
        })
        .catch((error) => emit({ event: 'register-failed', origin: rinfo.address, message: String(error) }));
    }
  });
  const announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  announceTimer.unref?.();

  const server = https.createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'POST' && url.pathname === `${API}/register`) {
        const peer = await readJson(req);
        emit({ event: 'register-received', from: req.socket.remoteAddress, peer });
        jsonReply(res, 200, info);
        return;
      }
      if (req.method === 'GET' && url.pathname === `${API}/info`) {
        jsonReply(res, 200, info);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/control') {
        const body = await readJson(req);
        if (body.mode) receiver.mode = body.mode;
        if ('pin' in body) receiver.pin = body.pin;
        emit({ event: 'control', mode: receiver.mode, pin: receiver.pin });
        jsonReply(res, 200, { ok: true, mode: receiver.mode, pin: receiver.pin });
        return;
      }
      if (req.method === 'POST' && url.pathname === `${API}/prepare-upload`) {
        handlePrepare(req, res, url);
        return;
      }
      if (req.method === 'POST' && url.pathname === `${API}/upload`) {
        handleUpload(req, res, url);
        return;
      }
      if (req.method === 'POST' && url.pathname === `${API}/cancel`) {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId && sessions.has(sessionId)) {
          sessions.delete(sessionId);
          emit({ event: 'cancel', sessionId });
        }
        jsonReply(res, 200);
        return;
      }
      jsonReply(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) jsonReply(res, 400, { error: String(error) });
      else res.destroy();
    }
  });
  server.on('tlsClientError', (error) => emit({ event: 'tls-client-error', message: String(error) }));
  server.on('clientError', (error, socket) => socket.destroy());

  await new Promise((resolve) => server.listen(Number(opts.port ?? 0), '0.0.0.0', resolve));
  info.port = server.address().port;
  announce();
  emit({
    event: 'listening',
    alias,
    port: info.port,
    udpPort: udp.port,
    fingerprint,
    dir,
    mode: receiver.mode,
    pin: receiver.pin,
  });

  function handlePrepare(req, res, url) {
    // Consumed inside the async wrapper below; errors bubble to the wrapper.
    (async () => {
      const body = await readJson(req);
      const files = body?.files ?? {};
      const sender = body?.info ?? {};
      const entries = Object.values(files).filter(
        (entry) => entry && typeof entry.id === 'string' && typeof entry.fileName === 'string',
      );
      const answer = (status, value) => {
        emit({
          event: 'prepare',
          status,
          sessionId: value?.sessionId,
          files: entries.length,
          // Official senders embed the text into `preview` for a single-text
          // send (send_provider.dart) — recorded so tests can assert the
          // message wire shape.
          previews: entries.map((entry) => entry?.preview ?? null),
          sender: sender.alias,
        });
        jsonReply(res, status, value);
      };
      if (receiver.mode === 'decline') return answer(403, { error: 'Rejected' });
      if (receiver.mode === 'pin') {
        const provided = url.searchParams.get('pin');
        if (provided === null || provided === '') return answer(401, { error: 'PIN required' });
        if (provided !== receiver.pin) return answer(401, { error: 'Invalid PIN' });
      }
      if (entries.length === 0) return answer(400, { error: 'No files provided' });
      if (
        receiver.message204 &&
        entries.length === 1 &&
        entries[0].fileType === 'text/plain' &&
        typeof entries[0].preview === 'string' &&
        entries[0].preview.length > 0
      ) {
        // Official receive_session_state.dart: a single text file with a
        // preview renders as a message bubble and is accepted without any
        // file transfer — nothing to upload, so 204.
        return answer(204);
      }
      const busy = [...sessions.values()].some((session) => session.status === 'transferring');
      if (busy) return answer(409, { error: 'Blocked by another session' });

      const sessionId = crypto.randomUUID();
      const session = {
        id: sessionId,
        status: 'transferring',
        sender,
        files: new Map(entries.map((entry) => [entry.id, entry])),
        tokens: new Map(),
        uploaded: new Set(),
      };
      for (const id of session.files.keys()) {
        session.tokens.set(id, crypto.randomBytes(16).toString('hex'));
      }
      sessions.set(sessionId, session);
      answer(200, { sessionId, files: Object.fromEntries(session.tokens) });
    })().catch((error) => {
      if (!res.headersSent) jsonReply(res, 400, { error: String(error) });
      else res.destroy();
    });
  }

  async function handleUpload(req, res, url) {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const fileId = url.searchParams.get('fileId') ?? '';
    const token = url.searchParams.get('token') ?? '';
    const session = sessions.get(sessionId);
    if (!session || !session.tokens.has(fileId) || session.tokens.get(fileId) !== token) {
      return jsonReply(res, 403, { error: 'Invalid token or IP address' });
    }
    if (session.status !== 'transferring' || session.uploaded.has(fileId)) {
      return jsonReply(res, 409, { error: 'Blocked by another session' });
    }
    // Mirror the receiver's unsafe-fileId rejection before touching disk.
    if (!fileId || fileId === '.' || fileId === '..' || /[\\/:]/.test(fileId)) {
      return jsonReply(res, 400, { error: 'Invalid body' });
    }
    const entry = session.files.get(fileId);
    const target = path.join(dir, sessionId, fileId);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const hash = crypto.createHash('sha256');
    const handle = await fs.promises.open(target, 'w');
    let bytes = 0;
    const read = makeBodyReader(req);
    try {
      for (;;) {
        const bytesRead = await read();
        if (bytesRead === 0) break;
        const slice = read.buffer.subarray(0, bytesRead);
        hash.update(slice);
        await handle.write(slice);
        bytes += bytesRead;
        if (receiver.slowMs) await sleep(receiver.slowMs);
      }
    } finally {
      await handle.close();
    }
    const digest = hash.digest('hex');
    if (entry?.sha256 && entry.sha256.toLowerCase() !== digest) {
      await fs.promises.rm(target, { force: true });
      emit({ event: 'upload-failed', sessionId, fileId, status: 422, bytes });
      return jsonReply(res, 422, { error: 'Checksum mismatch' });
    }
    session.uploaded.add(fileId);
    emit({ event: 'uploaded', sessionId, fileId, fileName: entry?.fileName, bytes, path: target });
    if (session.uploaded.size === session.files.size) {
      session.status = 'done';
      emit({ event: 'done', sessionId, status: 'done' });
    }
    jsonReply(res, 200);
  }

  // Keep the process alive for the test driver; killed externally.
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

/**
 * Bounded streaming reader for a request body: each `read()` copies up to
 * 64 KiB into an internal buffer and returns the byte count; 0 means EOF.
 * Chunks larger than the buffer are split and the remainder is carried into
 * the following read — the previous readChunk dropped everything past the
 * first 64 KiB of an oversized chunk (latent corruption). A client abort
 * mid-body surfaces as an error instead of a silent 0-byte EOF, and the
 * socket is paused while a produced piece waits for the next read, so the
 * body is never buffered whole in memory.
 */
function makeBodyReader(req) {
  const size = 64 * 1024;
  const buffer = Buffer.alloc(size);
  const queue = []; // unconsumed pieces: { data, offset }
  let waiter = null; // pending { resolve, reject } of a waiting read
  let ended = false;
  let failure = null;

  function settle() {
    if (!waiter) return;
    if (queue.length > 0) {
      const copied = takeInto();
      waiter.resolve(copied);
      waiter = null;
    } else if (ended) {
      waiter.resolve(0);
      waiter = null;
    } else if (failure) {
      waiter.reject(failure);
      waiter = null;
    }
  }

  function takeInto() {
    const item = queue[0];
    const wanted = Math.min(buffer.length, item.data.length - item.offset);
    const copied = item.data.copy(buffer, 0, item.offset, item.offset + wanted);
    item.offset += copied;
    if (item.offset >= item.data.length) queue.shift();
    return copied;
  }

  const abort = () => {
    ended = true;
    failure = failure ?? new Error('request aborted by the sender');
    settle();
  };
  req.on('data', (chunk) => {
    queue.push({ data: chunk, offset: 0 });
    if (!waiter) req.pause(); // backpressure: nothing is consuming right now
    settle();
  });
  req.on('end', () => {
    ended = true;
    settle();
  });
  req.on('aborted', abort);
  req.on('error', (error) => {
    failure = failure ?? error;
    ended = true;
    settle();
  });
  req.on('close', () => {
    if (!ended) abort();
  });

  read.buffer = buffer;
  return read;

  function read() {
    if (queue.length > 0) {
      const copied = takeInto();
      req.resume(); // one piece consumed: let the next chunk flow
      return Promise.resolve(copied);
    }
    if (ended && !failure) return Promise.resolve(0);
    if (failure) return Promise.reject(failure);
    req.resume(); // keep the stream flowing while we wait
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
    });
  }
}

// ---------------------------------------------------------------------------
// send — an official sender
// ---------------------------------------------------------------------------

async function cmdSend(opts) {
  if (!opts.to) fail('--to <ip:port> is required');
  const [host, portStr] = opts.to.split(':');
  const base = `https://${host}:${portStr}`;
  const slowMs = Number(opts['slow-ms'] ?? 0);
  const localAddress = opts['local-ip'] ?? null;
  const expectDecline = Boolean(opts.decline || opts['decline-expect-403']);

  const info = deviceInfo({
    alias: opts.alias ?? 'MockSender',
    fingerprint: crypto.randomBytes(32).toString('hex'),
    port: 0, // send-only peer; no HTTPS listener
  });

  const files = [];
  for (const filePath of opts.files ?? []) {
    const resolved = path.resolve(filePath);
    const stat = await fs.promises.stat(resolved);
    const sha256 = opts['corrupt-sha'] ? '0'.repeat(64) : await sha256File(resolved);
    files.push({
      id: crypto.randomUUID(),
      fileName: path.basename(resolved),
      size: stat.size,
      fileType: mimeFor(resolved),
      sha256,
      preview: null,
      metadata: null,
      filePath: resolved,
      content: null,
    });
  }
  if (typeof opts.text === 'string') {
    const content = Buffer.from(opts.text, 'utf8');
    files.push({
      id: crypto.randomUUID(),
      fileName: 'message.txt',
      fileType: 'text/plain',
      size: content.length,
      sha256: opts['corrupt-sha']
        ? '0'.repeat(64)
        : crypto.createHash('sha256').update(content).digest('hex'),
      preview: null,
      metadata: null,
      filePath: null,
      content,
    });
  }
  if (files.length === 0) fail('nothing to send: pass --file/--text');

  // Mirror the official sender: announce ourselves so the receiver sees the
  // peer (best effort — the exchange below does not depend on it).
  try {
    const { socket } = await bindUdp({ preferredPort: 0, multicast: false });
    socket.send(announceFrame(info, true), UDP_PORT, MULTICAST_GROUP, () => socket.close());
    emit({ event: 'announced', alias: info.alias, fingerprint: info.fingerprint, files: files.length });
  } catch (error) {
    emit({ event: 'announce-failed', message: String(error) });
  }

  const prepareBody = JSON.stringify({
    info,
    files: Object.fromEntries(
      files.map(({ id, fileName, size, fileType, sha256, preview, metadata }) => [
        id,
        { id, fileName, size, fileType, sha256, preview, metadata },
      ]),
    ),
  });
  const pinSuffix = opts.pin ? `?pin=${encodeURIComponent(String(opts.pin))}` : '';
  const { req, done } = openRequest(`${base}${API}/prepare-upload${pinSuffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(prepareBody) },
    localAddress,
  });
  req.on('socket', (socket) => {
    socket.on('error', () => {}); // --abort-prepare destroys on purpose
  });
  await wrote(req, prepareBody);
  req.end();

  if (opts['abort-prepare']) {
    // Dead sender: vanish before the receiver decides. The held prepare
    // handler dies with the connection (official PendingSessionGuard).
    await sleep(300);
    req.destroy();
    emit({ event: 'aborted', reason: 'abort-prepare' });
    return;
  }
  if (opts.cancel) {
    // Official abort of a still-pending prepare: POST /cancel WITHOUT a
    // sessionId from the same source; the receiver declines that session.
    try {
      await requestRaw(`${base}${API}/cancel`, { method: 'POST', localAddress });
      emit({ event: 'cancel-sent' });
    } catch (error) {
      emit({ event: 'cancel-failed', message: String(error) });
    }
  }

  // HOLD the request open until the receiver answers (no timeout here).
  const res = await done;
  emit({
    event: 'prepare',
    status: res.status,
    sessionId: safeJson(res.body)?.sessionId,
    error: res.status !== 200 && res.status !== 204 ? res.body.toString('utf8') || undefined : undefined,
    files: files.length,
    expectedDecline: expectDecline || undefined,
  });

  if (res.status === 200) {
    const parsed = safeJson(res.body) ?? {};
    const sessionId = parsed.sessionId;
    const tokens = parsed.files ?? {};
    const outcomes = await runPool(files, UPLOAD_CONCURRENCY, async (file) => {
      const token = tokens[file.id];
      if (!token) {
        // Official: the receiver's response only carries ACCEPTED file ids.
        emit({ event: 'skipped', fileId: file.id, fileName: file.fileName });
        return true;
      }
      return uploadOne({ base, sessionId, file, token, slowMs, localAddress });
    });
    emit({
      event: 'done',
      sessionId,
      status: outcomes.every(Boolean) ? 'done' : 'failed',
      uploaded: outcomes.filter(Boolean).length,
      files: files.length,
    });
    return;
  }
  const statusName =
    res.status === 204
      ? 'empty' // nothing accepted
      : res.status === 403
        ? 'declined'
        : res.status === 401
          ? 'pin-rejected'
          : res.status === 409
            ? 'blocked'
            : 'error';
  emit({ event: 'done', status: statusName, httpStatus: res.status, error: res.body.toString('utf8') || undefined });
}

async function uploadOne({ base, sessionId, file, token, slowMs, localAddress }) {
  const query = new URLSearchParams({ sessionId, fileId: file.id, token });
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    emit({ event: 'upload-start', fileId: file.id, fileName: file.fileName, attempt, bytes: file.size });
    const headers = { 'Content-Type': file.fileType, 'Content-Length': file.size };
    const { req, done } = openRequest(`${base}${API}/upload?${query}`, {
      method: 'POST',
      headers,
      localAddress,
    });
    req.on('socket', (socket) => socket.on('error', () => {}));
    const bodyDone = writeBody(req, { filePath: file.filePath, content: file.content, slowMs }).catch(
      (error) => ({ writeError: error }),
    );
    let res;
    try {
      [res] = await Promise.all([done, bodyDone]);
    } catch (error) {
      emit({ event: 'upload-failed', fileId: file.id, attempt, error: String(error) });
      return false;
    }
    if (res.status === 200) {
      emit({ event: 'uploaded', fileId: file.id, fileName: file.fileName, bytes: file.size });
      return true;
    }
    if (res.status === 422) {
      // Checksum mismatch: retry the SAME token (official _maxUploadAttempts).
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        emit({ event: 'upload-retry', fileId: file.id, attempt, status: 422 });
        continue;
      }
      emit({
        event: 'upload-failed',
        fileId: file.id,
        attempt,
        status: 422,
        error: 'retry budget exhausted',
        attempts: MAX_UPLOAD_ATTEMPTS,
      });
      return false;
    }
    emit({
      event: 'upload-failed',
      fileId: file.id,
      attempt,
      status: res.status,
      error: res.body.toString('utf8') || undefined,
    });
    return false;
  }
  emit({ event: 'upload-failed', fileId: file.id, error: 'retry budget exhausted', attempts: MAX_UPLOAD_ATTEMPTS });
  return false;
}

function safeJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

const [, , command, ...rest] = process.argv;
if (command === 'serve') {
  await cmdServe(parseArgs(rest, ['alias', 'port', 'dir', 'pin', 'slow-ms']));
} else if (command === 'send') {
  await cmdSend(
    parseArgs(rest, ['to', 'file', 'pin', 'text', 'slow-ms', 'local-ip', 'alias']),
  );
} else {
  fail('usage: mock-peer.mjs serve [...] | send --to <ip:port> [...]');
}
