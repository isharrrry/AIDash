// 本文件由 generate-stores.mjs 从 30-design/设计文档包/05-数据库设计说明.md 生成。
// 不要手改：改设计文档后运行 node 80-derived/drawcode/generate-stores.mjs 重新生成。
// 分组：审计、配置快照与迁移记录（10~12）。

using Drawcode;

namespace AidashTwin.Stores;

/// <summary>TBL-010 `audit_log` — 审计</summary>
[Drawcode(Store = true)]
public sealed class Store010AuditLog
{
    public long id;

    public long ts;

    /// <summary>token label / harness_id / 'system'</summary>
    public string? actor_label;

    /// <summary>card.post / card.answer / task.claim / config.update ...</summary>
    public string action = string.Empty;

    public string? object_type;

    public string? object_id;

    public string result = string.Empty;

    public string? request_id;

    /// <summary>只放可公开元数据</summary>
    public string? detail_json;

    /// <summary>上一条的 hash</summary>
    public string? prev_hash;

    /// <summary>sha256(prev_hash || 各字段)</summary>
    public string hash = string.Empty;

}

/// <summary>TBL-011 `setting` — 配置快照</summary>
[Drawcode(Store = true)]
public sealed class Store011Setting
{
    public string key = string.Empty;

    public string value_json = string.Empty;

    public long updated_at;

}

/// <summary>TBL-012 `schema_migration` — 迁移记录</summary>
[Drawcode(Store = true)]
public sealed class Store012SchemaMigration
{
    public long version;

    public string description = string.Empty;

    /// <summary>sha256(迁移文件内容)</summary>
    public string checksum = string.Empty;

    public long applied_at;

}
