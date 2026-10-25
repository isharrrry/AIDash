/**
 * 支撑仓库聚合入口（barrel）。
 *
 * 为什么保留这个文件：context/main/services/tests 已经依赖 `support-repos.js`
 * 这一条稳定路径；按 repo 拆文件后仍从这里导出，调用方不需要改 import。
 * 这里只做 re-export，不承载任何实现，避免再次长成 700 行的混合仓库。
 */
export { ArtifactRepo } from './artifact-repo.js';
export { AuditRepo } from './audit-repo.js';
export type { AuditFilter, AuditInput } from './audit-repo.js';
export { EventRepo } from './event-repo.js';
export { HarnessRepo } from './harness-repo.js';
export { KbRepo, segmentCjk } from './kb-repo.js';
export type { KbSearchHit, KbSearchOptions } from './kb-repo.js';
export { SettingRepo } from './setting-repo.js';
