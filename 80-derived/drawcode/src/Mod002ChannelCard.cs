// MOD-002 通道与卡片服务。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-002 通道与卡片服务")]
public static class Mod002ChannelCard
{
    /// <summary>通道键：卡片的归属维度，也是任务树取数的过滤条件。</summary>
    [Drawcode(Direction.In, Alias = "通道键", Path = "MOD-002/卡片")]
    public static ChannelKey Channel;

    /// <summary>落库后的卡片；决策、任务证据守卫、UI 都读它。</summary>
    [Drawcode(Direction.In, Alias = "卡片记录", Path = "MOD-002/卡片")]
    public static CardRecord Card;

    /// <summary>卡片事件（只追加）；MOD-007 据此落审计。</summary>
    [Drawcode(Direction.In, Alias = "卡片事件", Path = "MOD-002/卡片")]
    public static CardEventEntry CardEvent;

    /// <summary>
    /// 最近一次业务失败的原因码。无 Direction，因此不是信号 ——
    /// 它是「给 MOD-001 错误映射用的旁路信息」，不是跨模块流动的数据。
    /// </summary>
    public static string? LastReasonCode;

    /// <summary>
    /// 通道 upsert：同一个 project/conversation 只会有一条通道记录。
    /// 幂等靠 channel_key 唯一约束，不靠先查后插（并发下先查后插必竞态）。
    /// </summary>
    [Drawcode(Alias = "通道 upsert", Path = "MOD-002/卡片")]
    public static void UpsertChannel()
    {
        var call = Mod001Entry.McpCall;
        if (call is null)
        {
            LastReasonCode = "CHANNEL_UPSERT_INVALID";
            return;
        }
        Channel = new ChannelKey();
    }

    /// <summary>
    /// 卡片落库。写 card + card_event 两张表，事件流只追加、不更新。
    /// 幂等键命中时直接返回既有卡片，不重复写事件。
    /// </summary>
    [Drawcode(Alias = "卡片发布", Path = "MOD-002/卡片")]
    public static void PostCard()
    {
        var call = Mod001Entry.McpCall;
        if (call is null)
        {
            LastReasonCode = "CARD_POST_INVALID";
            return;
        }
        Card = new CardRecord();
        CardEvent = new CardEventEntry();
    }

    /// <summary>
    /// 把决策服务的回答写回卡片状态。状态机 SM-002 由本模块与 MOD-004 共同维护：
    /// 回答合法性在 MOD-004 校验，状态落库在本模块。
    /// </summary>
    [Drawcode(Alias = "卡片回答", Path = "MOD-002/卡片")]
    public static void AnswerCard()
    {
        var answer = Mod004Decision.CardAnswer;
        if (answer is null)
        {
            LastReasonCode = "CARD_ANSWER_MISSING";
            return;
        }
        Card = new CardRecord();
        CardEvent = new CardEventEntry();
    }

    /// <summary>
    /// 超时置为过期。这是 SM-002 里唯一一条「不靠人」的转移：
    /// 决策服务扫到超时后必须由卡片服务落状态，否则卡片会永远停在 open。
    /// </summary>
    [Drawcode(Alias = "超时置过期", Path = "MOD-002/卡片")]
    public static void ExpireCard()
    {
        var timeout = Mod004Decision.Timeout;
        if (timeout is null)
        {
            return;
        }
        Card = new CardRecord();
        CardEvent = new CardEventEntry();
    }

    /// <summary>
    /// 把增强服务的建议写成「建议卡」。建议不是自动执行的动作，
    /// 落成卡片后走的是同一条人类确认路径（SM-002）。
    /// </summary>
    [Drawcode(Alias = "建议卡片化", Path = "MOD-002/卡片")]
    public static void PublishSuggestion()
    {
        var suggestion = Mod005Enhance.Suggestion;
        if (suggestion is null)
        {
            LastReasonCode = "SUGGESTION_EMPTY";
            return;
        }
        Card = new CardRecord();
        CardEvent = new CardEventEntry();
    }
}
