/** 版本化文档的最小行形状：两张记忆表都只有这两个字段参与并发控制。 */
export interface VersionedDocRow {
  content_md: string;
  version: number;
}

export interface VersionedDocUpsertResult<TRow extends VersionedDocRow> {
  ok: boolean;
  /** 成功时是写入后的行；失败时是最新行（可能为 undefined），供服务层报告实际版本。 */
  memory?: TRow;
  actualVersion: number;
}

/** 仓储只需提供这三件事，插入/更新的 SQL 与表名仍留在各自仓储里。 */
export interface VersionedDocStore<TRow extends VersionedDocRow> {
  read(): TRow | undefined;
  insert(content: string, actor: string | null, now: number): number;
  update(content: string, expectedVersion: number, actor: string | null, now: number): number;
}

/**
 * 单篇 Markdown + 版本号的乐观锁写入。
 *
 * 为什么抽出来：project_memory 与 assistant_memory 的并发语义必须完全一致，
 * 任何一边单独“顺手优化”都会让两套记忆在冲突时表现不同。这里只保留
 * 两条路径——期望不存在（version=0）时插入，期望具体版本时条件更新；
 * 去重、长度上限、敏感词扫描仍属于服务层业务规则。
 *
 * `read` 在成功/失败后都会重读一次：返回值要能直接给调用方展示“当前真实版本”，
 * 不能让调用方拿着过期快照决定是否合并。
 */
export function upsertVersionedDocument<TRow extends VersionedDocRow>(
  store: VersionedDocStore<TRow>,
  content: string,
  expectedVersion: number,
  actor: string | null,
  now: number,
): VersionedDocUpsertResult<TRow> {
  if (expectedVersion === 0) {
    // 期望“还没有这篇文档”：由数据库的唯一键决定谁先创建。
    // ON CONFLICT DO NOTHING 会把“别人抢先写了”变成 changes=0，而不是覆盖。
    const inserted = store.insert(content, actor, now);
    if (inserted === 1) {
      return { ok: true, memory: store.read(), actualVersion: 1 };
    }
    const current = store.read();
    return { ok: false, memory: current, actualVersion: current?.version ?? 0 };
  }

  // 期望具体版本：只有版本仍匹配才写入，否则回传最新版本供调用方合并。
  const updated = store.update(content, expectedVersion, actor, now);
  if (updated === 1) {
    const saved = store.read();
    return { ok: true, memory: saved, actualVersion: saved?.version ?? expectedVersion + 1 };
  }
  const current = store.read();
  return { ok: false, memory: current, actualVersion: current?.version ?? 0 };
}
