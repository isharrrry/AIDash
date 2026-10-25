// MOD-005 增强服务。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-005 增强服务")]
public static class Mod005Enhance
{
    /// <summary>增强上下文：任务、卡片、知识引用拼成的提示词素材。</summary>
    [Drawcode(Direction.In, Alias = "增强上下文", Path = "MOD-005/增强")]
    public static ContextBundle Context;

    /// <summary>LLM 建议；交给 MOD-002 写成建议卡，不直接执行。</summary>
    [Drawcode(Direction.In, Alias = "LLM 建议", Path = "MOD-005/增强")]
    public static LlmSuggestion Suggestion;

    /// <summary>记忆归纳结果；按行去重、限长、过敏感扫描后落 TBL-013/015。</summary>
    [Drawcode(Direction.In, Alias = "记忆归纳", Path = "MOD-005/增强")]
    public static MemoryDigest Digest;

    /// <summary>周期/专题汇报草稿；交给 UI 展示。</summary>
    [Drawcode(Direction.In, Alias = "汇报草稿", Path = "MOD-005/增强")]
    public static ReportDraft Report;

    /// <summary>
    /// 组装上下文。输入只取「已确认的事实」：任务树、卡片、知识引用；
    /// 不把未确认的推测塞进提示词，否则 LLM 会把推测当事实复述。
    /// </summary>
    [Drawcode(Alias = "组装上下文", Path = "MOD-005/增强")]
    public static void BuildContext()
    {
        var task = Mod003TaskTree.Task;
        var card = Mod002ChannelCard.Card;
        var citation = Mod006Knowledge.Citation;
        if (task is null && card is null && citation is null)
        {
            return;
        }
        Context = new ContextBundle();
    }

    /// <summary>
    /// 调 LLM 生成建议。LLM 端点可选（XIF-004）：没配时整条增强链降级为
    /// 「只组装上下文、不生成建议」，而不是报错或返回空建议充数。
    /// </summary>
    [Drawcode(Alias = "生成建议", Path = "MOD-005/增强")]
    public static void GenerateSuggestion()
    {
        var context = Mod005Enhance.Context;
        var config = Mod007AuditConfig.Config;
        if (context is null || config is null)
        {
            return;
        }
        Suggestion = new LlmSuggestion();
    }

    /// <summary>
    /// 归纳记忆。同一行在多轮里重复出现只保留一条；超过上限就截，
    /// 不做「智能摘要」——摘要是 LLM 的活，归纳只负责去重与限长。
    /// </summary>
    [Drawcode(Alias = "归纳记忆", Path = "MOD-005/增强")]
    public static void DigestMemory()
    {
        var task = Mod003TaskTree.Task;
        var card = Mod002ChannelCard.Card;
        if (task is null && card is null)
        {
            return;
        }
        Digest = new MemoryDigest();
    }

    /// <summary>
    /// 生成汇报。周期汇报与专题汇报共用同一条组装链，只是时间窗与筛选条件不同。
    /// </summary>
    [Drawcode(Alias = "生成汇报", Path = "MOD-005/增强")]
    public static void ComposeReport()
    {
        var context = Mod005Enhance.Context;
        if (context is null)
        {
            return;
        }
        Report = new ReportDraft();
    }
}
