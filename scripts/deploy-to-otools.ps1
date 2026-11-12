# 把插件同步到 otools 主仓库的 plugins/<packid> 目录（本地试跑用）。
# 用法：pwsh -File scripts/deploy-to-otools.ps1 -OtoolsRoot <OTools 主仓库路径>
#   也可设环境变量 OTOOLS_ROOT 代替 -OtoolsRoot 参数。
#
# 只同步「宿主真正需要的」：plugin.json / logo / 构建产物 dist/ 与
# native 库 lib/（plugin.json native.libDir = lib，宿主从插件根的 lib/ 加载）。
# native/、scripts/、docs、dist-pack/ 都留在本仓库，不进插件目录。
param(
  [string]$OtoolsRoot = $env:OTOOLS_ROOT
)

$ErrorActionPreference = "Stop"
if (-not $OtoolsRoot) {
  Write-Error "请用 -OtoolsRoot 指定 OTools 主仓库路径，或设置环境变量 OTOOLS_ROOT。"
}
$pluginRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $pluginRoot "plugin.json") -Raw | ConvertFrom-Json
$packid = $manifest.packid
if (-not $packid) { Write-Error "plugin.json 缺少 packid" }
$target = Join-Path $OtoolsRoot "plugins\$packid"

if (-not (Test-Path (Join-Path $OtoolsRoot "vendor\otools-plugin-sdk\src\index.ts"))) {
  Write-Error "未找到 otools 仓库：$OtoolsRoot（-OtoolsRoot / OTOOLS_ROOT 指向 OTools 主仓库根目录）"
}

if ($manifest.native.enabled -and -not (Test-Path (Join-Path $pluginRoot "lib\Windows.dll"))) {
  Write-Error "plugin.json 启用了 native 但 lib\Windows.dll 不存在 —— 先运行 node scripts/build-native.mjs。"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

# 需要随插件分发的东西：清单、图标、构建产物与 native 库
$ship = @(
  "plugin.json",
  "logo.svg",
  "dist",
  "lib"
)

foreach ($item in $ship) {
  $from = Join-Path $pluginRoot $item
  if (-not (Test-Path $from)) { continue }
  if (Test-Path (Join-Path $target $item)) {
    Remove-Item -LiteralPath (Join-Path $target $item) -Recurse -Force
  }
  Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
}

Write-Host "已同步到 $target"
Write-Host "在 otools 里重载/重启应用即可看到「$($manifest.displayName)」插件。"
