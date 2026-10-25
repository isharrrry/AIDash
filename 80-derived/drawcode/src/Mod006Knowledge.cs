// MOD-006 知识库索引。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-006 知识库索引")]
public static class Mod006Knowledge
{
    /// <summary>
    /// OKF 源文档。产生方在孪生范围之外（XIF-003 只读目录），
    /// 所以按「本模块消费」声明为 Out —— 这是全线唯一一处 Direction.Out。
    /// </summary>
    [Drawcode(Direction.Out, Alias = "OKF 文档", External = true, Path = "MOD-006/知识库")]
    public static OkfDocument OkfDoc;

    /// <summary>知识引用：检索命中的路径与摘要，交给 MOD-005 拼进上下文。</summary>
    [Drawcode(Direction.In, Alias = "知识引用", Path = "MOD-006/知识库")]
    public static KbCitation Citation;

    /// <summary>
    /// 增量索引。按内容哈希判断是否变化，变了才重建该文档的 FTS 行；
    /// 全量重建在文档多时会把启动拖到分钟级。
    /// </summary>
    [Drawcode(Alias = "增量索引", Path = "MOD-006/知识库")]
    public static void IndexOkfDocument()
    {
        var doc = Mod006Knowledge.OkfDoc;
        if (doc is null)
        {
            return;
        }
        Citation = new KbCitation();
    }

    /// <summary>
    /// FTS 检索。路径必须先做规范化与越界检查（禁止 .. 逃出知识库根），
    /// 再做查询；否则一次精心构造的路径就能读到仓外文件。
    /// </summary>
    [Drawcode(Alias = "检索知识", Path = "MOD-006/知识库")]
    public static void SearchKnowledge()
    {
        var call = Mod001Entry.McpCall;
        if (call is null)
        {
            return;
        }
        Citation = new KbCitation();
    }
}
