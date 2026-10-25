import type { Clock } from '../shared/time.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/connection.js';
import type { AssistantMemoryRepo } from './repos/assistant-memory-repo.js';
import type { ChannelRepo } from './repos/channel-repo.js';
import type { CardRepo } from './repos/card-repo.js';
import type { MaterialRepo } from './repos/material-repo.js';
import type { MemoryDigestRepo } from './repos/memory-digest-repo.js';
import type { MemoryRepo } from './repos/memory-repo.js';
import type { ReportRepo } from './repos/report-repo.js';
import type { TaskRepo } from './repos/task-repo.js';
import type {
  ArtifactRepo,
  AuditRepo,
  EventRepo,
  HarnessRepo,
  KbRepo,
  SettingRepo,
} from './repos/support-repos.js';
import type { AssistantMemoryLearner } from './services/assistant-memory-learner.js';
import type { AssistantMemoryService } from './services/assistant-memory-service.js';
import type { AuditService } from './services/audit-service.js';
import type { CardService } from './services/card-service.js';
import type { ChannelService } from './services/channel-service.js';
import type { DecisionService } from './services/decision-service.js';
import type { EnrichmentService } from './services/enrichment-service.js';
import type { KbService } from './services/kb-service.js';
import type { LlmService } from './services/llm-service.js';
import type { MemoryDigestService } from './services/memory-digest-service.js';
import type { MemoryService } from './services/memory-service.js';
import type { ReportService } from './services/report-service.js';
import type { SettingsService } from './services/settings-service.js';
import type { TaskService } from './services/task-service.js';

/**
 * 服务容器：HTTP 与 MCP 两种接入层共享同一份实例。
 * 为什么要显式列出来：接入层不该自己 new 仓库或服务，
 * 否则事务边界、时钟、审计会被复制成多份，测试也无法替换。
 */
export interface AppContext {
  config: AppConfig;
  db: Db;
  clock: Clock;
  startedAt: number;
  repos: {
    channels: ChannelRepo;
    cards: CardRepo;
    tasks: TaskRepo;
    memory: MemoryRepo;
    /** AIDash 自己的记忆（单行表），与按 project 分片的主对话记忆分开。 */
    assistantMemory: AssistantMemoryRepo;
    memoryDigest: MemoryDigestRepo;
    /** 汇报素材：从任务/卡片等持久化记录汇总，不单独建快照表。 */
    materials: MaterialRepo;
    reports: ReportRepo;
    artifacts: ArtifactRepo;
    harnesses: HarnessRepo;
    events: EventRepo;
    audit: AuditRepo;
    kb: KbRepo;
    setting: SettingRepo;
  };
  services: {
    audit: AuditService;
    channels: ChannelService;
    cards: CardService;
    decisions: DecisionService;
    tasks: TaskService;
    memory: MemoryService;
    assistantMemory: AssistantMemoryService;
    assistantMemoryLearner: AssistantMemoryLearner;
    memoryDigest: MemoryDigestService;
    reports: ReportService;
    kb: KbService;
    settings: SettingsService;
    llm: LlmService;
    enrichment: EnrichmentService;
  };
}
