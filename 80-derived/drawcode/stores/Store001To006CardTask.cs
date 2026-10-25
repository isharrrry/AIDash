// 本文件由 generate-stores.mjs 从 30-design/设计文档包/05-数据库设计说明.md 生成。
// 不要手改：改设计文档后运行 node 80-derived/drawcode/generate-stores.mjs 重新生成。
// 分组：通道 / 卡片 / 任务三域的表（1~6）。

using Drawcode;

namespace AidashTwin.Stores;

/// <summary>TBL-001 `channel` — 会话通道</summary>
[Drawcode(Store = true)]
public sealed class Store001Channel
{
    public string id = string.Empty;

    public string channel_key = string.Empty;

    public string? title;

    public string? harness_id;

    public string? project;

    public string? topic;

    /// <summary>002：项目根目录，≤500；旧通道可空</summary>
    public string? workdir;

    public string status = string.Empty;

    public long created_at;

    public long updated_at;

    public long? archived_at;

    /// <summary>007：最近一次 MCP tools/call 时间；判定通道在线</summary>
    public long? last_mcp_at;

}

/// <summary>TBL-002 `card` — 卡片</summary>
[Drawcode(Store = true)]
public sealed class Store002Card
{
    public string id = string.Empty;

    public string channel_id = string.Empty;

    public string type = string.Empty;

    public string status = string.Empty;

    public string priority = string.Empty;

    public string? title;

    public string? body_md;

    public string? background_md;

    /// <summary>002：决策卡“达到目的或结果”</summary>
    public string? goal_md;

    /// <summary>002：决策卡“调查参考”</summary>
    public string? research_md;

    /// <summary>002：决策卡“决策项描述”</summary>
    public string? decision_md;

    public string? message_md;

    public string? summary;

    public string? detail_md;

    public string? severity;

    public string? recipient;

    public string? channel_kind;

    public string? reason;

    public string? handoff_state;

    public string? options_json;

    public long allow_free_text;

    public string? default_action;

    public long? due_at;

    public string? answer_json;

    public long? answered_at;

    public string? artifact_url;

    public string? artifact_kind;

    public string? links_json;

    public string? result;

    public string? suggestions_json;

    public string? kb_refs_json;

    public double? confidence;

    public long blocking;

    public string? task_id;

    public string enrichment_status = string.Empty;

    public string? enrichment_json;

    public string? idempotency_key;

    public string? created_by;

    public long created_at;

    public long updated_at;

    public long? archived_at;

}

/// <summary>TBL-003 `card_event` — 卡片事件</summary>
[Drawcode(Store = true)]
public sealed class Store003CardEvent
{
    public long id;

    public string card_id = string.Empty;

    /// <summary>created/edited/answered/dismissed/expired/archived</summary>
    public string @event = string.Empty;

    /// <summary>token label 或 harness_id</summary>
    public string? actor;

    public string? detail_json;

    public long created_at;

}

/// <summary>TBL-004 `task` — 任务</summary>
[Drawcode(Store = true)]
public sealed class Store004Task
{
    public string id = string.Empty;

    public string channel_id = string.Empty;

    public string? parent_id;

    /// <summary>物化路径，如 /tk_root/tk_a/</summary>
    public string path = string.Empty;

    public string title = string.Empty;

    public string? description_md;

    /// <summary>004：task / suggestion</summary>
    public string kind = string.Empty;

    /// <summary>014：单值分类（可空，空白归一为 NULL）</summary>
    public string? category;

    /// <summary>015：结束通知已读时间；终态时清空</summary>
    public long? end_notice_read_at;

    public string status = string.Empty;

    public string priority = string.Empty;

    /// <summary>harness_id，可空</summary>
    public string? assignee;

    public string? tags_json;

    public long? due_at;

    public string? claimed_by;

    public string? claim_token;

    public long? claim_expires_at;

    /// <summary>002：首次认领时间</summary>
    public long? claimed_at;

    /// <summary>001：进入 in_progress 的时间</summary>
    public long? started_at;

    /// <summary>002：最近一次阻塞时间</summary>
    public long? blocked_at;

    /// <summary>002：完成时间</summary>
    public long? completed_at;

    /// <summary>002：失败时间</summary>
    public long? failed_at;

    /// <summary>002：取消时间</summary>
    public long? cancelled_at;

    public string? blocked_reason;

    public string? fail_reason;

    /// <summary>003：取消原因（cancel 必填）</summary>
    public string? cancel_reason;

    /// <summary>008：暂缓原因；非空即“已暂缓”</summary>
    public string? defer_reason;

    /// <summary>008：最近一次暂缓时间</summary>
    public long? deferred_at;

    /// <summary>008：计划恢复时间（可选）</summary>
    public long? deferred_until;

    /// <summary>012：隐患说明原文</summary>
    public string? risk_note;

    /// <summary>012：最近一次标记隐患时间</summary>
    public long? risk_flagged_at;

    /// <summary>012：隐患解除时间；NULL 表示未解除</summary>
    public long? risk_resolved_at;

    /// <summary>013：解除时的复盘结论（可选）</summary>
    public string? risk_resolution;

    /// <summary>证据卡 ID 数组</summary>
    public string? evidence_json;

    public string? idempotency_key;

    public string? created_by;

    public long created_at;

    public long updated_at;

}

/// <summary>TBL-005 `task_event` — 任务事件</summary>
[Drawcode(Store = true)]
public sealed class Store005TaskEvent
{
    public long id;

    public string task_id = string.Empty;

    /// <summary>created/submitted/claimed/started/blocked/unblocked/</summary>
    public string @event = string.Empty;

    public string? actor;

    public string? detail_json;

    public long created_at;

}

/// <summary>TBL-006 `artifact` — 产物引用</summary>
[Drawcode(Store = true)]
public sealed class Store006Artifact
{
    public string id = string.Empty;

    public string card_id = string.Empty;

    public string kind = string.Empty;

    public string url = string.Empty;

    public string? summary;

    public long? size_bytes;

    public long created_at;

}
