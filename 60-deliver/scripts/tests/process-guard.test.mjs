import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * deploy.ps1 进程身份守卫的自动测试。
 *
 * 目的：不启动/停止任何真实服务，也不碰 8787 或真实数据目录，验证两件事：
 * 1. 静态守卫还在：命令行入口 dist/server/main.js 必须与 $RepoRoot 同时命中；
 * 2. 行为守卫生效：把脚本里的真实归一化/判定函数抽出来，在子 PowerShell 中用
 *    假的 Get-Process / Get-CimInstance 喂样例命令行，断言不会把它仓库进程
 *    当成本仓库 AIDash。
 *
 * 这里不使用 -ExecutionPolicy Bypass：-Command 是命令输入，不是脚本文件；
 * 找不到 PowerShell 时行为用例跳过，静态用例仍会跑。
 */

const deployPath = fileURLToPath(new URL('../deploy.ps1', import.meta.url));
const deployBytes = fs.readFileSync(deployPath);
const source = deployBytes.toString('utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `deploy.ps1 缺少函数 ${name}`);
  // PowerShell 的嵌套块缩进两级，顶格 `}` 才是函数结尾；
  // 不能简单切到下一个 function，否则会把中间“停服务”代码也算进来。
  const tail = source.slice(start);
  const closing = /\r?\n\}\r?\n/.exec(tail);
  assert.notEqual(closing, null, `deploy.ps1 中函数 ${name} 没有正常闭合`);
  return tail.slice(0, closing.index + closing[0].length);
}

function findPowerShell() {
  const candidates = process.platform === 'win32'
    ? ['powershell.exe', 'pwsh.exe', 'powershell', 'pwsh']
    : ['pwsh', 'powershell'];
  for (const candidate of candidates) {
    try {
      const checked = spawnSync(
        candidate,
        ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      if (checked.status === 0) return candidate;
    } catch {
      // 换下一个候选。
    }
  }
  return null;
}

const powershell = findPowerShell();

test('静态守卫：入口 + RepoRoot 双条件、路径归一化、other-repo 文案', () => {
  assert.match(source, /function ConvertTo-NormalizedPathText/);
  assert.ok(source.includes('ToLowerInvariant()'), '路径必须转小写');
  assert.ok(source.includes("$normalizedCommandLine -notmatch 'dist/server/main\\.js'"), '必须检查 AIDash 入口');
  assert.ok(
    source.includes('$normalizedCommandLine.Contains("$normalizedRepoRoot/")'),
    '必须同时检查本仓库根（带路径边界）',
  );
  assert.ok(source.includes("reason = 'main-entry-outside-repo'"), '他仓库入口必须归为 unknown');
  assert.ok(source.includes('疑似不是本仓库进程，请手工确认'), '错误文案必须提示人工确认');
  assert.equal(source.includes('$ownedByPidFile'), false, '不能再仅凭 pid 文件认定 aidash');

  const assertFunction = extractFunction('Assert-AidashProcess');
  assert.match(assertFunction, /'unknown' \{/);
  assert.match(assertFunction, /default \{/);
  assert.match(assertFunction, /Fail-Step/);
  assert.equal(/taskkill/i.test(assertFunction), false, '身份校验本身不得执行 taskkill');
  assert.equal(/ExecutionPolicy\s+Bypass/i.test(source), false, '不得使用 ExecutionPolicy Bypass');
  // 先验完再杀：任何未知身份都必须在 taskkill 之前退出。
  assert.ok(source.includes('$verifiedPids = @()'), '停服必须分两阶段');
  assert.ok(
    source.indexOf('$verifiedPids = @()') < source.indexOf('& taskkill /PID $targetPid /T /F'),
    '校验阶段必须在停进程阶段之前',
  );
  // Windows PowerShell 5.1 读取无 BOM 的 UTF-8 中文会乱码；这是脚本的既有交付约束。
  assert.deepEqual([...deployBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'deploy.ps1 必须保留 UTF-8 BOM');
});

test('行为守卫：真实 PS 函数对斜杠/大小写/他仓库/缺命令行分类正确', { skip: !powershell }, () => {
  const normalizeFunction = extractFunction('ConvertTo-NormalizedPathText');
  const infoFunction = extractFunction('Get-AidashProcessInfo');
  const script = [
    "Set-StrictMode -Version 2.0",
    "$ErrorActionPreference = 'Stop'",
    '$RepoRoot = $env:SMOKE_REPO_ROOT',
    "function Get-Process { param([int]$Id, $ErrorAction) if ($env:SMOKE_GONE -eq '1') { return $null }; [pscustomobject]@{ ProcessName = $env:SMOKE_PROCESS_NAME } }",
    "function Get-CimInstance { param($Filter, $ErrorAction) [pscustomobject]@{ CommandLine = $env:SMOKE_COMMAND_LINE } }",
    normalizeFunction,
    infoFunction,
    '$result = Get-AidashProcessInfo 424242',
    '$result | ConvertTo-Json -Compress',
  ].join('\n');

  function classify({ commandLine = '', repoRoot, processName = 'node', gone = false }) {
    const result = spawnSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
        env: {
          ...process.env,
          SMOKE_REPO_ROOT: repoRoot,
          SMOKE_COMMAND_LINE: commandLine,
          SMOKE_PROCESS_NAME: processName,
          SMOKE_GONE: gone ? '1' : '0',
        },
      },
    );
    assert.equal(result.status, 0, `PowerShell 失败：${result.stderr || result.stdout}`);
    const lines = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
    return JSON.parse(lines.at(-1));
  }

  const repoRoot = 'F:\\Work\\AIDash';
  const mainJs = '40-build\\10-aidash\\dist\\server\\main.js';

  assert.equal(
    classify({ repoRoot, commandLine: `node "F:\\Work\\AIDash\\${mainJs}"` }).kind,
    'aidash',
  );
  assert.equal(
    classify({ repoRoot, commandLine: `node "F:/WORK/AIDASH/40-build/10-aidash/dist/server/main.js"` }).kind,
    'aidash',
    '大小写与斜杠不同仍应识别',
  );

  const oldRepo = classify({
    repoRoot,
    commandLine: `node "F:\\Work\\AIDash-old\\${mainJs}"`,
  });
  assert.equal(oldRepo.kind, 'unknown');
  assert.equal(oldRepo.reason, 'main-entry-outside-repo');

  const otherRepo = classify({
    repoRoot,
    commandLine: `node "F:\\Work\\Other\\AIDash\\${mainJs}"`,
  });
  assert.equal(otherRepo.kind, 'unknown');
  assert.equal(otherRepo.reason, 'main-entry-outside-repo');

  const nonAidashEntry = classify({
    repoRoot,
    commandLine: 'node "F:\\Work\\AIDash\\40-build\\10-aidash\\dist\\server\\other.js"',
  });
  assert.equal(nonAidashEntry.kind, 'foreign');

  const noCommandLine = classify({ repoRoot, commandLine: '' });
  assert.equal(noCommandLine.kind, 'unknown');
  assert.equal(noCommandLine.reason, 'no-command-line');
});
