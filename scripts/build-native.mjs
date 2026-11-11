import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1] || fallback;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'native');
const target = option('target', '');
const profile = option('profile', 'release');
const targetDir = path.resolve(native, process.env.CARGO_TARGET_DIR || 'target');
const args = ['build', '--lib', '--manifest-path', path.join(native, 'Cargo.toml'), '--target-dir', targetDir];
if (profile === 'release') args.push('--release');
else if (profile !== 'debug') args.push('--profile', profile);
if (target) args.push('--target', target);
const result = spawnSync('cargo', args, { cwd: native, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.error(result.error?.message || 'Native build failed');
  process.exit(result.status || 1);
}
const platform = target ? (target.includes('windows') ? 'win32' : target.includes('apple') ? 'darwin' : target.includes('linux') ? 'linux' : '') : process.platform;
const names = {
  win32: ['otools_localsend_native.dll', 'Windows.dll'],
  darwin: ['libotools_localsend_native.dylib', 'macOS.dylib'],
  linux: ['libotools_localsend_native.so', 'Linux.so'],
}[platform];
if (!names) throw new Error(`Unsupported native target: ${target || process.platform}`);
const source = path.join(targetDir, target, profile, names[0]);
const bytes = fs.readFileSync(source);
for (const symbol of ['otools_plugin_invoke', 'otools_plugin_free']) {
  if (!bytes.includes(Buffer.from(symbol))) throw new Error(`Missing native export: ${symbol}`);
}
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.copyFileSync(source, path.join(root, 'lib', names[1]));
console.log(`Staged lib/${names[1]} (${(bytes.length / 1048576).toFixed(2)} MiB)`);
