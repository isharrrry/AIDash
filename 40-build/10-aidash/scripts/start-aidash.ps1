# AIDash 固定启动参数（Windows V1）。
#
# 为什么需要这个脚本：
# AIDASH_DB_PATH 过去靠命令行临时指定，会话一换就丢；默认相对路径又会随
# 启动目录漂移，结果读到另一个空库，看起来像“任务全没了”。
# 这里把 DB / 备份 / 静态产物钉死到仓库内的绝对路径，并在启动前打印出来，
# 让人一眼确认目标文件。令牌只检查是否存在，绝不打印。
[CmdletBinding()]
param(
  [switch]$DryRun,
  [int]$Port = 0,
  # 绑定地址；默认保持回环。跨机访问请同时配置 TLS/反向代理。
  [string]$BindHost = ''
)

$ErrorActionPreference = 'Stop'

# scripts -> 10-aidash -> 40-build -> 仓库根
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$dbPath = Join-Path $repoRoot '40-build/10-aidash/data/aidash.db'
$backupDir = Join-Path $repoRoot '40-build/10-aidash/backups'
$staticDir = Join-Path $repoRoot '40-build/10-aidash/dist/web'
$serverEntry = Join-Path $repoRoot '40-build/10-aidash/dist/server/main.js'

if (-not $env:AIDASH_TOKEN -and $env:AIDASH_PASSPHRASE) {
  Write-Warning 'AIDASH_PASSPHRASE is deprecated; using it as AIDASH_TOKEN.'
  $env:AIDASH_TOKEN = $env:AIDASH_PASSPHRASE
}
if (-not $env:AIDASH_TOKEN) {
  throw 'Set AIDASH_TOKEN as a user environment variable (a short passphrase is fine, >=8 chars), then reopen the terminal; never put secrets in this repository.'
}
if (-not (Test-Path $serverEntry)) {
  throw "Server build not found: $serverEntry. Run 'pnpm -C 40-build build' first."
}

$env:AIDASH_DB_PATH = $dbPath
$env:AIDASH_BACKUP_DIR = $backupDir
$env:AIDASH_STATIC_DIR = $staticDir
if ($Port -gt 0) { $env:AIDASH_PORT = "$Port" }
if ($BindHost) { $env:AIDASH_HOST = $BindHost }

$listenPort = if ($Port -gt 0) {
  $Port
} elseif ($env:AIDASH_PORT) {
  [int]$env:AIDASH_PORT
} else {
  8787
}
$listenHost = if ($env:AIDASH_HOST) { $env:AIDASH_HOST } else { '127.0.0.1' }

Write-Host 'AIDash startup paths (resolved):'
Write-Host "  AIDASH_DB_PATH     = $env:AIDASH_DB_PATH"
Write-Host "  AIDASH_BACKUP_DIR  = $env:AIDASH_BACKUP_DIR"
Write-Host "  AIDASH_STATIC_DIR  = $env:AIDASH_STATIC_DIR"
Write-Host '  auth               = AIDASH_TOKEN'
Write-Host "  listen             = http://${listenHost}:$listenPort"

if ($listenHost -ne '127.0.0.1' -and $listenHost -ne '::1' -and $listenHost -ne 'localhost') {
  Write-Warning "绑定 $listenHost 会允许局域网访问；请使用 TLS/反向代理，并设置足够强的 AIDASH_TOKEN。"
}

if (-not (Test-Path $dbPath)) {
  Write-Warning "Database file does not exist: $dbPath"
  if (Test-Path $backupDir) {
    $backups = @(Get-ChildItem -Path $backupDir -Filter '*.db' -File -ErrorAction SilentlyContinue)
    if ($backups.Count -gt 0) {
      Write-Warning "Found $($backups.Count) backup(s) in $backupDir. The server will refuse to create an empty database unless AIDASH_ALLOW_EMPTY_DB=true."
    }
  }
}

if ($DryRun) {
  Write-Host 'DryRun: paths checked, server not started.'
  exit 0
}

$runnerBin = Join-Path $repoRoot '40-build/20-aidash-runner/bin/aidash-runner.mjs'
Write-Host ''
Write-Host 'Runner quick start (another terminal):'
Write-Host "  node `"$runnerBin`" init --command `"claude --dangerously-skip-permissions -p \\`"Read and execute {task_file}\\`"`" --cwd ."
Write-Host "  node `"$runnerBin`" start --daemon --ensure-channel devhost/myproj/topic --channel-title `"我的话题`" --create-task `"首条任务`""
Write-Host "  node `"$runnerBin`" start --daemon --ensure-channel devhost/myproj/topic   # 回到同一通道"
Write-Host '  (令牌：AIDASH_TOKEN，或 --token-file；完整说明见 20-aidash-runner/README.md)'

Push-Location $repoRoot
try {
  & node $serverEntry
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
