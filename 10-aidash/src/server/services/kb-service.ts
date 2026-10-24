import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/time.js';
import type { Page } from '../../shared/types.js';
import type { KbRepo, KbSearchHit } from '../repos/support-repos.js';

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

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', 'dist', 'build']);

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
  ) {}

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
  ): { items: KbSearchHit[]; total: number } {
    const pageSize = options.top_k ?? options.page_size ?? 10;
    const page = options.page ?? 1;
    const items = this.repo.search(query, {
      type: options.type,
      tags: options.tags,
      top_k: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { items, total: items.length };
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
        const article = parseArticle(relative, raw);
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
    return report;
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

  stats(): ReturnType<KbRepo['stats']> & { configured: boolean; root: string | null } {
    const root = this.root();
    return { ...this.repo.stats(), configured: Boolean(root), root };
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
