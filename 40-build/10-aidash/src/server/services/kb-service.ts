import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/time.js';
import type { Page } from '../../shared/types.js';
import type { Logger } from '../log.js';
import type { KbRepo, KbSearchHit } from '../repos/support-repos.js';

/**
 * 搜索结果的降级标记。
 *
 * `degraded=true` 不等于出错：FTS 查询失败后仍会退回 LIKE 子串搜索，接口照常返回。
 * 但调用方必须能看到「这次结果不全」，否则用户会拿一份残缺结果当全量结论。
 */
export interface KbSearchDegraded {
  degraded: boolean;
  /** 只暴露稳定的错误码，绝不透传 SQLite 原始错误（可能含表结构细节）。 */
  degraded_reason?: 'FTS_QUERY_FAILED';
}

export interface KbArticle {
  path: string;
  type: string;
  title: string | null;
  description: string | null;
  tags: string[];
  doc_date: string | null;
  body: string;
  hash: string;
}

export interface KbIndexReport {
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  errors: Array<{ path: string; message: string }>;
}

/**
 * 索引运行状态。
 *
 * 异步索引把工作从请求线程挪到了后台，但“正在重建”不能只留在日志里：
 * 用户在设置页点完重建后需要一个可见反馈，否则只会以为按钮没反应、反复点。
 * `last_index` 只保留汇总与错误数，不把每条错误路径塞进 stats 响应。
 */
export interface KbIndexStatus {
  indexing: boolean;
  last_index: {
    scanned: number;
    indexed: number;
    unchanged: number;
    removed: number;
    error_count: number;
    finished_at: number;
  } | null;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', 'dist', 'build']);
/**
 * 异步索引每处理多少篇让出一次事件循环。
 *
 * 太小会让索引变慢（每篇都要排一次 setImmediate），太大又会重新出现
 * 「几秒钟不响应请求」的卡顿。25 篇在典型文档大小下约几十毫秒。
 */
const ASYNC_BATCH_SIZE = 25;

/**
 * 知识库只读索引（AGENTS §6：kb.* 只能读）。
 *
 * 路径安全是这里的头等大事：文档 path 直接来自调用方，
 * 必须归一化后确认仍落在 kbRoot 内，否则 `../` 就能读到仓库外的任何文件。
 */
export class KbService {
  /**
   * kbRoot 允许传 getter：设置页可以在运行时改 kb_root，
   * 如果在构造时冻结成字符串，改完必须重启才生效，和“运行时设置”的承诺不符。
   */
  constructor(
    private readonly kbRoot: string | null | (() => string | null),
    private readonly repo: KbRepo,
    private readonly clock: Clock,
    /** 可选：为 null 时降级只体现在返回值上，不写日志（测试与旧调用点可省略）。 */
    private readonly logger: Logger | null = null,
  ) {}

  /** 在途的异步索引数量；允许并发调用，所以用计数而不是布尔。 */
  private activeIndexes = 0;
  /** 最近一次成功完成的索引摘要（同步/异步都记录）。 */
  private lastIndex: KbIndexStatus['last_index'] = null;

  private root(): string | null {
    return typeof this.kbRoot === 'function' ? this.kbRoot() : this.kbRoot;
  }

  isConfigured(): boolean {
    return Boolean(this.root());
  }

  search(
    query: string,
    options: {
      type?: string;
      tags?: string[];
      top_k?: number;
      page?: number;
      page_size?: number;
    } = {},
  ): { items: KbSearchHit[]; total: number } & KbSearchDegraded {
    const pageSize = options.top_k ?? options.page_size ?? 10;
    const page = options.page ?? 1;
    // 回调里只记「发生了降级」和原始错误；是否要暴露给调用方由下面决定。
    let degradeError: unknown = null;
    let isDegraded = false;
    const items = this.repo.search(query, {
      type: options.type,
      tags: options.tags,
      top_k: pageSize,
      offset: (page - 1) * pageSize,
      onDegraded: (error) => {
        isDegraded = true;
        degradeError = error;
      },
    });
    if (!isDegraded) return { items, total: items.length, degraded: false };

    // 服务端日志留真实原因（排查需要），响应里只回稳定错误码。
    this.logger?.warn('kb_search_fts_degraded', {
      query: query.slice(0, 200),
      error: degradeError instanceof Error ? degradeError.message : String(degradeError),
    });
    return { items, total: items.length, degraded: true, degraded_reason: 'FTS_QUERY_FAILED' };
  }

  get(relativePath: string): KbArticle {
    const root = this.requireRoot();
    const absolute = safeJoin(root, relativePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new AppError('NOT_FOUND', 'KB_DOC_NOT_FOUND', {
        path: normalizeRelative(relativePath),
      });
    }
    const raw = fs.readFileSync(absolute, 'utf8');
    return parseArticle(normalizeRelative(relativePath), raw);
  }

  /** 全量扫描：新增/变化才写，磁盘上消失的从索引删除。 */
  index(): KbIndexReport {
    const root = this.requireRoot();
    const now = this.clock.now();
    const report: KbIndexReport = {
      scanned: 0,
      indexed: 0,
      unchanged: 0,
      removed: 0,
      errors: [],
    };

    const files = collectMarkdown(root, report);
    const seen = new Set<string>();
    for (const file of files) {
      report.scanned += 1;
      try {
        const relative = normalizeRelative(path.relative(root, file));
        seen.add(relative);
        const raw = fs.readFileSync(file, 'utf8');
        this.applyArticle(relative, raw, report, now);
      } catch (error) {
        report.errors.push({
          path: normalizeRelative(path.relative(root, file)),
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    for (const stale of this.repo.listPaths()) {
      if (!seen.has(stale)) {
        if (this.repo.removeByPath(stale)) report.removed += 1;
      }
    }
    // 同步索引也会占住事件循环，跑完同样留下可观测结果，避免 stats 里一片空白。
    this.lastIndex = summarizeReport(report, now);
    return report;
  }

  /**
   * 异步全量索引：行为与 index() 相同，但每处理一批就让出事件循环。
   *
   * 为什么需要它：index() 是同步循环，5000 篇文档时会把事件循环占住几秒到几十秒，
   * 定时索引一拍下来，HTTP 与 MCP 全部排队。这里用 fs.promises 读取、按批
   * `await setImmediate`，并接受 AbortSignal，关机时可以尽快停下。
   *
   * 事务边界仍然是“一篇一事务”（repo.upsertDoc 内部），没有把所有文件包进
   * 一个大事务：分批的目的就是缩短单次写锁持有时间，而不是制造更长的锁。
   *
   * 外层只负责“在途计数”，这样 /api/kb/stats 能在第一个 await 之前就看到
   * indexing=true；具体扫描逻辑放在 runIndexAsync，避免把状态管理混进循环。
   */
  async indexAsync(
    options: { signal?: AbortSignal; batchSize?: number } = {},
  ): Promise<KbIndexReport> {
    const root = this.requireRoot();
    this.activeIndexes += 1;
    try {
      return await this.runIndexAsync(root, options);
    } finally {
      this.activeIndexes -= 1;
    }
  }

  private async runIndexAsync(
    root: string,
    options: { signal?: AbortSignal; batchSize?: number },
  ): Promise<KbIndexReport> {
    const now = this.clock.now();
    const report: KbIndexReport = {
      scanned: 0,
      indexed: 0,
      unchanged: 0,
      removed: 0,
      errors: [],
    };
    const batchSize = Math.max(1, options.batchSize ?? ASYNC_BATCH_SIZE);
    throwIfAborted(options.signal);

    const files = await collectMarkdownAsync(root, report);
    throwIfAborted(options.signal);

    const seen = new Set<string>();
    let processed = 0;
    for (const file of files) {
      throwIfAborted(options.signal);
      report.scanned += 1;
      try {
        const relative = normalizeRelative(path.relative(root, file));
        seen.add(relative);
        const raw = await fs.promises.readFile(file, { encoding: 'utf8', signal: options.signal });
        this.applyArticle(relative, raw, report, now);
      } catch (error) {
        // 取消不是“这一篇索引失败”：继续跑完剩下的文件反而会拖住关机。
        if (options.signal?.aborted) throw abortReason(options.signal);
        report.errors.push({
          path: normalizeRelative(path.relative(root, file)),
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
      processed += 1;
      if (processed % batchSize === 0) await yieldToEventLoop();
    }

    for (const stale of this.repo.listPaths()) {
      throwIfAborted(options.signal);
      if (!seen.has(stale) && this.repo.removeByPath(stale)) report.removed += 1;
    }
    // 只有成功跑完才更新“最近一次结果”；被 abort 的调用不该覆盖上一次成功记录。
    this.lastIndex = summarizeReport(report, now);
    return report;
  }

  /** 同步与异步索引共用同一段“解析 + upsert”，避免两套实现慢慢长歪。 */
  private applyArticle(
    relativePath: string,
    raw: string,
    report: KbIndexReport,
    now: number,
  ): void {
    const article = parseArticle(relativePath, raw);
    const result = this.repo.upsertDoc(
      {
        path: article.path,
        type: article.type,
        title: article.title,
        description: article.description,
        tags_json: article.tags.length ? JSON.stringify(article.tags) : null,
        doc_date: article.doc_date,
        hash: article.hash,
        indexed_at: now,
      },
      article.body,
    );
    if (result.unchanged) report.unchanged += 1;
    else report.indexed += 1;
  }

  listDocs(options: { type?: string; page?: number; page_size?: number } = {}): Page<{
    path: string;
    type: string;
    title: string | null;
    description: string | null;
    tags: string[];
    doc_date: string | null;
  }> {
    const page = this.repo.listDocs(options);
    return {
      ...page,
      items: page.items.map((doc) => ({
        path: doc.path,
        type: doc.type,
        title: doc.title,
        description: doc.description,
        tags: parseTags(doc.tags_json),
        doc_date: doc.doc_date,
      })),
    };
  }

  stats(): ReturnType<KbRepo['stats']> &
    KbIndexStatus & { configured: boolean; root: string | null } {
    const root = this.root();
    return {
      ...this.repo.stats(),
      configured: Boolean(root),
      root,
      indexing: this.activeIndexes > 0,
      last_index: this.lastIndex,
    };
  }

  private requireRoot(): string {
    const root = this.root();
    if (!root) {
      throw new AppError('INVALID_ARGUMENT', 'KB_NOT_CONFIGURED', { key: 'kb_root' });
    }
    return path.resolve(root);
  }
}

/** 导出给测试直接验证穿越用例。 */
export function safeJoin(root: string, relativePath: string): string {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new AppError('INVALID_ARGUMENT', 'KB_PATH_UNSAFE', { path: normalized });
  }
  const absolute = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    throw new AppError('INVALID_ARGUMENT', 'KB_PATH_UNSAFE', { path: normalized });
  }
  return absolute;
}

export function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim();
}

/** front matter 解析失败不致命：整篇按正文处理，标题回退到一级标题。 */
export function parseArticle(relativePath: string, raw: string): KbArticle {
  const hash = createHash('sha256').update(raw).digest('hex');
  let meta: Record<string, unknown> = {};
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const header = raw.slice(3, end).trim();
      body = raw.slice(end + 4).replace(/^\s*\n/, '');
      try {
        const parsed = YAML.parse(header);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        // 非法 YAML 不阻断索引，保留正文即可。
      }
    }
  }

  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const tagsRaw = meta.tags ?? meta.tag;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map(String)
    : typeof tagsRaw === 'string'
      ? tagsRaw.split(/[,，\s]+/).filter(Boolean)
      : [];

  return {
    path: relativePath,
    type: typeof meta.type === 'string' ? meta.type : 'doc',
    title: typeof meta.title === 'string' ? meta.title : heading,
    description: typeof meta.description === 'string' ? meta.description : null,
    tags,
    doc_date:
      typeof meta.date === 'string'
        ? meta.date
        : typeof meta.doc_date === 'string'
          ? meta.doc_date
          : null,
    body,
    hash,
  };
}

/** 把完整报告压成 stats 里能安全返回的摘要；错误明细只留在响应外。 */
function summarizeReport(
  report: KbIndexReport,
  finishedAt: number,
): NonNullable<KbIndexStatus['last_index']> {
  return {
    scanned: report.scanned,
    indexed: report.indexed,
    unchanged: report.unchanged,
    removed: report.removed,
    error_count: report.errors.length,
    finished_at: finishedAt,
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('KB_INDEX_ABORTED');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 异步收集 Markdown 文件。
 *
 * 与同步版本保持完全相同的规则（跳过目录、2MB 上限、最多 5000 篇、符号链接不跟），
 * 只是把 readdir/stat 换成 promises 版本；每次 await 本身就会让出事件循环。
 */
async function collectMarkdownAsync(
  root: string,
  report: KbIndexReport,
  current: string = root,
  acc: string[] = [],
): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(current, { withFileTypes: true });
  } catch (error) {
    report.errors.push({
      path: normalizeRelative(path.relative(root, current)),
      message: error instanceof Error ? error.message : 'read_dir_failed',
    });
    return acc;
  }

  for (const entry of entries) {
    if (acc.length >= MAX_FILES) return acc;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectMarkdownAsync(root, report, absolute, acc);
      continue;
    }
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    try {
      const stat = await fs.promises.stat(absolute);
      if (stat.size > MAX_FILE_BYTES) {
        report.errors.push({
          path: normalizeRelative(path.relative(root, absolute)),
          message: 'file_too_large',
        });
        continue;
      }
    } catch {
      continue;
    }
    acc.push(absolute);
  }
  return acc;
}

function collectMarkdown(
  root: string,
  report: KbIndexReport,
  current: string = root,
  acc: string[] = [],
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch (error) {
    report.errors.push({
      path: normalizeRelative(path.relative(root, current)),
      message: error instanceof Error ? error.message : 'read_dir_failed',
    });
    return acc;
  }

  for (const entry of entries) {
    if (acc.length >= MAX_FILES) return acc;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectMarkdown(root, report, absolute, acc);
      continue;
    }
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    try {
      if (fs.statSync(absolute).size > MAX_FILE_BYTES) {
        report.errors.push({
          path: normalizeRelative(path.relative(root, absolute)),
          message: 'file_too_large',
        });
        continue;
      }
    } catch {
      continue;
    }
    acc.push(absolute);
  }
  return acc;
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
