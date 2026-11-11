/**
 * 构建插件前端 → dist/（CI 与本地统一的构建入口，Task 10）。
 *
 * 本仓库前端 = vite + react：实际构建交给 package.json 的 build 脚本
 * （tsc && vite build）。没有模板的 trunk/upstream/web 拷贝逻辑。
 *
 * 用法：node scripts/build-web.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// stdin 必须是 'ignore'：某些机器（安全软件挂钩匿名管道）上给子进程接 stdin
// 管道会让 CreateProcess 直接 EBUSY（同模板脚本约定）。
const result = spawnSync('pnpm', ['run', 'build'], {
  stdio: 'inherit',
  cwd: repoRoot,
  // Windows 上 pnpm 是 pnpm.cmd，CreateProcess 不认 .cmd，必须过 shell。
  shell: process.platform === 'win32',
});
if (result.error) {
  console.error(`执行失败：pnpm run build`);
  console.error(result.error.message);
  process.exit(1);
}
const status = result.status ?? 1;
if (status !== 0) {
  console.error('前端构建失败。');
  process.exit(status);
}

// 插件入口自检：plugin.json 的 entry 必须真的存在
const entry = path.join(repoRoot, 'dist', 'index.html');
if (!fs.existsSync(entry)) {
  console.error(`构建产物里没有 ${entry}，但 plugin.json 的 entry 指向它。`);
  process.exit(1);
}

const size = (file) => `${(fs.statSync(file).size / 1048576).toFixed(1)} MB`;
for (const name of fs.readdirSync(path.join(repoRoot, 'dist'))) {
  const file = path.join(repoRoot, 'dist', name);
  if (fs.statSync(file).isFile()) console.log(`  ${name} ${size(file)}`);
}
console.log(`\n完成。${entry} 就绪；预览可跑 node scripts/serve-dist.mjs。`);
