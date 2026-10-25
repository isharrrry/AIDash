# AIDash 部署脚本（Windows / PowerShell 5.1+）
#
# 为什么单独写一个脚本，而不是改 start-aidash.ps1：
# - start-aidash.ps1 只负责“启动”，而且以前台方式运行，不能停服务、不能备份、不能回滚；
# - 交付要求是“停服务 -> 备份 DB -> 构建 -> 启动 -> 健康检查”，任一环节失败都要停；
# - start-aidash.ps1 必须保持原样（UTF-8 with BOM，可能被其它流程引用），本脚本不调用、不修改它。
#
# 幂等性（重复执行不会损坏数据）：
# - 停止：端口没有监听进程时直接跳过；
# - 备份：每次生成带毫秒时间戳的新文件，绝不覆盖旧备份；
# - 构建：每次都重新编译，产物由源码决定；
# - 启动：先停再起，重复执行不会产生第二个实例；
# - 数据：先停服再备份，备份走 SQLite Backup API，不直接拷 .db 文件。
#
# 本脚本不会：安装依赖、执行测试、修改源码、停/起除本仓库 AIDash 之外的服务。
[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$RepoRoot = '',
  [ValidateRange(1, 365)][int]$KeepBackups = 7,
  [ValidateRange(5, 300)][int]$HealthTimeoutSeconds = 30,
  [switch]$SkipBuild,
  [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Fail-Step 会用到锁文件与「本次启动的进程」；先初始化，避免预检阶段失败时访问未定义变量。
$script:LockFile = $null
# 本次部署启动的服务进程。正常成功时保持存活（那是交付目标）；
# 之后任何一步失败都必须先把它停掉，见 Stop-StartedProcess。
$script:StartedProcess = $null
$script:StartedPidFile = $null

# 统一输出：每一步都打印“做了什么”，失败时打印“为什么停、下一步去哪查”。
function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Write-Done([string]$Message) {
  Write-Host "   [OK] $Message" -ForegroundColor Green
}

function Write-Info([string]$Message) {
  Write-Host "   $Message"
}

# 停掉本次部署启动的服务进程（含子进程）。
#
# 为什么必须有这个函数：部署在「启动之后」才失败的几条路径（db_path 不一致、
# 健康检查超时、审计链断裂、/api/health 非 ok）是最危险的 —— 脚本报失败、服务却在跑，
# 还可能连着错的库。修复前 Fail-Step 只删锁就 exit，把服务留在了运行状态，
# 与脚本自己打印的「不要把这个服务留在运行状态」正好相反。
function Stop-StartedProcess() {
  if (-not $script:StartedProcess) { return }

  $startedPid = $script:StartedProcess.Id
  $script:StartedProcess = $null

  # 整段兜住：这个函数是从 Fail-Step 里调的，如果它自己抛异常会再次触发 trap →
  # 又回到 Fail-Step，形成递归。失败时只告警，并给出可手工执行的命令。
  try {
    if (Get-Process -Id $startedPid -ErrorAction SilentlyContinue) {
      Write-Host "   正在停止本次启动的服务进程 PID $startedPid（含子进程）..." -ForegroundColor Yellow
      # 与停止旧进程用同一套 taskkill /T /F，理由见第 1 步里的注释
      # （Windows 上 Node 收不到 SIGTERM；/T 防孤儿进程占端口）。
      & taskkill /PID $startedPid /T /F 2>&1 | ForEach-Object { Write-Host "   $_" }
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 128) {
        Write-Host "   [WARN] 自动停止失败（taskkill 退出码 $LASTEXITCODE）。请手工执行：taskkill /PID $startedPid /T /F" -ForegroundColor Yellow
      }
    }

    # 进程已经不在时也要删 pid 文件：留着一个指向不存在 PID 的文件，会误导下一次部署。
    if ($script:StartedPidFile) {
      Remove-Item -Path $script:StartedPidFile -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Host "   [WARN] 停止本次启动的进程失败：$($_.Exception.Message)。请手工执行：taskkill /PID $startedPid /T /F" -ForegroundColor Yellow
  }
}

function Fail-Step([string]$Message, [string]$Hint = '') {
  Write-Host "   [FAIL] $Message" -ForegroundColor Red
  if ($Hint) {
    Write-Host "   处置：$Hint" -ForegroundColor Yellow
  }
  Write-Host '   已停止执行：后续步骤不会继续。修复后可直接重跑本脚本（幂等）。' -ForegroundColor Yellow
  # 先停进程再删锁：万一停进程很慢，锁仍然挡着第二个部署进场，顺序反过来就有空隙。
  Stop-StartedProcess
  if ($script:LockFile -and (Test-Path $script:LockFile)) {
    Remove-Item -Path $script:LockFile -Force -ErrorAction SilentlyContinue
  }
  exit 1
}

# 兜底：任何未显式检查的终止性错误也要走统一出口，而不是把半截状态留在那里。
trap {
  Fail-Step "未预期的错误：$($_.Exception.Message)" '看上面的 PowerShell 报错与日志；修复后重跑（脚本是幂等的）。'
}

function Show-LogTail([string]$Path, [int]$Lines = 30) {
  if (-not (Test-Path $Path)) { return }
  Write-Host "   --- $Path（最后 $Lines 行）---" -ForegroundColor Yellow
  Get-Content -Path $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "   $_"
  }
}

# 端口监听者查询：优先用 Get-NetTCPConnection；模块缺失或无权限时退回 netstat。
# 只读操作，不会改任何状态。
function Get-ListeningProcessIds([int]$LocalPort) {
  try {
    $connections = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction Stop)
    $ids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    return $ids
  } catch {
    # 走下面的 netstat 兜底。
  }

  $ids = @()
  $lines = @(& netstat -ano | Select-String -Pattern ":$LocalPort\s")
  foreach ($line in $lines) {
    $parts = @(($line.ToString().Trim() -split '\s+'))
    if ($parts.Length -ge 5 -and $parts[3] -eq 'LISTENING') {
      $ids += [int]$parts[4]
    }
  }
  return @($ids | Where-Object { $_ -gt 0 } | Select-Object -Unique)
}

# 路径比较前的统一整形：反斜杠换成正斜杠，再转小写。
# Windows 命令行里的路径大小写、`\` 与 `/` 都可以混用；不统一就会出现
# “明明是同一个仓库却认不出来”，或者更糟：把别的目录误认成本仓库。
function ConvertTo-NormalizedPathText([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  return ($Text -replace '\\', '/').ToLowerInvariant()
}

# 判定一个 PID 是不是「本仓库的 AIDash」。只读，不做任何动作。
# 返回值 kind：
#   gone    —— 进程已经不在；
#   foreign —— 是 node，但命令行不含 dist/server/main.js（不是 AIDash 入口）；
#   unknown —— 取不到命令行，或含 AIDash 入口但不在本仓库根下，无法确认；
#   aidash  —— node 且同时命中入口路径与本仓库根。
#
# 为什么不再用 pid 文件单独“认领”进程：pid 文件可能残留，也可能被别的启动方式
# 覆盖；只凭它匹配 PID 就停止，会重新引入误杀风险。现在 pid 文件只用于“找候选”，
# 真正的身份必须由真实命令行同时证明入口和仓库根。
#
# 为什么把「判定」和「处置」拆开：停旧进程时必须失败即停（Assert-AidashProcess），
# 而采集指标基线只是顺带做的事 —— 遇到不认识的监听者应该跳过、不发令牌，
# 而不是把整个部署中止掉。
function Get-AidashProcessInfo([int]$TargetPid) {
  $process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $process) { return @{ kind = 'gone'; name = ''; commandLine = ''; reason = '' } }
  if ($process.ProcessName -ne 'node') {
    return @{ kind = 'foreign'; name = $process.ProcessName; commandLine = ''; reason = 'not-node' }
  }

  $commandLine = ''
  try {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid" -ErrorAction Stop
    if ($cim -and $cim.CommandLine) { $commandLine = [string]$cim.CommandLine }
  } catch {
    $commandLine = ''
  }

  if (-not $commandLine) {
    return @{ kind = 'unknown'; name = 'node'; commandLine = ''; reason = 'no-command-line' }
  }

  $normalizedCommandLine = ConvertTo-NormalizedPathText $commandLine
  if ($normalizedCommandLine -notmatch 'dist/server/main\.js') {
    return @{ kind = 'foreign'; name = 'node'; commandLine = $commandLine; reason = 'not-aidash-entry' }
  }

  # 末端 / 防止 AIDash-old、AIDash2 这类同前缀目录被误认成本仓库。
  $normalizedRepoRoot = (ConvertTo-NormalizedPathText $RepoRoot).TrimEnd('/')
  if (-not $normalizedRepoRoot -or -not $normalizedCommandLine.Contains("$normalizedRepoRoot/")) {
    return @{
      kind = 'unknown'
      name = 'node'
      commandLine = $commandLine
      reason = 'main-entry-outside-repo'
    }
  }

  return @{ kind = 'aidash'; name = 'node'; commandLine = $commandLine; reason = '' }
}

# 停旧进程前的硬校验：只允许停“确实是本仓库 AIDash”的 node 进程。
# 宁可失败，也不误杀别的 Node 应用。
function Assert-AidashProcess([int]$TargetPid) {
  $info = Get-AidashProcessInfo $TargetPid
  switch ($info.kind) {
    'gone' { return $false }
    'foreign' {
      if ($info.name -ne 'node') {
        Fail-Step "端口 $Port 被非 node 进程占用：$($info.name)（PID $TargetPid）。" `
          '本脚本不会杀非 node 进程。先确认占用者是什么；换端口用 -Port，或停掉该程序后重跑。'
      }
      Fail-Step "PID $TargetPid 是 node，但命令行不像 AIDash：$($info.commandLine)" `
        '先确认它不是别的 Node 应用；本脚本不做“端口被占就杀”的冒险动作。'
    }
    'unknown' {
      if ($info.reason -eq 'main-entry-outside-repo') {
        Fail-Step "PID $TargetPid 的命令行包含 dist/server/main.js，但不在本仓库根 $RepoRoot 下；疑似不是本仓库进程，请手工确认。" `
          '已中止部署，未停止任何进程。本脚本只停止同时匹配本仓库根与入口路径的 node 进程；确认占用者后手工结束，或换 -Port。'
      }
      Fail-Step "无法确认 PID $TargetPid 是不是本仓库 AIDash（取不到命令行）。" `
        '已中止部署，未停止任何进程。手工确认并结束该进程后重跑；脚本不会冒险杀未知进程。'
    }
    default {
      Fail-Step "PID $TargetPid 的身份判断返回未知状态（$($info.kind)）。" `
        '已中止部署，未停止任何进程。请检查脚本版本或手工确认该 PID；身份守卫不得失败开放。'
    }
  }
  return $true
}

# ---------------------------------------------------------------------------
# 0. 预检：所有检查都在“停服务”之前完成，避免发现环境不合格时已经把服务停了。
# ---------------------------------------------------------------------------
Write-Step '0/6 预检'

if (-not $RepoRoot) {
  # $PSScriptRoot = <仓库根>/60-deliver/scripts，上两级就是仓库根。
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
} else {
  $RepoRoot = (Resolve-Path -Path $RepoRoot).Path
}

$buildRoot   = Join-Path $RepoRoot '40-build'
$packageJson = Join-Path $buildRoot 'package.json'
$dataDir     = Join-Path $buildRoot '10-aidash/data'
$dbPath      = Join-Path $dataDir 'aidash.db'
$backupDir   = Join-Path $buildRoot '10-aidash/backups'
$releaseDir  = Join-Path $backupDir 'releases'
$logDir      = Join-Path $dataDir 'logs'
$distDir     = Join-Path $buildRoot '10-aidash/dist'
$serverEntry = Join-Path $distDir 'server/main.js'
$staticDir   = Join-Path $distDir 'web'
$pidFile     = Join-Path $dataDir 'aidash.pid'
$lockFile    = Join-Path $dataDir 'deploy.lock'
$backupHelper = Join-Path $PSScriptRoot 'backup-db.mjs'

if (-not (Test-Path $packageJson)) {
  Fail-Step "找不到 $packageJson。" '确认 -RepoRoot 指向 AIDash 仓库根（包含 40-build 的那一层）。'
}

foreach ($commandName in @('node', 'pnpm', 'taskkill')) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    Fail-Step "缺少命令：$commandName。" '安装 Node >= 24 与 pnpm 12.x，并确保它们在 PATH 里。'
  }
}

[string]$nodeVersion = (& node --version | Select-Object -First 1)
$nodeMajor = 0
[void][int]::TryParse(($nodeVersion.TrimStart('v') -split '\.')[0], [ref]$nodeMajor)
if ($nodeMajor -lt 24) {
  Fail-Step "Node 版本是 $nodeVersion，低于要求的 >= 24。" '升级 Node 后重跑；服务端使用 Node 24 的 ESM 与原生依赖。'
}

if (-not (Test-Path (Join-Path $buildRoot 'node_modules'))) {
  Fail-Step '40-build/node_modules 不存在。' `
    '先在仓库根执行 pnpm -C 40-build install --frozen-lockfile。本脚本刻意不自动联网安装，避免部署时引入不可控版本。'
}

if (-not $env:AIDASH_TOKEN -or [string]::IsNullOrWhiteSpace($env:AIDASH_TOKEN)) {
  Fail-Step 'AIDASH_TOKEN 未设置。' `
    '先在环境变量里设置（令牌值不要写进仓库、脚本、卡片或日志），然后重开终端再执行。'
}

if (-not (Test-Path $backupHelper)) {
  Fail-Step "找不到备份助手：$backupHelper。" '确认 60-deliver/scripts/backup-db.mjs 与 deploy.ps1 在同一目录。'
}

if ($Port -le 0) {
  if ($env:AIDASH_PORT) {
    $parsedPort = 0
    if (-not [int]::TryParse($env:AIDASH_PORT, [ref]$parsedPort)) {
      Fail-Step "AIDASH_PORT 不是合法整数：$($env:AIDASH_PORT)。" '改成 1~65535 的整数，或删掉该环境变量用默认 8787。'
    }
    $Port = $parsedPort
  } else {
    $Port = 8787
  }
}
if ($Port -lt 1 -or $Port -gt 65535) {
  Fail-Step "端口不合法：$Port。" '端口必须在 1~65535 之间。'
}

$hostAddress = if ($env:AIDASH_HOST) { $env:AIDASH_HOST } else { '127.0.0.1' }
# 监听 0.0.0.0/:: 时，探活要显式打回环地址；否则请求会发到一个不可连接的地址。
$probeHost = if ($hostAddress -eq '0.0.0.0' -or $hostAddress -eq '::') { '127.0.0.1' } else { $hostAddress }

# 停服务之前先挡「库没了但备份还在」。
# 主程序启动时确实会拒绝（DB_MISSING_WITH_BACKUPS），但那时服务已经停了：
# 为一个可预见的失败先制造一次停机，是最不该发生的运维事故。这里只读检查，DryRun 也能看到。
$dbBytesPreflight = 0
if (Test-Path $dbPath) { $dbBytesPreflight = (Get-Item -Path $dbPath).Length }
$allowEmptyDb = $env:AIDASH_ALLOW_EMPTY_DB -eq '1' -or $env:AIDASH_ALLOW_EMPTY_DB -eq 'true'
if ($dbBytesPreflight -le 0 -and -not $allowEmptyDb) {
  $existingBackups = @()
  if (Test-Path $backupDir) {
    $existingBackups = @(Get-ChildItem -Path $backupDir -Filter '*.db' -File -ErrorAction SilentlyContinue)
  }
  if ($existingBackups.Count -gt 0) {
    Fail-Step "数据库不存在或为空，但备份目录里已有 $($existingBackups.Count) 个 .db：$dbPath" `
      '这通常是路径漂移或库被误删，不是首次部署。部署在停服前中止，服务保持运行；请先核对 AIDASH_DB_PATH，或按 60-deliver/回滚方案.md 恢复。确认要建空库时再设置 AIDASH_ALLOW_EMPTY_DB=true。'
  }
}

# DryRun 必须在任何副作用之前：不建目录、不写锁、不采集/清理指标基线。
# 旧实现把判断放在建目录、写锁、采基线之后，却对外承诺「不做任何变更」——
# 文档与行为不一致本身就是缺陷：人用 DryRun 验证路径与端口，结果留下了目录和锁。
# 现在 DryRun 只跑上面那些只读预检，然后打印计划就退出。
if ($DryRun) {
  Write-Step 'DryRun：只预检，不执行任何变更'
  Write-Info "1) 停止端口 $Port 上的 AIDash 进程（没有则跳过）"
  Write-Info "2) 备份数据库 -> $backupDir\aidash-deploy-<时间戳>.db（含 sha256 与 integrity_check）"
  Write-Info "3) 快照上一版构建 -> $releaseDir\<时间戳>"
  Write-Info '4) 构建：pnpm -C 40-build build + pnpm -C 40-build web:build（-SkipBuild 时跳过）'
  Write-Info "5) 启动：node $serverEntry"
  Write-Info '6) 健康检查：/healthz + 已鉴权的 /api/health'
  Write-Info '本次 DryRun 没有创建目录、没有写锁、没有采集指标基线，也没有发送任何令牌。'
  exit 0
}

New-Item -ItemType Directory -Force -Path @($dataDir, $backupDir, $logDir) | Out-Null

# 单实例部署锁：两个部署同时跑会互相停进程、抢同一份 dist。锁里写 PID，
# 残留锁（进程已不在）自动清理，避免上次异常退出把后续部署永久挡住。
if (Test-Path $lockFile) {
  $lockRaw = Get-Content -Raw -Path $lockFile -ErrorAction SilentlyContinue
  $lockPid = 0
  if ($lockRaw) {
    $firstLockLine = ($lockRaw -split "`n")[0].Trim()
    [void][int]::TryParse($firstLockLine, [ref]$lockPid)
  }
  if ($lockPid -gt 0 -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
    Fail-Step "另一个部署正在进行（PID $lockPid，锁文件 $lockFile）。" `
      '等它结束；只有确认是残留锁时才手工删除该文件。'
  }
  Write-Info "发现过期部署锁（PID $lockPid 已不在），清理后继续。"
  Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
}
$script:LockFile = $lockFile
Set-Content -Path $lockFile -Value "$PID`n$(Get-Date -Format o)" -Encoding ASCII

$stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'

Write-Info "仓库根：$RepoRoot"
Write-Info "监听地址：http://${probeHost}:$Port/（服务绑定 $hostAddress）"
Write-Info "数据库：$dbPath"
Write-Info "备份目录：$backupDir"
Write-Info "静态目录：$staticDir"
Write-Info "本次时间戳：$stamp"

$existingPids = @(Get-ListeningProcessIds $Port)
if ($existingPids.Count -gt 0) {
  foreach ($targetPid in $existingPids) {
    $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -ne 'node') {
      Fail-Step "端口 $Port 当前被非 node 进程占用：$($process.ProcessName)（PID $targetPid）。" `
        '部署还没开始，数据没动。先确认占用者；换端口用 -Port，或停掉该程序后重跑。'
    }
  }
  Write-Info "端口 $Port 当前有监听进程：$($existingPids -join ', ')；将按“只停 AIDash node 进程”的规则处理。"
} else {
  Write-Info "端口 $Port 当前没有监听进程。"
}

# 采集部署前指标基线：回滚方案里的“卡片/任务数量骤降”需要和部署前对比，
# 没有基线就只能靠回忆。这一步只读 /api/metrics，不改任何数据；服务没在跑或令牌
# 不一致时只提示、不阻断部署（真正的令牌校验在启动后的 /api/health 里）。
$baselineFile = Join-Path $backupDir "metrics-before-$stamp.json"
if ($existingPids.Count -gt 0) {
  # 发 Authorization 之前必须先确认监听者确实是本仓库的 AIDash：
  # 端口被别的程序占着时，令牌会先发给它。令牌泄露比“少一份基线”严重得多。
  # 这里用 Get-AidashProcessInfo 而不是 Assert-...：基线只是尽力而为，遇到不认识
  # 的监听者应该跳过，而不是中止整个部署（硬校验在第 1 步「停服务」里）。
  # 残留风险：判断与发请求之间端口可能换人（TOCTOU）。请求只发往回环地址，
  # 本机部署窗口极小；要彻底消除得按 socket 反查对端 PID，PowerShell 做不到。
  $unconfirmedPids = @($existingPids | Where-Object {
      (Get-AidashProcessInfo $_).kind -ne 'aidash'
    })
  if ($unconfirmedPids.Count -gt 0) {
    Write-Info "监听进程未能确认为本仓库 AIDash（PID: $($unconfirmedPids -join ', ')），跳过指标采集（不发令牌）。"
    $baselineFile = $null
  } else {
    try {
      $baselineHeaders = @{ Authorization = "Bearer $($env:AIDASH_TOKEN)" }
      $baseline = Invoke-RestMethod -Uri "http://${probeHost}:$Port/api/metrics" -Method Get `
        -Headers $baselineHeaders -TimeoutSec 5 -ErrorAction Stop
      $baseline | ConvertTo-Json -Depth 8 | Set-Content -Path $baselineFile -Encoding UTF8
      Write-Info "部署前指标基线：$baselineFile"
    } catch {
      Write-Info "部署前指标采集失败（服务可能未运行或令牌不一致），跳过；不影响部署。"
      $baselineFile = $null
    }
  }
}

# 旧基线清理只碰本脚本自己生成的 metrics-before-*.json，与本次是否采到基线无关；
# 放在上面的判断之外，保证服务停着的时候也能把堆积的基线清掉。
$oldBaselines = @(Get-ChildItem -Path $backupDir -Filter 'metrics-before-*.json' -File |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepBackups)
foreach ($oldBaseline in $oldBaselines) {
  Remove-Item -Path $oldBaseline.FullName -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 1. 停服务
# ---------------------------------------------------------------------------
Write-Step '1/6 停止现有服务'

$pidsToStop = @()
if (Test-Path $pidFile) {
  $pidText = Get-Content -Raw -Path $pidFile -ErrorAction SilentlyContinue
  if ($pidText) {
    $firstPidLine = ($pidText -split "`n")[0].Trim()
    $filePid = 0
    if ([int]::TryParse($firstPidLine, [ref]$filePid) -and (Get-Process -Id $filePid -ErrorAction SilentlyContinue)) {
      $pidsToStop += $filePid
    }
  }
}
$pidsToStop += @(Get-ListeningProcessIds $Port)
$pidsToStop = @($pidsToStop | Select-Object -Unique)

if ($pidsToStop.Count -eq 0) {
  Write-Done "端口 $Port 没有监听进程，跳过停止（幂等）。"
} else {
  # 两阶段：先把所有候选 PID 验完，再统一停。
  # 不能边验边杀——如果第一个是同仓库进程、第二个是他仓库进程，边验边杀会先杀掉
  # 合法服务再在第二个上失败，部署中止但服务已经停了。现在任何一个身份不明都会
  # 在 taskkill 之前退出，正在运行的服务保持原样。
  $verifiedPids = @()
  foreach ($targetPid in $pidsToStop) {
    if (Assert-AidashProcess $targetPid) { $verifiedPids += $targetPid }
  }

  foreach ($targetPid in $verifiedPids) {
    Write-Info "停止 PID $targetPid（node，AIDash）..."
    # 为什么用 taskkill /T /F：
    # - Windows 没有 POSIX 信号，Node 的 SIGTERM 处理器在 Windows 上不会被 taskkill/Stop-Process 触发；
    # - /T 连同子进程一起停，避免留下孤儿进程继续占端口（见 70-operate/已知坑清单.md #15）；
    # - /F 是强杀，但 SQLite 处于 WAL 模式：已提交事务可恢复，下一步的 Backup API 会把
    #   -wal 里尚未 checkpoint 的已提交页一并纳入快照，所以不会丢已确认写入。
    & taskkill /PID $targetPid /T /F 2>&1 | ForEach-Object { Write-Info ([string]$_) }
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 128) {
      Fail-Step "停止 PID $targetPid 失败（taskkill 退出码 $LASTEXITCODE）。" `
        '用任务管理器确认该进程状态；必要时手工结束进程后重跑。'
    }
  }

  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-ListeningProcessIds $Port).Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  $stillListening = @(Get-ListeningProcessIds $Port)
  if ($stillListening.Count -gt 0) {
    Fail-Step "停止后端口 $Port 仍被占用（PID: $($stillListening -join ', ')）。" `
      '可能是进程没退干净或别的程序抢占了端口；按 60-deliver/报错预案.md「端口被占」处理。'
  }
  Write-Done '服务已停止，端口已释放。'
}

Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# 2. 备份数据库
# ---------------------------------------------------------------------------
Write-Step '2/6 备份数据库（SQLite Backup API + sha256 + integrity_check）'

$backupFile = $null
$dbBytes = 0
if (Test-Path $dbPath) { $dbBytes = (Get-Item -Path $dbPath).Length }

if ($dbBytes -le 0) {
  # 首次部署没有库是正常情况：openDb 会在启动时创建。
  # 但如果库文件不见了、旁边却有备份，主程序会拒绝启动（DB_MISSING_WITH_BACKUPS），
  # 这不是“备份失败”，而是路径漂移信号，交给启动步骤暴露。
  Write-Info "数据库不存在或大小为 0：$dbPath（首次部署可忽略）。"
  Write-Done '跳过数据库备份（没有可备份的数据）。'
} else {
  $backupFile = Join-Path $backupDir "aidash-deploy-$stamp.db"
  if (Test-Path $backupFile) {
    Fail-Step "备份文件已存在，拒绝覆盖：$backupFile。" '删掉同名文件或稍后重跑（同一毫秒内重复执行的概率极低）。'
  }

  Write-Info "源库：$dbPath（$([math]::Round($dbBytes / 1MB, 2)) MB）"
  Write-Info "目标：$backupFile"
  # 为什么用 helper 而不是 Copy-Item：
  # WAL 模式下直接拷 .db 可能漏掉尚未 checkpoint 的页；SQLite Backup API 才能拿到一致快照
  #（设计 05 §9.1 明确要求）。helper 还会做 integrity_check 并写 .sha256。
  & node $backupHelper --db $dbPath --out $backupFile --sha256 "$backupFile.sha256"
  $backupExit = $LASTEXITCODE

  if ($backupExit -eq 2) {
    Write-Info '备份助手报告源库不存在/为空，按首次部署跳过。'
    $backupFile = $null
  } elseif ($backupExit -ne 0) {
    Fail-Step "数据库备份失败（备份助手退出码 $backupExit）。" `
      '数据库没有被修改，但服务当前是停止状态。按 60-deliver/报错预案.md「备份失败」处理后再重跑。'
  } else {
    if (-not (Test-Path $backupFile)) {
      Fail-Step "备份助手返回成功，但文件不存在：$backupFile。" '检查磁盘与权限；不要继续启动。'
    }
    $backupBytes = (Get-Item -Path $backupFile).Length
    if ($backupBytes -le 0) {
      Fail-Step "备份文件大小为 0：$backupFile。" '磁盘可能已满或写入被拦截；不要继续。'
    }

    # 二次校验：助手已经算过 sha256，这里独立再算一遍并和 .sha256 对账，
    # 防止“文件写完但落盘不完整”这种静默问题。
    $actualHash = (Get-FileHash -Path $backupFile -Algorithm SHA256).Hash.ToLower()
    $shaFile = "$backupFile.sha256"
    $expectedHash = ''
    if (Test-Path $shaFile) {
      $expectedHash = ((Get-Content -Raw -Path $shaFile).Trim() -split '\s+')[0].ToLower()
    }
    if (-not $expectedHash) {
      Fail-Step "缺少校验文件或内容为空：$shaFile。" '重跑备份；没有校验和的备份不能用于回滚。'
    }
    if ($actualHash -ne $expectedHash) {
      Fail-Step "备份校验不匹配：实际 $actualHash，期望 $expectedHash。" '备份不可信，不要继续；按「备份失败」处置。'
    }

    Write-Done "备份完成：$([math]::Round($backupBytes / 1MB, 2)) MB，sha256=$actualHash"

    # 保留策略：只清理本脚本创建的 aidash-deploy-*.db，
    # 绝不碰 pre-migrate-*、pre-restart 或人工备份——那些可能是唯一的回滚点。
    $oldBackups = @(Get-ChildItem -Path $backupDir -Filter 'aidash-deploy-*.db' -File |
      Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepBackups)
    foreach ($old in $oldBackups) {
      Remove-Item -Path $old.FullName -Force -ErrorAction SilentlyContinue
      Remove-Item -Path "$($old.FullName).sha256" -Force -ErrorAction SilentlyContinue
      Write-Info "按保留策略清理旧备份：$($old.Name)"
    }
  }
}

# ---------------------------------------------------------------------------
# 3. 快照上一版构建（给回滚用）
# ---------------------------------------------------------------------------
$releaseRoot = $null
if ($SkipBuild) {
  Write-Step '3/6 保存上一版构建（已按 -SkipBuild 跳过）'
  Write-Info '这次不构建，当前 dist 就是要启动的版本，无需快照。'
} else {
  Write-Step '3/6 保存上一版构建（回滚用）'
  $previousServer = Join-Path $distDir 'server/main.js'
  $previousWeb = Join-Path $distDir 'web/index.html'
  if ((Test-Path $previousServer) -or (Test-Path $previousWeb)) {
    $releaseRoot = Join-Path $releaseDir $stamp
    New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
    # 只快照运行时需要的子目录：server（含迁移 SQL）+ shared + web。
    # 不搬 node_modules，也不搬整个 dist，避免快照过大。
    foreach ($subDir in @('server', 'shared', 'web')) {
      $sourceSub = Join-Path $distDir $subDir
      if (Test-Path $sourceSub) {
        Copy-Item -Path $sourceSub -Destination (Join-Path $releaseRoot $subDir) -Recurse -Force
      }
    }
    Set-Content -Path (Join-Path $releaseRoot 'RELEASE.txt') -Encoding UTF8 -Value @(
      "created_at=$(Get-Date -Format o)",
      "repo_root=$RepoRoot",
      'note=deploy.ps1 自动快照；回滚时用本目录下的 server/shared/web 覆盖 dist 同名目录'
    )
    Write-Done "上一版构建已快照：$releaseRoot"

    $oldReleases = @(Get-ChildItem -Path $releaseDir -Directory |
      Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepBackups)
    foreach ($oldRelease in $oldReleases) {
      Remove-Item -Path $oldRelease.FullName -Recurse -Force -ErrorAction SilentlyContinue
      Write-Info "按保留策略清理旧构建快照：$($oldRelease.Name)"
    }
  } else {
    Write-Info '没有可快照的上一版构建（首次部署），跳过。'
  }
}

# ---------------------------------------------------------------------------
# 4. 构建
# ---------------------------------------------------------------------------
if ($SkipBuild) {
  Write-Step '4/6 构建（已跳过）'
  Write-Info '使用现有 dist；请确认它确实是你想启动的版本。'
} else {
  Write-Step '4/6 构建服务端与前端'
  Write-Info '执行：pnpm -C 40-build build（tsc 编译服务端 + 复制迁移 SQL）'
  & pnpm -C $buildRoot build
  if ($LASTEXITCODE -ne 0) {
    $hint = '服务当前是停止状态。修复编译错误后重跑本脚本。'
    if ($releaseRoot) { $hint = "$hint 上一版构建已快照在 $releaseRoot，可按 60-deliver/回滚方案.md 先恢复旧版本。" }
    Fail-Step "服务端构建失败（退出码 $LASTEXITCODE）。" $hint
  }

  Write-Info '执行：pnpm -C 40-build web:build（Vite 构建前端）'
  & pnpm -C $buildRoot web:build
  if ($LASTEXITCODE -ne 0) {
    $hint = '服务当前是停止状态。修复前端构建错误后重跑本脚本。'
    if ($releaseRoot) { $hint = "$hint 上一版构建已快照在 $releaseRoot。" }
    Fail-Step "前端构建失败（退出码 $LASTEXITCODE）。" $hint
  }

  # 产物存在性检查：tsc 成功但迁移 SQL 没复制、Vite 成功但入口缺失，
  # 都会让服务在启动时才炸；在这里提前拦住，错误信息更直接。
  foreach ($artifact in @(
      (Join-Path $distDir 'server/main.js'),
      (Join-Path $distDir 'server/db/migrations/000_bootstrap.sql'),
      (Join-Path $distDir 'web/index.html')
    )) {
    if (-not (Test-Path $artifact)) {
      Fail-Step "构建产物缺失：$artifact。" '检查 40-build/00-platform/tools/copy-server-assets.mjs 与 Vite 配置；修复后重跑。'
    }
  }
  Write-Done '构建完成，关键产物齐全（server/main.js、迁移 SQL、web/index.html）。'
}

# ---------------------------------------------------------------------------
# 5. 启动
# ---------------------------------------------------------------------------
Write-Step '5/6 启动服务'

# 路径必须钉死成绝对路径：相对路径会随启动目录漂移，指向另一个空库，
# 表现出来就是“任务全没了”。这是 start-aidash.ps1 已经验证过的做法。
$env:AIDASH_DB_PATH = $dbPath
$env:AIDASH_BACKUP_DIR = $backupDir
$env:AIDASH_STATIC_DIR = $staticDir
$env:AIDASH_PORT = "$Port"
# AIDASH_HOST 不强行覆盖：默认 127.0.0.1；用户显式设置时按用户的来。

$outLog = Join-Path $dataDir 'server.out.log'
$errLog = Join-Path $dataDir 'server.err.log'

# Start-Process 的重定向会清空目标文件；先轮转旧日志，保留上一次的现场。
foreach ($logPair in @(
    @{ Path = $outLog; Kind = 'out' },
    @{ Path = $errLog; Kind = 'err' }
  )) {
  if (Test-Path $logPair.Path) {
    $rotated = Join-Path $logDir ("server-{0}.{1}.log" -f $stamp, $logPair.Kind)
    Move-Item -Path $logPair.Path -Destination $rotated -Force
    Write-Info "轮转旧日志：$rotated"
  }
}

$nodeExe = (Get-Command node).Source
# 显式给入口路径加引号：Windows PowerShell 5.1 的 Start-Process 不会替含空格的参数自动加引号，
# 仓库放在 "Program Files" 这类目录下时，不加引号会把一个路径拆成多个参数。
$quotedEntry = '"' + $serverEntry + '"'
$process = Start-Process -FilePath $nodeExe -ArgumentList $quotedEntry `
  -WorkingDirectory $RepoRoot -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
  -PassThru -WindowStyle Hidden
# 立刻登记：之后任何一步失败（包括写 pid 文件本身失败触发的 trap）都会由 Fail-Step 停掉它。
# 登记放在写 pid 文件之前，是因为写文件也可能失败 —— 那时更不能把进程留下。
$script:StartedProcess = $process
$script:StartedPidFile = $pidFile
Set-Content -Path $pidFile -Value "$($process.Id)" -Encoding ASCII
Write-Done "服务进程已启动：PID $($process.Id)"
Write-Info "stdout：$outLog"
Write-Info "stderr：$errLog"

# ---------------------------------------------------------------------------
# 6. 健康检查
# ---------------------------------------------------------------------------
Write-Step "6/6 健康检查（最长 $HealthTimeoutSeconds 秒）"

$healthUrl = "http://${probeHost}:$Port/healthz"
$expectedDbPath = [IO.Path]::GetFullPath($dbPath)
$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
$healthy = $false
$lastHealthError = ''

while ((Get-Date) -lt $deadline) {
  if ($process.HasExited) { break }
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3 -ErrorAction Stop
    if ($health.ok -eq $true -and $health.status -eq 'ok') {
      $reportedDbPath = [string]$health.db_path
      if (-not $reportedDbPath) {
        Fail-Step '/healthz 没有返回 db_path。' '无法确认连的是哪个库；不要继续，按「健康检查失败」排查。'
      }
      $reportedFull = [IO.Path]::GetFullPath($reportedDbPath)
      if (-not [string]::Equals($reportedFull, $expectedDbPath, [StringComparison]::OrdinalIgnoreCase)) {
        # 这是最危险的启动异常：服务活着，但可能在读写另一个库。必须立刻停。
        Fail-Step "/healthz 报告的 db_path 与部署目标不一致：$reportedFull ≠ $expectedDbPath。" `
          '路径漂移会导致看起来“数据全没了”。先确认 AIDASH_DB_PATH 与启动目录；不要把这个服务留在运行状态。'
      }
      $healthy = $true
      break
    }
  } catch {
    $lastHealthError = $_.Exception.Message
  }
  Start-Sleep -Milliseconds 500
}

if (-not $healthy) {
  if ($process.HasExited) {
    Write-Host "   服务进程已退出，退出码：$($process.ExitCode)" -ForegroundColor Yellow
  } elseif ($lastHealthError) {
    Write-Host "   最后一次探活错误：$lastHealthError" -ForegroundColor Yellow
  }
  Show-LogTail $errLog 30
  Show-LogTail $outLog 30
  Fail-Step "启动后 $HealthTimeoutSeconds 秒内 /healthz 未通过。" `
    '看上面的日志尾部。常见原因：端口被占、令牌缺失、迁移失败、DB 路径漂移、静态产物缺失；按 60-deliver/报错预案.md 对应条目处理。'
}
Write-Done "/healthz 通过，db_path 与部署目标一致。"

# /healthz 不鉴权、也不读写数据库，只能证明“进程活着且路由通了”。
# 再打一次已鉴权的 /api/health：同时验证令牌、审计链和数据库可用性。
try {
  $headers = @{ Authorization = "Bearer $($env:AIDASH_TOKEN)" }
  $apiHealth = Invoke-RestMethod -Uri "http://${probeHost}:$Port/api/health" -Method Get `
    -Headers $headers -TimeoutSec 5 -ErrorAction Stop
  if ($apiHealth.ok -ne $true -or $apiHealth.data.status -ne 'ok') {
    Fail-Step '/api/health 返回非 ok。' '看服务日志；不要带着异常状态继续。'
  }
  if ($apiHealth.data.audit_chain.ok -ne $true) {
    Fail-Step "审计链校验失败（broken_at=$($apiHealth.data.audit_chain.broken_at)）。" `
      '审计链断裂是数据完整性问题：先停止写入并按回滚方案处置，不要继续发卡。'
  }
  Write-Done "/api/health 通过（令牌有效、审计链正常、数据库可查询）。"
} catch {
  Fail-Step "已鉴权健康检查失败：$($_.Exception.Message)" `
    '若是 401：说明进程里的令牌与当前 shell 不一致。不要反复重试（会把 401 刷进日志），先核对 AIDASH_TOKEN，见报错预案「令牌缺失/错误」。'
}

# 打印启动关键行，方便人一眼确认“连的是哪个库、迁移做了什么”。
Write-Host ''
Write-Host '   启动日志关键行：' -ForegroundColor Cyan
$startupLines = @(Get-Content -Path $outLog -ErrorAction SilentlyContinue |
  Select-String -Pattern '"msg":"(db_ready|listening|pre_migration_backup)"' | Select-Object -Last 5)
foreach ($line in $startupLines) { Write-Host "   $($line.Line)" }

Remove-Item -Path $script:LockFile -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '部署完成。' -ForegroundColor Green
Write-Host "   访问：http://${probeHost}:$Port/"
Write-Host "   数据库：$dbPath"
if ($backupFile) { Write-Host "   本次备份：$backupFile（含 .sha256）" }
if ($releaseRoot) { Write-Host "   上一版构建快照：$releaseRoot" }
Write-Host "   日志：$outLog / $errLog"
Write-Host '   回滚：见 60-deliver/回滚方案.md'
exit 0
