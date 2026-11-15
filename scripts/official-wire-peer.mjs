#!/usr/bin/env node
// Independent LocalSend v2 literals, not mock-peer/native DTOs. Loopback only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import selfsigned from 'selfsigned';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert(['http', 'tls-identity', 'prepare401', 'upload403'].includes(config.mode));
const protocol = config.mode === 'http' ? 'http' : 'https';
const identityRequired = config.mode === 'tls-identity';
const emit = (kind, fields = {}) => console.log(JSON.stringify({ kind, ...fields }));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const remoteSession = 'official-wire-remote-session';
const token = 'fixture-upload-token-not-a-secret';
const errorBody = 'fixture-body-pin-not-a-secret; fixture-body-token-not-a-secret';
const safeError = (error) => [config.pin, token, 'fixture-body-pin-not-a-secret', 'fixture-body-token-not-a-secret']
  .filter(Boolean).reduce((text, marker) => text.replaceAll(marker, '[fixture value redacted]'), error.message);
let certificate;
let fingerprint = randomBytes(32).toString('hex');
if (protocol === 'https') {
  certificate = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keyType: 'ec', algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 86_400_000),
  });
  fingerprint = sha256(new X509Certificate(certificate.cert).raw);
}
// Official register/info responses omit port/protocol and may omit download.
const info = { alias: 'Official literal loopback peer', version: '2.2', fingerprint };
let prepared;

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
  response.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
}

function checkInfo(value) {
  assert.equal(typeof value?.alias, 'string');
  assert.equal(value.version, '2.2');
  assert.equal(value.fingerprint, config.clientFingerprint);
  assert(Number.isInteger(value.port) && value.port > 0 && value.port <= 65535);
  assert(['http', 'https'].includes(value.protocol));
  if (value.download !== undefined) assert.equal(typeof value.download, 'boolean');
}

async function bytes(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert(size <= 1024 * 1024, 'fixture payload limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(request, response) {
  try {
    assert.equal(request.socket.remoteAddress, '127.0.0.1');
    const clientDer = identityRequired ? request.socket.getPeerCertificate(true)?.raw : undefined;
    const clientFingerprint = clientDer?.length ? sha256(clientDer) : null;
    // Node permits the TLS handshake without a cert. Enforce the official
    // custom/self-signed trust policy here, NOT via an OpenSSL CA/purpose check.
    if (identityRequired && clientFingerprint !== config.clientFingerprint) {
      request.resume();
      reply(response, 403, { error: 'Client identity required' });
      emit('client-rejected', { status: 403, certificatePresent: !!clientDer?.length });
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/localsend/v2/info') {
      reply(response, 200, info);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/localsend/v2/register') {
      checkInfo(JSON.parse(await bytes(request)));
      reply(response, 200, info);
      emit('register', { clientFingerprint });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/localsend/v2/prepare-upload') {
      const body = JSON.parse(await bytes(request));
      checkInfo(body.info);
      const entries = Object.entries(body.files ?? {});
      assert.equal(entries.length, 1, 'one fixture file, not message accept-all');
      const [id, file] = entries[0];
      assert.equal(file.id, id);
      assert.equal(file.fileName, config.fileName);
      assert.equal(file.size, config.size);
      assert.equal(file.fileType, 'text/plain');
      if (file.sha256 != null) assert.equal(file.sha256, config.sha256);
      if (config.pin) assert.equal(url.searchParams.get('pin'), config.pin);
      prepared = { id, file };
      const status = config.mode === 'prepare401' ? 401 : 200;
      reply(response, status, status === 401 ? errorBody : { sessionId: remoteSession, files: { [id]: token } });
      emit('prepare', { status, id, clientFingerprint, infoFingerprint: body.info.fingerprint });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/localsend/v2/upload') {
      assert(prepared, 'upload without prepare');
      assert.equal(url.searchParams.get('sessionId'), remoteSession);
      assert.equal(url.searchParams.get('fileId'), prepared.id);
      assert.equal(url.searchParams.get('token'), token);
      const content = await bytes(request);
      assert.equal(content.length, config.size, 'uploaded size');
      assert.equal(sha256(content), config.sha256, 'uploaded SHA256');
      const status = config.mode === 'upload403' ? 403 : 200;
      reply(response, status, status === 403 ? errorBody : undefined);
      emit('upload', { status, id: prepared.id, size: content.length, sha256: sha256(content), clientFingerprint });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/localsend/v2/cancel') {
      request.resume();
      reply(response, 200);
      return;
    }
    request.resume();
    reply(response, 404);
    emit('fixture-error', { message: 'unexpected method or route' });
  } catch (error) {
    request.resume();
    reply(response, 400, { error: 'Independent literal fixture rejected request' });
    emit('fixture-error', { message: safeError(error) });
  }
}

const server = protocol === 'http' ? http.createServer(handle) : https.createServer({
  key: certificate.private, cert: certificate.cert,
  requestCert: identityRequired, rejectUnauthorized: false,
}, handle);
const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
server.on('tlsClientError', () => emit('tls-handshake-error'));
server.on('clientError', (_error, socket) => socket.destroy());
server.on('error', (error) => { emit('fixture-error', { message: safeError(error) }); process.exitCode = 1; });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
assert.equal(server.address().address, '127.0.0.1');
emit('ready', { port: server.address().port, protocol, fingerprint, info });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const socket of sockets) socket.destroy();
  process.stdin.pause();
}
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
