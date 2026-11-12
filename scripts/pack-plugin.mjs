/**
 * 打包 otools-localsend 为 .oplg（otools-ai-switch 同款管线）。
 * 包内：plugin.json（生产清单：去 devUrl/quickDev、native.autoReload=false、
 * 版本号与文件名一致）、logo.svg、许可文件、dist/**、lib/<平台库>。
 *
 * 平台机制（--platform）：
 *   all（默认）→ otools-localsend-<v>.oplg，含全部平台库（市场分发用）
 *   windows    → otools-localsend-<v>-windows.oplg，仅 Windows.dll
 *   macos      → otools-localsend-<v>-macos.oplg，仅 macOS.dylib
 *   linux      → otools-localsend-<v>-linux.oplg，仅 Linux.so
 * 多次打包到同一目录时 SHA256SUMS 按文件合并，过期行自动剔除。
 *
 * 产出 dist-pack/<文件名>.oplg + plugin.json + logo.svg + SHA256SUMS +
 * meta.json（release 工作流按这套扁平结构上传/复验）。
 *
 * 用法：node scripts/pack-plugin.mjs [--out dist-pack] [--version 0.1.0]
 *       [--platform all|windows|macos|linux] [--require-all-platforms]
 * 正式发布必须传 --require-all-platforms，缺少任一平台原生库即拒绝打包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { option, walk, writeZip, validateManifest, validateEntries, PLATFORM_LIBS, requireAllPlatformLibraries } from './package-utils.mjs';

try {
  const root = path.resolve(option('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  const version = option('version', source.version);
  if (!version) throw new Error('No version (pass --version or set plugin.json version)');
  const platform = option('platform', 'all');
  if (platform !== 'all' && !(platform in PLATFORM_LIBS)) {
    throw new Error(`Unknown platform: ${platform} (all|windows|macos|linux)`);
  }
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
  if (process.argv.includes('--require-all-platforms')) requireAllPlatformLibraries(entries);
  if (platform !== 'all') {
    const keep = `lib/${PLATFORM_LIBS[platform]}`;
    for (const name of [...entries.keys()]) {
      if (name.startsWith('lib/') && name !== keep) entries.delete(name);
    }
  }
  const libraries = validateEntries(manifest, entries);
  const suffix = platform === 'all' ? '' : `-${platform}`;
  const filename = `${manifest.packid}-${manifest.version}${suffix}.oplg`;
  const output = path.resolve(root, option('out', 'dist-pack'));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, filename), writeZip([...entries].map(([name, data]) => ({ name, data }))));
  for (const name of ['plugin.json', 'logo.svg']) fs.writeFileSync(path.join(output, name), entries.get(name));
  fs.writeFileSync(
    path.join(output, 'meta.json'),
    `${JSON.stringify({ file: filename, packid: manifest.packid, uuid: manifest.uuid, version: manifest.version, platform, entries: entries.size, nativeLibraries: libraries }, null, 2)}\n`,
  );
  mergeSums(output, [filename, 'plugin.json', 'logo.svg']);
  console.log(`Packaged ${path.join(output, filename)} (platform=${platform}; ${entries.size} files; ${libraries.join(', ')})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

/** SHA256SUMS 按「本次写出的文件」合并：重写同名行，剔除产物已不存在的过期行。 */
function mergeSums(output, names) {
  const sumsPath = path.join(output, 'SHA256SUMS');
  const previous = fs.existsSync(sumsPath)
    ? fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const stale = previous.filter((line) => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) return false;
    const name = match[2];
    return !names.includes(name) && fs.existsSync(path.join(output, name));
  });
  const fresh = names.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex')}  ${name}`);
  fs.writeFileSync(path.join(sumsPath), `${[...stale, ...fresh].join('\n')}\n`);
}
