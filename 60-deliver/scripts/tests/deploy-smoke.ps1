<#
.SYNOPSIS
deploy.ps1 冒烟测试：只验证失败路径的行为，不碰真实服务、真实端口与真实数据库。

.DESCRIPTION
覆盖 5C 审查（50-verify/代码审查报告.md §4-D）提出的三条高风险缺陷：
  1. 启动后失败必须停掉本次启动的进程；
  2. -DryRun 必须零副作用（不建目录、不写锁、不采指标基线）；
  3. 端口被未确认的监听者占用时，不得把 Authorization 发给它。

做法：在临时目录里造一个「假仓库」——只有 deploy.ps1 预检需要的最小结构，
dist/server/main.js 是一个假服务端。用 -SkipBuild 跳过真实构建，端口由内核分配，
因此不会停任何现有服务，也不会碰 8787 与真实库。

用法：powershell -NoProfile -File .\60-deliver\scripts\tests\deploy-smoke.ps1
退出码：0 = 全部通过；1 = 有失败。
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Failures = @()
$script:Passed = 0
$script:Children = @()
$script:TempRoots = @()

# ---------------------------------------------------------------------------
# 断言与输出
# ---------------------------------------------------------------------------
function Write-Case([string]$Name) {
  Write-Host ''
  Write-Host "== $Name ==" -ForegroundColor Cyan
}

function Add-Failure([string]$Message) {
  Write-Host "   [FAIL] $Message" -ForegroundColor Red
  $script:Failures += $Message
}

function Assert-True([bool]$Condition, [string]$Message) {
  if ($Condition) {
    Write-Host "   [OK] $Message" -ForegroundColor Green
    $script:Passed++
  } else {
    Add-Failure $Message
  }
}

# ---------------------------------------------------------------------------
# 基础设施
# ---------------------------------------------------------------------------

# 让内核分配一个空闲端口。close 到真正使用之间有极小窗口会被抢，
# 抢到的表现是 EADDRINUSE，测试会直接失败，不会误判为通过。
function New-FreePort {
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
  $listener.Start()
  try {
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Wait-ListeningPort([int]$Port, [int]$TimeoutSeconds = 10) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $client.Connect('127.0.0.1', $Port)
      return $true
    } catch {
      Start-Sleep -Milliseconds 100
    } finally {
      $client.Close()
    }
  }
  return $false
}

# 在临时目录里造一个假仓库。只满足 deploy.ps1 预检需要的东西：
# package.json、node_modules、dist/server/main.js。真库、真备份、真静态文件一概没有。
function New-FakeRepo {
  $root = Join-Path $env:TEMP ("aidash-deploy-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $build = Join-Path $root '40-build'
  $serverDir = Join-Path $build '10-aidash/dist/server'
  New-Item -ItemType Directory -Force -Path $serverDir, (Join-Path $build 'node_modules') | Out-Null
  Set-Content -Path (Join-Path $build 'package.json') -Value '{ "name": "fake-aidash" }' -Encoding ASCII
  $script:TempRoots += $root
  return $root
}

function Start-NodeProcess([string]$ScriptPath, [string[]]$NodeArgs = @()) {
  # 路径统一加引号：Start-Process 不会替我们处理含空格的参数。
  $argList = @('"' + $ScriptPath + '"') + $NodeArgs
  $proc = Start-Process -FilePath 'node' -ArgumentList $argList -PassThru -WindowStyle Hidden
  $script:Children += $proc
  return $proc
}

function Read-DeployOutput([string]$Path) {
  $text = ''
  foreach ($file in @($Path, "$Path.err")) {
    if (Test-Path $file) { $text += (Get-Content -Raw -Path $file -ErrorAction SilentlyContinue) }
  }
  return $text
}

# 跑一次 deploy.ps1。-Wait 保证返回时子进程已退出，退出码可断言。
function Invoke-Deploy([string]$FakeRoot, [string[]]$ExtraArgs, [string]$OutputFile) {
  $argList = @('-NoProfile', '-File', ('"' + $script:DeployScript + '"'),
    '-RepoRoot', ('"' + $FakeRoot + '"')) + $ExtraArgs
  $proc = Start-Process -FilePath $script:PowerShellExe -ArgumentList $argList -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $OutputFile -RedirectStandardError "$OutputFile.err"
  return $proc.ExitCode
}

# 假服务端：/healthz 故意报告一个与部署目标不同的 db_path。
# 这样能走到「进程活着、但连的库不对」这条最危险的失败分支，
# 用来验证 Fail-Step 会不会把本次启动的进程停掉。
$script:HealthServerSource = @'
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.AIDASH_PORT);
// deploy.ps1 失败时会删掉自己的 pid 文件，测试只能靠这份副本拿到「本应已被杀掉」的 PID。
fs.writeFileSync(path.join(__dirname, 'fake-server.pid'), String(process.pid));

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/healthz') {
    res.end(JSON.stringify({ ok: true, status: 'ok', db_path: 'C:\\wrong\\aidash.db' }));
    return;
  }
  res.end(JSON.stringify({ ok: true, data: { status: 'ok', audit_chain: { ok: true } } }));
});
server.listen(port, '127.0.0.1');
'@

# 冒充「端口被别的程序占用」的 node 进程：把收到的请求连同 Authorization 头记下来。
# 测试断言这个日志里永远不出现 Bearer —— 部署脚本不该把令牌发给未确认的监听者。
$script:ForeignListenerSource = @'
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2]);
const record = path.join(__dirname, 'listener.log');
const server = http.createServer((req, res) => {
  fs.appendFileSync(record, JSON.stringify({
    url: req.url,
    authorization: req.headers.authorization || null,
  }) + '\n');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, status: 'ok', db_path: process.cwd() }));
});
server.listen(port, '127.0.0.1');
'@

# ---------------------------------------------------------------------------
# 场景
# ---------------------------------------------------------------------------

function Test-FailureKillsStartedProcess {
  Write-Case '场景 1/4：启动后健康检查失败 → 本次启动的进程必须被停掉'

  $root = New-FakeRepo
  $serverDir = Join-Path $root '40-build/10-aidash/dist/server'
  Set-Content -Path (Join-Path $serverDir 'main.js') -Value $script:HealthServerSource -Encoding UTF8

  $port = New-FreePort
  $out = Join-Path $root 'deploy.out.log'
  $exit = Invoke-Deploy $root @('-SkipBuild', '-Port', "$port", '-HealthTimeoutSeconds', '10') $out

  $fakePidFile = Join-Path $serverDir 'fake-server.pid'
  if (-not (Test-Path $fakePidFile)) {
    Add-Failure "假服务没有启动（找不到 $fakePidFile）。部署输出：`n$(Read-DeployOutput $out)"
    return
  }
  $fakePid = [int]((Get-Content -Raw -Path $fakePidFile).Trim())

  Assert-True ($exit -eq 1) "部署以退出码 1 结束（实际 $exit）"
  # taskkill 是异步的：进程退出与命令返回之间有一小段窗口，等半秒再断言。
  Start-Sleep -Milliseconds 500
  Assert-True (-not (Get-Process -Id $fakePid -ErrorAction SilentlyContinue)) `
    "失败路径结束后 PID $fakePid 已不在"
  Assert-True (-not (Test-Path (Join-Path $root '40-build/10-aidash/data/aidash.pid'))) `
    '部署留下的 aidash.pid 已被清理'
}

function Test-DryRunHasNoSideEffects {
  Write-Case '场景 2/4：-DryRun 零副作用'

  $root = New-FakeRepo
  $serverDir = Join-Path $root '40-build/10-aidash/dist/server'
  Set-Content -Path (Join-Path $serverDir 'main.js') -Value $script:HealthServerSource -Encoding UTF8

  $port = New-FreePort
  $out = Join-Path $root 'deploy.out.log'
  $exit = Invoke-Deploy $root @('-SkipBuild', '-DryRun', '-Port', "$port") $out

  $dataDir = Join-Path $root '40-build/10-aidash/data'
  $backupDir = Join-Path $root '40-build/10-aidash/backups'

  Assert-True ($exit -eq 0) "DryRun 以退出码 0 结束（实际 $exit）"
  Assert-True (-not (Test-Path $dataDir)) 'DryRun 没有创建 data/ 目录'
  Assert-True (-not (Test-Path $backupDir)) 'DryRun 没有创建 backups/ 目录'
  # data 目录不存在时锁也必然不存在；这一条是给「以后有人把建目录挪回去」留的护栏。
  Assert-True (-not (Test-Path (Join-Path $dataDir 'deploy.lock'))) 'DryRun 没有留下部署锁'
}

function Test-NoTokenSentToUnconfirmedListener {
  Write-Case '场景 3/4：端口被未确认的监听者占用 → 不得发送 Authorization'

  $root = New-FakeRepo
  $listenerPath = Join-Path $root 'foreign-listener.js'
  Set-Content -Path $listenerPath -Value $script:ForeignListenerSource -Encoding UTF8

  $port = New-FreePort
  $listener = Start-NodeProcess $listenerPath @("$port")
  if (-not (Wait-ListeningPort $port 10)) {
    Add-Failure '冒充的监听者没有起来，无法继续场景 3'
    return
  }

  $out = Join-Path $root 'deploy.out.log'
  $exit = Invoke-Deploy $root @('-SkipBuild', '-Port', "$port") $out

  $requestLog = Join-Path $root 'listener.log'
  $requests = @()
  if (Test-Path $requestLog) {
    $requests = @(Get-Content -Path $requestLog | Where-Object { $_.Trim() })
  }
  $withAuth = @($requests | Where-Object { $_ -match 'Bearer' })

  Assert-True ($exit -eq 1) "部署在确认监听者身份前中止（退出码 $exit）"
  Assert-True (-not $listener.HasExited) '部署没有误杀未确认的监听进程'
  # 比「有没有 Bearer 头」更强的断言：一个请求都不该发。
  Assert-True ($requests.Count -eq 0) `
    "未确认的监听者没有收到任何请求（实际 $($requests.Count) 次，其中带 Bearer 的 $($withAuth.Count) 次）"
}

function Test-MissingDbWithBackupsAbortsBeforeStopping {
  Write-Case '场景 4/4：库没了但备份还在 → 停服前中止，服务不受影响'

  $root = New-FakeRepo
  $serverDir = Join-Path $root '40-build/10-aidash/dist/server'
  Set-Content -Path (Join-Path $serverDir 'main.js') -Value $script:HealthServerSource -Encoding UTF8
  # 模拟路径漂移现场：data/ 下没有库，backups/ 里有一个旧的 .db。
  $backupDir = Join-Path $root '40-build/10-aidash/backups'
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Set-Content -Path (Join-Path $backupDir 'aidash-deploy-2026.db') -Value 'placeholder' -Encoding ASCII

  # 先起一个“正在运行的服务”。命令行同时含假仓库根与 dist/server/main.js，正好符合
  # 部署脚本收紧后的 AIDash 身份判断；如果预检没挡住，部署会把它停掉——这条用例就是用来抓这个的。
  $port = New-FreePort
  $savedPort = $env:AIDASH_PORT
  $env:AIDASH_PORT = "$port"
  $running = Start-NodeProcess (Join-Path $serverDir 'main.js')
  $env:AIDASH_PORT = $savedPort
  if (-not (Wait-ListeningPort $port 10)) {
    Add-Failure '预置的“运行中服务”没有起来，无法继续场景 4'
    return
  }

  $out = Join-Path $root 'deploy.out.log'
  $exit = Invoke-Deploy $root @('-SkipBuild', '-Port', "$port") $out
  $text = Read-DeployOutput $out

  Assert-True ($exit -eq 1) "部署以退出码 1 结束（实际 $exit）"
  Assert-True ($text -match '数据库不存在或为空') '失败原因指向库缺失，而不是构建/启动步骤'
  Assert-True (-not $running.HasExited) '部署没有停掉正在运行的服务'
  Assert-True (-not (Test-Path (Join-Path $root '40-build/10-aidash/data/deploy.lock'))) `
    '预检中止发生在写部署锁之前'
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$script:DeployScript = Join-Path $repoRoot '60-deliver/scripts/deploy.ps1'

if (-not (Test-Path $script:DeployScript)) {
  Write-Host "[FAIL] 找不到 deploy.ps1：$($script:DeployScript)" -ForegroundColor Red
  exit 1
}

foreach ($commandName in @('node', 'pnpm', 'taskkill')) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    Write-Host "[FAIL] 缺少命令：$commandName。deploy.ps1 的预检会因此失败，冒烟无法进行。" -ForegroundColor Red
    exit 1
  }
}

$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
$script:PowerShellExe = if ($pwsh) { $pwsh.Source } else { (Get-Command powershell.exe).Source }

# 测试只碰临时目录：把可能影响部署路径/端口的用户环境变量钉死，避免测试结果随机器变化。
# 令牌用一个明显假的固定值，不会连到任何真实服务。
$savedEnv = @{}
foreach ($key in @('AIDASH_TOKEN', 'AIDASH_HOST', 'AIDASH_PORT')) {
  $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
$env:AIDASH_TOKEN = 'smoke-token-not-a-real-secret'
$env:AIDASH_HOST = '127.0.0.1'
Remove-Item Env:\AIDASH_PORT -ErrorAction SilentlyContinue

Write-Host "deploy.ps1 冒烟测试：$($script:DeployScript)"
Write-Host "使用 PowerShell：$($script:PowerShellExe)"

try {
  Test-FailureKillsStartedProcess
  Test-DryRunHasNoSideEffects
  Test-NoTokenSentToUnconfirmedListener
  Test-MissingDbWithBackupsAbortsBeforeStopping
} finally {
  foreach ($child in $script:Children) {
    if ($child -and -not $child.HasExited) {
      & taskkill /PID $child.Id /T /F 2>&1 | Out-Null
    }
  }
  foreach ($root in $script:TempRoots) {
    Remove-Item -Path $root -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($key in $savedEnv.Keys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process')
  }
}

Write-Host ''
if ($script:Failures.Count -gt 0) {
  Write-Host ("结果：{0} 通过，{1} 失败" -f $script:Passed, $script:Failures.Count) -ForegroundColor Red
  foreach ($failure in $script:Failures) { Write-Host "   - $failure" -ForegroundColor Red }
  exit 1
}
Write-Host ("结果：{0} 项断言全部通过" -f $script:Passed) -ForegroundColor Green
exit 0
