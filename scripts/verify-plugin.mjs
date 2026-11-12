/**
 * 校验 dist-pack 里的 .oplg 发布包（otools-ai-switch 同款管线）：
 * 清单合法性（uuid==packid==otools-localsend、entry、native.libDir、
 * autostart）、SHA256SUMS 覆盖与匹配、ZIP 结构与 CRC、包内清单/图标一致、
 * 入口资产相对引用 + 宿主桥标记、DLL 导出符号、无开发模式配置、无多余文件。
 *
 * 用法：node scripts/verify-plugin.mjs [dist-pack]（或 --out dist-pack）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { option, readZip, validateManifest, validateEntries } from './package-utils.mjs';

try {
  const root = path.resolve(option('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const positional = process.argv[2];
  const directory = path.resolve(root, option('out', positional && !positional.startsWith('--') ? positional : 'dist-pack'));
  const manifestBytes = fs.readFileSync(path.join(directory, 'plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  validateManifest(manifest);
  if (manifest.devUrl || manifest.quickDev || manifest.native.autoReload) throw new Error('Development settings in production package');
  const filename = `${manifest.packid}-${manifest.version}.oplg`;
  const requiredSums = new Set([filename, 'plugin.json', 'logo.svg']);
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !requiredSums.delete(match[2])) throw new Error('Invalid SHA256 manifest');
    const actual = createHash('sha256').update(fs.readFileSync(path.join(directory, match[2]))).digest('hex');
    if (actual !== match[1]) throw new Error(`SHA256 mismatch: ${match[2]}`);
  }
  if (requiredSums.size) throw new Error('Incomplete SHA256 manifest');
  const entries = readZip(fs.readFileSync(path.join(directory, filename)));
  if (!entries.get('plugin.json')?.equals(manifestBytes)) throw new Error('Packaged manifest mismatch');
  if (!entries.get('logo.svg')?.equals(fs.readFileSync(path.join(directory, 'logo.svg')))) throw new Error('Packaged icon mismatch');
  const libraries = validateEntries(manifest, entries);
  console.log(`Verified ${filename}: ${entries.size} files, CRC and SHA256 valid, bridge marker present, native ${libraries.join(', ')}, panel mode`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
