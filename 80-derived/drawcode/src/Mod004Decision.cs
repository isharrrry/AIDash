// MOD-004 决策服务。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-004 决策服务")]
public static class Mod004Decision
{
    /// <summary>决策回答；产生后交给 MOD-002 落库（状态机 SM-002 的一半在这里）。</summary>
    [Drawcode(Direction.In, Alias = "决策回答", Path = "MOD-004/决策")]
    public static CardAnswer CardAnswer;

    /// <summary>决策超时；到期未回答的卡片转 expired，不是静默丢弃。</summary>
    [Drawcode(Direction.In, Alias = "决策超时", Path = "MOD-004/决策")]
    public static DecisionTimeout Timeout;

    /// <summary>
    /// 单张回答。校验回答是否在选项集合内、是否需要自由文本、
    /// 以及这张卡是不是已经被别的 harness 抢先答了（并发下必须用条件更新）。
    /// </summary>
    [Drawcode(Alias = "回答决策", Path = "MOD-004/决策")]
    public static void AnswerDecision()
    {
        var card = Mod002ChannelCard.Card;
        var call = Mod001Entry.McpCall;
        if (card is null || call is null)
        {
            return;
        }
        CardAnswer = new CardAnswer();
    }

    /// <summary>
    /// 批量推进：一次回答多张待决卡片。要么全成功要么全不动，
    /// 部分成功会让「哪些卡真的变了」无从追溯。
    /// </summary>
    [Drawcode(Alias = "批量推进", Path = "MOD-004/决策")]
    public static void BatchAdvance()
    {
        var batch = Mod008WebUi.DecisionBatchRequest;
        if (batch is null)
        {
            return;
        }
        CardAnswer = new CardAnswer();
    }

    /// <summary>
    /// 超时扫描。这是唯一「不靠人触发」的状态转移，
    /// 必须幂等：重复扫描到同一张卡不能重复写事件。
    /// </summary>
    [Drawcode(Alias = "超时过期", Path = "MOD-004/决策")]
    public static void ExpireDecisions()
    {
        var config = Mod007AuditConfig.Config;
        if (config is null)
        {
            return;
        }
        Timeout = new DecisionTimeout();
    }
}
