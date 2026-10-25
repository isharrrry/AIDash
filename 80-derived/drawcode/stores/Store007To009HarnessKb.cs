// 本文件由 generate-stores.mjs 从 30-design/设计文档包/05-数据库设计说明.md 生成。
// 不要手改：改设计文档后运行 node 80-derived/drawcode/generate-stores.mjs 重新生成。
// 分组：Harness 与知识库（7~9）。

using Drawcode;

namespace AidashTwin.Stores;

/// <summary>TBL-007 `harness` — Harness 注册与心跳</summary>
[Drawcode(Store = true)]
public sealed class Store007Harness
{
    public string harness_id = string.Empty;

    public string name = string.Empty;

    public string? host;

    public string? capabilities_json;

    public string status = string.Empty;

    public long last_seen;

    public long registered_at;

    public long updated_at;

}

/// <summary>TBL-008 `kb_doc` — 知识库文档元数据</summary>
[Drawcode(Store = true)]
public sealed class Store008KbDoc
{
    public long id;

    /// <summary>相对 KB 根的路径</summary>
    public string path = string.Empty;

    /// <summary>来自 frontmatter，必填</summary>
    public string type = string.Empty;

    public string? title;

    public string? description;

    public string? tags_json;

    /// <summary>frontmatter timestamp，YYYY-MM-DD</summary>
    public string? doc_date;

    /// <summary>sha256(文件全文)</summary>
    public string hash = string.Empty;

    public long indexed_at;

}

/// <summary>TBL-009 `kb_fts` — 知识库全文索引</summary>
[Drawcode(Store = true)]
public sealed class Store009KbFts
{
    /// <summary>FTS5 虚表列（无 SQL 类型，按 TEXT 处理）</summary>
    public string? title;

    /// <summary>FTS5 虚表列（无 SQL 类型，按 TEXT 处理）</summary>
    public string? description;

    /// <summary>FTS5 虚表列（无 SQL 类型，按 TEXT 处理）</summary>
    public string? body;

    /// <summary>FTS5 虚表列（无 SQL 类型，按 TEXT 处理）</summary>
    public string? tags;

}
