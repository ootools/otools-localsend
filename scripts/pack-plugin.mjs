/**
 * 打包 otools-localsend 为 .oplg（otools-ai-switch 同款管线）。
 * 包内：plugin.json（生产清单：去 devUrl/quickDev、native.autoReload=false、
 * 版本号与文件名一致）、logo.svg、许可文件、dist/**、lib/Windows.dll。
 * 产出 dist-pack/<packid>-<version>.oplg + plugin.json + logo.svg +
 * SHA256SUMS + meta.json（release 工作流按这套扁平结构上传/复验）。
 *
 * 用法：node scripts/pack-plugin.mjs [--out dist-pack] [--version 0.1.0]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { option, walk, writeZip, validateManifest, validateEntries } from './package-utils.mjs';

try {
  const root = path.resolve(option('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  const version = option('version', source.version);
  if (!version) throw new Error('No version (pass --version or set plugin.json version)');
  const manifest = { ...source, version, native: { ...source.native, autoReload: false } };
  delete manifest.devUrl;
  delete manifest.quickDev;
  validateManifest(manifest);
  const entries = new Map([['plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]);
  for (const name of ['logo.svg', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM.md']) {
    if (fs.existsSync(path.join(root, name))) entries.set(name, fs.readFileSync(path.join(root, name)));
  }
  for (const directory of ['dist', 'lib', 'LICENSES']) {
    const full = path.join(root, directory);
    if (!fs.existsSync(full)) continue;
    for (const relative of walk(full)) entries.set(`${directory}/${relative}`, fs.readFileSync(path.join(full, relative)));
  }
  const libraries = validateEntries(manifest, entries);
  const filename = `${manifest.packid}-${manifest.version}.oplg`;
  const output = path.resolve(root, option('out', 'dist-pack'));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, filename), writeZip([...entries].map(([name, data]) => ({ name, data }))));
  for (const name of ['plugin.json', 'logo.svg']) fs.writeFileSync(path.join(output, name), entries.get(name));
  const sums = [filename, 'plugin.json', 'logo.svg'].map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex')}  ${name}`);
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  const meta = {
    file: filename,
    packid: manifest.packid,
    uuid: manifest.uuid,
    version: manifest.version,
    entries: entries.size,
    nativeLibraries: libraries,
  };
  fs.writeFileSync(path.join(output, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Packaged ${path.join(output, filename)} (${entries.size} files; ${libraries.join(', ')})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
