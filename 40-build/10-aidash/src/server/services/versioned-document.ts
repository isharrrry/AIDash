import { AppError } from '../../shared/errors.js';
import type { VersionedDocRow, VersionedDocUpsertResult } from '../repos/versioned-doc.js';

export interface VersionedDocumentWrite<TRow> {
  memory: TRow | undefined;
  changed: boolean;
}

export interface VersionedDocumentMerge {
  content: string;
  accepted: string[];
  skippedDuplicates: number;
}

/**
 * 两套记忆共用的“整篇替换”语义。
 *
 * 这里不碰数据库事务：追加需要把“读当前文档 → 去重 → 计算新内容 → 版本写入”
 * 放在同一个事务里，事务边界留给服务层；本函数只负责所有记忆都必须一致的三件事：
 * 1. 内容没变就不写、不升版本（Web 连点保存不能让其他终端的版本号失效）；
 * 2. 写入必须带 expected_version；
 * 3. 冲突统一返回 `MEMORY_VERSION_CONFLICT` 与 `actual_version`，附调用方给的合并提示。
 */
export function writeVersionedDocument<TRow extends VersionedDocRow>(input: {
  current: TRow | undefined;
  content: string;
  expectedVersion: number;
  actor: string;
  now: number;
  hint?: string;
  upsert: (
    content: string,
    expectedVersion: number,
    actor: string,
    now: number,
  ) => VersionedDocUpsertResult<TRow>;
}): VersionedDocumentWrite<TRow> {
  if ((input.current?.content_md ?? '') === input.content) {
    return { memory: input.current, changed: false };
  }

  const saved = input.upsert(
    input.content,
    input.expectedVersion,
    input.actor,
    input.now,
  );
  if (!saved.ok) {
    throw new AppError('CONFLICT', 'MEMORY_VERSION_CONFLICT', {
      expected_version: input.expectedVersion,
      actual_version: saved.actualVersion,
      ...(input.hint ? { hint: input.hint } : {}),
    });
  }
  return { memory: saved.memory, changed: true };
}

/**
 * 两套记忆共用的追加合并规则。
 *
 * 去重按整行 trim 后比较：缩进/尾随空格不同不应产生两条“看起来一样”的约束。
 * 行级校验（空白行、单行长度上限）留在各自服务层，因为主通道记忆与 AIDash 记忆
 * 对空白行/超长行的处理本来就不同；这里只处理已经合格的行。
 */
export function mergeVersionedLines(input: {
  currentContent: string | undefined;
  lines: string[];
  dedupe: boolean;
}): VersionedDocumentMerge {
  const base = (input.currentContent ?? '').replace(/\s+$/, '');
  const existing = new Set(base ? base.split('\n').map((line) => line.trim()) : []);
  const seen = new Set<string>();
  const accepted: string[] = [];
  let skippedDuplicates = 0;

  for (const line of input.lines) {
    const key = line.trim();
    if (input.dedupe && (existing.has(key) || seen.has(key))) {
      skippedDuplicates += 1;
      continue;
    }
    seen.add(key);
    accepted.push(line);
  }

  return {
    content: accepted.length === 0 ? base : base ? `${base}\n${accepted.join('\n')}` : accepted.join('\n'),
    accepted,
    skippedDuplicates,
  };
}
