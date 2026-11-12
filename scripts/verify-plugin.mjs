/**
 * 校验 dist-pack 里的 .oplg 发布包（otools-ai-switch 同款管线）：
 * 清单合法性（uuid==packid==otools-localsend、entry、native.libDir、
 * autostart）、SHA256SUMS 覆盖与匹配、ZIP 结构与 CRC、包内清单/图标一致、
 * 入口资产相对引用 + 宿主桥标记、DLL 导出符号、无开发模式配置、无多余文件。
 *
 * 支持多平台独立包：校验目录里所有 `<packid>-<version>*.oplg`——
 * 通用包（无后缀）至少含一个平台库；带 -windows/-macos/-linux 后缀的包
 * 必须且只能含对应平台库。
 *
 * 用法：node scripts/verify-plugin.mjs [dist-pack]（或 --out dist-pack）
 * 正式发布传 --require-all-platforms，要求三个独立包和含三库的通用包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { option, readZip, validateManifest, validateEntries, PLATFORM_LIBS, requireAllPlatformLibraries } from './package-utils.mjs';

try {
  const root = path.resolve(option('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const positional = process.argv[2];
  const directory = path.resolve(root, option('out', positional && !positional.startsWith('--') ? positional : 'dist-pack'));
  const manifestBytes = fs.readFileSync(path.join(directory, 'plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  validateManifest(manifest);
  if (manifest.devUrl || manifest.quickDev || manifest.native.autoReload) throw new Error('Development settings in production package');
  const archives = fs.readdirSync(directory).filter((name) =>
    name.startsWith(`${manifest.packid}-${manifest.version}`) && name.endsWith('.oplg'));
  if (!archives.length) throw new Error(`No .oplg for ${manifest.packid}-${manifest.version} in ${directory}`);
  const requireAll = process.argv.includes('--require-all-platforms');
  if (requireAll) {
    for (const suffix of ['', ...Object.keys(PLATFORM_LIBS).map((platform) => `-${platform}`)]) {
      const filename = `${manifest.packid}-${manifest.version}${suffix}.oplg`;
      if (!archives.includes(filename)) throw new Error(`Missing release package ${filename}`);
    }
  }

  const requiredSums = new Set([...archives, 'plugin.json', 'logo.svg']);
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error('Invalid SHA256 manifest');
    if (!fs.existsSync(path.join(directory, match[2]))) throw new Error(`Incomplete SHA256 manifest: ${match[2]} missing`);
    if (!requiredSums.delete(match[2])) throw new Error('Invalid SHA256 manifest');
    const actual = createHash('sha256').update(fs.readFileSync(path.join(directory, match[2]))).digest('hex');
    if (actual !== match[1]) throw new Error(`SHA256 mismatch: ${match[2]}`);
  }
  if (requiredSums.size) throw new Error('Incomplete SHA256 manifest');

  for (const filename of archives) {
    const entries = readZip(fs.readFileSync(path.join(directory, filename)));
    if (!entries.get('plugin.json')?.equals(manifestBytes)) throw new Error(`Packaged manifest mismatch: ${filename}`);
    if (!entries.get('logo.svg')?.equals(fs.readFileSync(path.join(directory, 'logo.svg')))) throw new Error(`Packaged icon mismatch: ${filename}`);
    const libraries = validateEntries(manifest, entries);
    const suffix = filename.slice(`${manifest.packid}-${manifest.version}`.length, -'.oplg'.length);
    if (requireAll && suffix === '') requireAllPlatformLibraries(entries);
    if (suffix.startsWith('-')) {
      const expected = PLATFORM_LIBS[suffix.slice(1)];
      if (!expected) throw new Error(`Unknown package platform suffix: ${filename}`);
      if (libraries.length !== 1 || libraries[0] !== `lib/${expected}`) {
        throw new Error(`Platform package ${filename} must contain exactly lib/${expected}`);
      }
    }
    console.log(`Verified ${filename}: ${entries.size} files, CRC and SHA256 valid, bridge marker present, native ${libraries.join(', ')}, panel mode`);
  }
  console.log(`Verified ${archives.length} package(s) for ${manifest.packid} ${manifest.version}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
