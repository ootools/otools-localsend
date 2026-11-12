/** Packaging checks run in isolated fixtures; never replace the real DLL. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { writeZip, readZip, validateManifest, validateEntries } from './package-utils.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const manifest = {
  packid: 'otools-localsend', uuid: 'otools-localsend', version: '0.1.0',
  entry: 'dist/index.html', openMode: 'panel',
  native: { enabled: true, libDir: 'lib', autoReload: false },
  autostart: { enabled: true, once: true, tasks: [{ command: 'start_localsend', args: {} }] },
};

function fixtureEntries() {
  return new Map([
    ['plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
    ['logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['LICENSE', Buffer.from('Test license fixture')],
    ['THIRD_PARTY_NOTICES.md', Buffer.from('Test notices fixture')],
    ['UPSTREAM.md', Buffer.from('Test provenance fixture')],
    ['LICENSES/sdk-MIT.txt', Buffer.from('Test SDK license fixture')],
    ['dist/index.html', Buffer.from('<script type="module" src="./assets/index.js"></script>')],
    ['dist/assets/index.js', Buffer.from('window.otools&&console.log("bridge")')],
    ['lib/Windows.dll', Buffer.from('MZ\0otools_plugin_invoke\0otools_plugin_free\0')],
  ]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otools-localsend-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, data] of fixtureEntries()) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return root;
}

function run(script, root, ...args) {
  return spawnSync(process.execPath, [path.join(scripts, script), '--root', root, ...args], {
    cwd: scripts, encoding: 'utf8', timeout: 30_000,
  });
}

function output(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function updateSums(out) {
  const names = ['otools-localsend-0.1.0.oplg', 'plugin.json', 'logo.svg'];
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), names.map((name) =>
    `${createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex')}  ${name}`,
  ).join('\n') + '\n');
}

test('ZIP roundtrip preserves all file bytes', () => {
  const entries = fixtureEntries();
  const result = readZip(writeZip([...entries].map(([name, data]) => ({ name, data }))));
  assert.equal(result.size, entries.size);
  for (const [name, bytes] of entries) assert.deepEqual(result.get(name), bytes);
});

test('archive paths reject traversal, absolute paths and duplicates', () => {
  for (const name of ['../evil', 'C:/evil', '/etc/passwd', 'dist/../evil']) {
    assert.throws(() => writeZip([{ name, data: Buffer.from('x') }]), /Invalid archive path/);
  }
  assert.throws(() => writeZip([
    { name: 'a.txt', data: Buffer.from('one') },
    { name: 'a.txt', data: Buffer.from('two') },
  ]), /duplicate/i);
});

test('manifest requires the native receiver and once-only autostart', () => {
  assert.throws(() => validateManifest({ ...manifest, packid: 'other' }), /packid/);
  assert.throws(() => validateManifest({ ...manifest, uuid: 'other' }), /uuid/);
  assert.throws(() => validateManifest({ ...manifest, autostart: undefined }), /autostart/);
  assert.throws(() => validateManifest({ ...manifest, autostart: { ...manifest.autostart, enabled: false } }), /autostart/);
  assert.throws(() => validateManifest({ ...manifest, autostart: { ...manifest.autostart, once: false } }), /autostart/);
  assert.throws(() => validateManifest({ ...manifest, native: { enabled: false, libDir: 'lib' } }), /native/);
});

test('cross-platform packages are valid; zero libraries are not', () => {
  const macOnly = fixtureEntries();
  macOnly.set('lib/macOS.dylib', macOnly.get('lib/Windows.dll'));
  macOnly.delete('lib/Windows.dll');
  const libraries = validateEntries(manifest, macOnly);
  assert.deepEqual(libraries, ['lib/macOS.dylib']);

  const none = fixtureEntries();
  none.delete('lib/Windows.dll');
  assert.throws(() => validateEntries(manifest, none), /native library/i);
});

test('entry bundle needs package-relative assets and the bridge', () => {
  const absolute = fixtureEntries();
  absolute.set('dist/index.html', Buffer.from('<script src="/assets/index.js"></script>'));
  assert.throws(() => validateEntries(manifest, absolute), /package-relative/);
  const missing = fixtureEntries();
  missing.delete('dist/assets/index.js');
  assert.throws(() => validateEntries(manifest, missing), /Missing frontend asset/);
  const noBridge = fixtureEntries();
  noBridge.set('dist/assets/index.js', Buffer.from('console.log(1)'));
  assert.throws(() => validateEntries(manifest, noBridge), /bridge marker/);
});

test('pack then verify produces a production archive without unrelated data', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ ...manifest, devUrl: 'http://127.0.0.1:6497', quickDev: true }));
  fs.writeFileSync(path.join(root, 'user-private-key.pem'), 'must never ship');
  assert.equal(run('pack-plugin.mjs', root).status, 0);
  const checked = run('verify-plugin.mjs', root);
  assert.equal(checked.status, 0, output(checked));
  const out = path.join(root, 'dist-pack');
  const entries = readZip(fs.readFileSync(path.join(out, 'otools-localsend-0.1.0.oplg')));
  assert.ok(entries.has('lib/Windows.dll'));
  assert.ok(entries.has('LICENSES/sdk-MIT.txt'));
  assert.ok(!entries.has('user-private-key.pem'));
  const packaged = JSON.parse(entries.get('plugin.json'));
  assert.equal(packaged.devUrl, undefined);
  assert.equal(packaged.quickDev, undefined);
  assert.equal(packaged.native.autoReload, false);
});

test('verify rejects corrupted SHA256 without trusting metadata', (t) => {
  const root = fixture(t);
  assert.equal(run('pack-plugin.mjs', root).status, 0);
  const file = path.join(root, 'dist-pack', 'otools-localsend-0.1.0.oplg');
  const bytes = fs.readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(file, bytes);
  const result = run('verify-plugin.mjs', root);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /SHA256 mismatch/);
});

test('verify rejects a corrupt ZIP CRC even after checksums are recomputed', (t) => {
  const root = fixture(t);
  assert.equal(run('pack-plugin.mjs', root).status, 0);
  const out = path.join(root, 'dist-pack');
  const filename = path.join(out, 'otools-localsend-0.1.0.oplg');
  const bytes = fs.readFileSync(filename);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  bytes[central + 16] ^= 0xff;
  fs.writeFileSync(filename, bytes);
  updateSums(out);
  const result = run('verify-plugin.mjs', root);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /ZIP CRC\/size mismatch/);
});

test('verify rejects a missing native DLL even with a valid ZIP and checksums', (t) => {
  const root = fixture(t);
  assert.equal(run('pack-plugin.mjs', root).status, 0);
  const out = path.join(root, 'dist-pack');
  const filename = path.join(out, 'otools-localsend-0.1.0.oplg');
  const entries = readZip(fs.readFileSync(filename));
  entries.delete('lib/Windows.dll');
  fs.writeFileSync(filename, writeZip([...entries].map(([name, data]) => ({ name, data }))));
  updateSums(out);
  const result = run('verify-plugin.mjs', root);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /native library/i);
});

test('pack rejects missing ABI symbols without modifying the actual build', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'lib', 'Windows.dll'), 'MZ invalid plugin');
  const result = run('pack-plugin.mjs', root);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /otools_plugin_invoke/);
});

test('pack --platform filters libraries and names the archive per platform', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'lib', 'macOS.dylib'), Buffer.from('MZ\0otools_plugin_invoke\0otools_plugin_free\0'));
  fs.writeFileSync(path.join(root, 'lib', 'Linux.so'), Buffer.from('ELF\0otools_plugin_invoke\0otools_plugin_free\0'));

  assert.equal(run('pack-plugin.mjs', root, '--platform', 'macos').status, 0);
  assert.equal(run('pack-plugin.mjs', root, '--platform', 'windows').status, 0);
  assert.equal(run('pack-plugin.mjs', root, '--platform', 'linux').status, 0);
  assert.equal(run('pack-plugin.mjs', root).status, 0); // universal

  const read = (name) => readZip(fs.readFileSync(path.join(root, 'dist-pack', name)));
  const macos = read('otools-localsend-0.1.0-macos.oplg');
  assert.ok(macos.has('lib/macOS.dylib'));
  assert.ok(!macos.has('lib/Windows.dll') && !macos.has('lib/Linux.so'));
  const windows = read('otools-localsend-0.1.0-windows.oplg');
  assert.ok(windows.has('lib/Windows.dll') && !windows.has('lib/macOS.dylib'));
  const universal = read('otools-localsend-0.1.0.oplg');
  for (const lib of ['lib/Windows.dll', 'lib/macOS.dylib', 'lib/Linux.so']) {
    assert.ok(universal.has(lib), `${lib} missing from universal package`);
  }

  // 目录校验：三个独立包 + 通用包全部过验，SHA256SUMS 覆盖所有包
  const checked = run('verify-plugin.mjs', root);
  assert.equal(checked.status, 0, output(checked));
  assert.match(output(checked), /Verified 4 package/);

  // 任一包缺失（SHA256SUMS 未覆盖）→ 拒绝
  fs.rmSync(path.join(root, 'dist-pack', 'otools-localsend-0.1.0-linux.oplg'));
  const failed = run('verify-plugin.mjs', root);
  assert.notEqual(failed.status, 0);
  assert.match(output(failed), /Incomplete SHA256 manifest/);
});

test('pack rejects an unknown platform selector', (t) => {
  const root = fixture(t);
  const result = run('pack-plugin.mjs', root, '--platform', 'freebsd');
  assert.notEqual(result.status, 0);
  assert.match(output(result), /Unknown platform/);
});

test('pack rejects unexpected native-directory contents instead of shipping secrets', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'lib', 'key.pem'), 'private key');
  const result = run('pack-plugin.mjs', root);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /Unexpected packaged file/);
});
