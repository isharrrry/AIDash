import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { AppError } from '../shared/errors.js';
import { systemClock } from '../shared/time.js';
import { enforceBackupRetention } from './backup-retention.js';
import { isLoopbackHost, loadConfig } from './config.js';
import { inspectEmptyDb, resolveStartupPaths } from './startup.js';
import type { AppContext } from './context.js';
import { openDb, type Db } from './db/connection.js';
import { latestMigrationVersion, migrate, schemaVersion } from './db/migrate.js';
import { createApp } from './http/app.js';
import { createLogger, type Logger } from './log.js';
import { AssistantMemoryRepo } from './repos/assistant-memory-repo.js';
import { ChannelRepo } from './repos/channel-repo.js';
import { CardRepo } from './repos/card-repo.js';
import { MaterialRepo } from './repos/material-repo.js';
import { MemoryDigestRepo } from './repos/memory-digest-repo.js';
import { MemoryRepo } from './repos/memory-repo.js';
import { ReportRepo } from './repos/report-repo.js';
import { TaskRepo } from './repos/task-repo.js';
import {
  ArtifactRepo,
  AuditRepo,
  EventRepo,
  HarnessRepo,
  KbRepo,
  SettingRepo,
} from './repos/support-repos.js';
import { AssistantMemoryLearner } from './services/assistant-memory-learner.js';
import { AssistantMemoryService } from './services/assistant-memory-service.js';
import { AuditService } from './services/audit-service.js';
import { CardService } from './services/card-service.js';
import { ChannelService } from './services/channel-service.js';
import { DecisionService, WaitRegistry } from './services/decision-service.js';
import { EnrichmentService } from './services/enrichment-service.js';
import { KbService } from './services/kb-service.js';
import { LlmService } from './services/llm-service.js';
import { MemoryDigestService } from './services/memory-digest-service.js';
import { MemoryService } from './services/memory-service.js';
import { ReportService } from './services/report-service.js';
import { SecretStore } from './services/secret-store.js';
import { SettingsService } from './services/settings-service.js';
import { TaskService } from './services/task-service.js';
import { createBackgroundWorker } from './workers/background.js';

const SHUTDOWN_GRACE_MS = 10_000;

/**
 * 进程入口。
 *
 * 装配顺序有两条硬约束：
 * 1. 迁移前先备份——迁移失败时至少还能拿回旧库；
 * 2. CardService 先于 DecisionService 构造，再用 bindAnswerListener 反向绑定，
 *    这样既避免循环依赖，也不会漏掉“答案落库后唤醒等待者”的回调。
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  // 跨机访问是显式选择，但不能悄无声息：局域网里的明文 HTTP 会让
  // 令牌/口令在链路上裸奔。只在启动时告警一次，不阻断用户配置。
  if (!isLoopbackHost(config.host)) {
    log.warn('lan_exposure', {
      host: config.host,
      hint: '仅建议在可信局域网使用；跨网段请配 TLS 反向代理',
    });
  }
  if (process.env.AIDASH_PASSPHRASE && !process.env.AIDASH_TOKEN) {
    log.warn('passphrase_deprecated', {
      hint: 'AIDASH_PASSPHRASE 已弃用；请改用 AIDASH_TOKEN（可以直接填同一句短口令）',
    });
  }
  const clock = systemClock;
  // 先解析再建库：相对路径会随启动目录漂移，打印绝对路径才能确认连的是哪个库。
  const paths = resolveStartupPaths(config);
  refuseSilentEmptyDb(paths.dbPath, paths.backupDir, config.allowEmptyDb, log);
  const db = openDb(paths.dbPath);

  let backupOk = true;
  try {
    await backupBeforeMigration(db, paths.dbPath, paths.backupDir, log);
  } catch (error) {
    // 备份失败不阻断启动，但必须让人知道：这是回滚能力的降级。
    backupOk = false;
    log.warn('pre_migration_backup_failed', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  if (backupOk && paths.dbPath !== ':memory:') {
    // 清理失败只告警：保留策略是磁盘运维，不能成为服务起不来的新理由。
    // 备份失败时先不清理，避免旧的回滚点被删掉后新的又没生成。
    enforceBackupRetention(
      {
        backupDir: paths.backupDir,
        dbPath: paths.dbPath,
        retentionDays: config.backupRetentionDays,
        minKeep: config.backupMinKeep,
      },
      log,
    );
  }

  const migration = migrate(db, { now: clock.now() });
  log.info('db_ready', {
    db_path: paths.dbPath,
    schema_version: schemaVersion(db),
    applied: migration.applied,
    skipped: migration.skipped,
  });

  const ctx = buildContext(config, db, log, clock);
  // 上一进程留下的 running 汇报批次不会再有人推进；先收尸再对外服务，
  // 否则页面会一直显示“更新中”，新的批次也会被并发闸门挡住。
  const recovered = ctx.services.reports.recover();
  if (recovered > 0) log.warn('report_runs_recovered', { count: recovered });
  const worker = createBackgroundWorker(ctx, log);
  worker.start();
  ctx.services.enrichment.start();
  ctx.services.memoryDigest.start();

  const app = createApp(ctx, log);
  const server = app.listen(config.port, config.host, () => {
    log.info('listening', {
      url: `http://${config.host}:${config.port}`,
      mcp: '/mcp',
      db_path: paths.dbPath,
      static_dir: paths.staticDir,
      kb_configured: ctx.services.kb.isConfigured(),
    });
    // 首轮 KB 索引放在 listen 之后：端口先可用，索引异步分批跑。
    // 放在 worker.start() 里会让文档多的库在“监听成功”之前就占住事件循环。
    worker.indexKb();
  });

  installShutdown({ server, db, worker, ctx, log });
}

/** 服务容器只在这里组装一次；接入层（REST/MCP）共享同一份实例。 */
export function buildContext(
  config: AppContext['config'],
  db: Db,
  log: Logger,
  clock: AppContext['clock'],
): AppContext {
  const repos: AppContext['repos'] = {
    channels: new ChannelRepo(db),
    cards: new CardRepo(db),
    tasks: new TaskRepo(db),
    memory: new MemoryRepo(db),
    assistantMemory: new AssistantMemoryRepo(db),
    memoryDigest: new MemoryDigestRepo(db),
    materials: new MaterialRepo(db),
    reports: new ReportRepo(db),
    artifacts: new ArtifactRepo(db),
    harnesses: new HarnessRepo(db),
    events: new EventRepo(db),
    audit: new AuditRepo(db),
    kb: new KbRepo(db),
    setting: new SettingRepo(db),
  };

  const audit = new AuditService(repos.audit, clock);
  const secretStore = new SecretStore(config.secretDir);
  // 启动时就要把「配过但解不开」喊出来：否则增强分析会悄悄回退到环境变量或直接停用，
  // 用户只会在某天发现分析质量变差，却不知道密钥早在换机时丢了。
  // 只告警不拒绝启动：读接口、卡片、任务等核心功能并不依赖 LLM 密钥。
  const storedKeyState = secretStore.readLlmKeyState();
  if (storedKeyState.status === 'unreadable') {
    log.warn('secret_store_unreadable', { dir: config.secretDir, reason: storedKeyState.reason });
  }
  const settings = new SettingsService(config, repos.setting, db, audit, clock, secretStore);
  // 先建记忆服务再建 LlmService：LLM 的每次调用都要在 system 末尾追加 AIDash 记忆。
  // 反过来会让 LlmService 依赖一个尚未构造的对象，只能靠延迟 setter，反而更难追踪。
  const assistantMemory = new AssistantMemoryService({
    db,
    memory: repos.assistantMemory,
    audit,
    clock,
  });
  const llm = new LlmService(settings, assistantMemory);
  // kb_root 走 getter，设置页改完立即生效，不需要重启。
  const kb = new KbService(() => settings.current().kbRoot, repos.kb, clock, log);
  // 通道在线阈值与 harness 心跳共用同一个配置：用户不希望设置页说“离线”
  // 而通道树还转圈。配置单位是秒，这里换算成毫秒传给纯计算的服务层。
  const channels = new ChannelService(
    repos.channels,
    audit,
    clock,
    config.offlineThresholdSeconds * 1000,
  );
  const enrichment = new EnrichmentService({
    db,
    cards: repos.cards,
    events: repos.events,
    kb,
    llm,
    settings,
    clock,
  });
  const cards = new CardService({
    db,
    cards: repos.cards,
    artifacts: repos.artifacts,
    events: repos.events,
    tasks: repos.tasks,
    channels,
    audit,
    clock,
    enrichment,
  });
  const waiters = new WaitRegistry(config.maxWaitingRequests);
  const decisions = new DecisionService({
    cards,
    waiters,
    clock,
    maxWaitSeconds: config.maxWaitSeconds,
  });
  cards.bindAnswerListener(decisions.resolve);

  const tasks = new TaskService({
    db,
    tasks: repos.tasks,
    cards: repos.cards,
    harnesses: repos.harnesses,
    events: repos.events,
    channels,
    audit,
    clock,
    leaseSeconds: config.leaseSeconds,
  });
  const memory = new MemoryService({ db, memory: repos.memory, audit, clock });
  const memoryDigest = new MemoryDigestService({
    db,
    digest: repos.memoryDigest,
    memory,
    llm,
    settings,
    audit,
    clock,
  });
  // 学习器不依赖 ReportService（只读 report 表），因此可以先造出来，
  // 再用回调接到汇报服务上，避免“汇报服务↔学习器”的循环依赖。
  const assistantMemoryLearner = new AssistantMemoryLearner({
    reports: repos.reports,
    memory: assistantMemory,
    llm,
    audit,
    clock,
  });
  const reports = new ReportService({
    db,
    reports: repos.reports,
    materials: repos.materials,
    llm,
    settings,
    audit,
    clock,
    offlineThresholdMs: config.offlineThresholdSeconds * 1000,
    // 只有批次成功完成才会收到；学习器内部吞掉所有异常，不影响汇报状态。
    onRunDone: (runId) => {
      void assistantMemoryLearner.learn(runId);
    },
  });

  return {
    config,
    db,
    clock,
    startedAt: Date.now(),
    repos,
    services: {
      audit,
      channels,
      cards,
      decisions,
      tasks,
      memory,
      assistantMemory,
      assistantMemoryLearner,
      memoryDigest,
      reports,
      kb,
      settings,
      llm,
      enrichment,
    },
  };
}

/**
 * 建库前的最后一道检查：库文件不存在、旁边却躺着备份，默认拒绝启动。
 *
 * 这不是“自动恢复”——自动恢复会改文件，必须由人确认；
 * 这里只是把“静默建空库”变成一条明确的错误，让人先确认路径。
 * 显式设置 AIDASH_ALLOW_EMPTY_DB=true 才允许在备份存在时新建空库。
 */
function refuseSilentEmptyDb(
  dbPath: string,
  backupDir: string,
  allowEmptyDb: boolean,
  log: Logger,
): void {
  const check = inspectEmptyDb(dbPath, backupDir);
  if (!check.missing) return;

  const detail = {
    db_path: dbPath,
    backup_dir: backupDir,
    backup_count: check.backups.length,
    backup_dir_readable: check.backupDirReadable,
    latest_backup: check.backups.at(-1) ?? null,
  };

  if (check.backups.length > 0 && !allowEmptyDb) {
    log.error('db_missing_with_backups', detail);
    throw new AppError('INTERNAL', 'DB_MISSING_WITH_BACKUPS', {
      ...detail,
      hint: '确认 AIDASH_DB_PATH 是否指错；确需新建空库时设置 AIDASH_ALLOW_EMPTY_DB=true',
    });
  }

  // 没有备份（或已显式允许）：照常建库，但必须留下警告，
  // 否则空库会和正常启动长得一模一样。
  log.warn('db_missing', detail);
}

async function backupBeforeMigration(
  db: Db,
  dbPath: string,
  backupDir: string,
  log: Logger,
): Promise<void> {
  if (dbPath === ':memory:') return;
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return;
  const current = schemaVersion(db);
  const target = latestMigrationVersion();
  if (current >= target) return;

  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `pre-migrate-${current}-to-${target}-${stamp}.db`);
  await db.backup(file);
  log.info('pre_migration_backup', { file: path.basename(file), from: current, to: target });
}

function installShutdown(deps: {
  server: Server;
  db: Db;
  worker: ReturnType<typeof createBackgroundWorker>;
  ctx: AppContext;
  log: Logger;
}): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log.info('shutdown_begin', { signal });

    // 先让阻塞中的 card.ask 立即返回 pending，否则 server.close 会一直等连接。
    deps.ctx.services.decisions.cancelAll();
    deps.worker.stop();
    deps.ctx.services.enrichment.stop();
    deps.ctx.services.memoryDigest.stop();

    // 后台任务不是“停掉定时器”就结束了：增强/记忆/汇报都已经发出模型请求，
    // abort 后 catch 分支还要写失败状态与运行记录。必须在 db.close() 之前等它们收尾。
    const background = Promise.allSettled([
      deps.ctx.services.reports.shutdown(),
      deps.ctx.services.enrichment.waitForIdle(),
      deps.ctx.services.memoryDigest.waitForIdle(),
      // 异步 KB 索引也可能正在写库：stop() 已 abort，这里等它退出后再 db.close()。
      deps.worker.waitForIdle(),
    ]);

    const force = setTimeout(() => {
      deps.log.warn('shutdown_forced');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    await new Promise<void>((resolve) => deps.server.close(() => resolve()));
    await background;
    deps.db.close();
    clearTimeout(force);
    deps.log.info('shutdown_done');
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal).then(() => process.exit(0));
    });
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const log = createLogger('error');
    log.error('startup_failed', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
    process.exit(1);
  });
}
