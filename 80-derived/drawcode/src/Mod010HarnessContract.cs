// MOD-010 Harness 契约。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
//
// 这个模块没有可执行代码，产物是 AGENTS.md / skills / 卡片模板三份文件契约。
// 在图上它只做一件事：把「安全约束」作为数据交给值守壳，让契约从文档变成可被引用的对象。

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-010 Harness 契约")]
public static class Mod010HarnessContract
{
    /// <summary>安全约束集合；值守壳加载它来约束 harness 的行为。</summary>
    [Drawcode(Direction.In, Alias = "安全约束", Path = "MOD-010/契约")]
    public static SafetyConstraintSet Safety;

    /// <summary>
    /// 导出 Agent 契约。内容随配置变化（例如 LLM 是否启用），
    /// 但「令牌只从环境变量读」「401 立即停止」这两条是硬约束，不随配置开关。
    /// </summary>
    [Drawcode(Alias = "导出契约", Path = "MOD-010/契约")]
    public static void ExportAgentContract()
    {
        var config = Mod007AuditConfig.Config;
        if (config is null)
        {
            return;
        }
        Safety = new SafetyConstraintSet();
    }

    /// <summary>
    /// 校验卡片模板。模板里的字段名必须与 card 表的列一一对应，
    /// 对不上时宁可启动失败，也不要让模板静默丢字段。
    /// </summary>
    [Drawcode(Alias = "校验模板", Path = "MOD-010/契约")]
    public static void ValidateCardTemplate()
    {
        var card = Mod002ChannelCard.Card;
        if (card is null)
        {
            return;
        }
    }
}
