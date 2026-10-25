// 本文件由 generate-stores.mjs 从 30-design/设计文档包/05-数据库设计说明.md 生成。
// 不要手改：改设计文档后运行 node 80-derived/drawcode/generate-stores.mjs 重新生成。
// 分组：记忆与汇报（13~18）。

using Drawcode;

namespace AidashTwin.Stores;

/// <summary>TBL-013 `project_memory` — 主通道记忆</summary>
[Drawcode(Store = true)]
public sealed class Store013ProjectMemory
{
    /// <summary>channel_key 的 project 段，一个主对话一份</summary>
    public string project = string.Empty;

    /// <summary>整篇 Markdown：唯一真相</summary>
    public string content_md = string.Empty;

    /// <summary>乐观锁版本</summary>
    public long version;

    public string? updated_by;

    public long created_at;

    public long updated_at;

}

/// <summary>TBL-014 `card_read` — 卡片已读</summary>
[Drawcode(Store = true)]
public sealed class Store014CardRead
{
    public string card_id = string.Empty;

    public long read_at;

}

/// <summary>TBL-015 `assistant_memory` — AIDash 助手记忆</summary>
[Drawcode(Store = true)]
public sealed class Store015AssistantMemory
{
    /// <summary>单行表；CHECK 把“只许一行”写进库</summary>
    public long id;

    public string content_md = string.Empty;

    public long version;

    public string? updated_by;

    public long created_at;

    public long updated_at;

}

/// <summary>TBL-016 `memory_digest_run` — 自动记忆归纳运行记录</summary>
[Drawcode(Store = true)]
public sealed class Store016MemoryDigestRun
{
    public string id = string.Empty;

    public string project = string.Empty;

    public string trigger = string.Empty;

    public long window_start;

    public long window_end;

    public long source_count;

    public long appended;

    public long skipped_duplicates;

    public string result = string.Empty;

    /// <summary>只存收敛后的错误码/短消息，不落上游响应体或请求头</summary>
    public string? error_message;

    /// <summary>本次真正追加成功的行（最多 5 行），供页面回显</summary>
    public string? lines_json;

    public long created_at;

}

/// <summary>TBL-017 `report` — 汇报</summary>
[Drawcode(Store = true)]
public sealed class Store017Report
{
    public string id = string.Empty;

    public string kind = string.Empty;

    public string period = string.Empty;

    /// <summary>2026-10-24 / 2026-W43 / 2026-10 / 2026-Q4 / 2026-H2 / 2026</summary>
    public string period_key = string.Empty;

    public string title = string.Empty;

    public string? content_md;

    public string status = string.Empty;

    public string? run_id;

    public string? error_message;

    public long source_count;

    /// <summary>专题汇报的“用户那段话”；周期汇报为 NULL</summary>
    public string? instruction_md;

    public string? model;

    public string? mode;

    public long? generated_at;

    public long created_at;

    public long updated_at;

}

/// <summary>TBL-018 `report_run` — 汇报更新批次</summary>
[Drawcode(Store = true)]
public sealed class Store018ReportRun
{
    public string id = string.Empty;

    public string kind = string.Empty;

    public string status = string.Empty;

    /// <summary>依次生成时的当前条目；失败/取消后保留最后位置</summary>
    public string? current_period;

    public long total;

    public long completed;

    public long cancel_requested;

    public string? error_message;

    /// <summary>专题更新已有汇报时指向目标；新建专题为 NULL</summary>
    public string? target_report_id;

    public string? instruction_md;

    public long started_at;

    public long? finished_at;

}
