// MOD-001 HTTP/MCP 入口。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入 AIDash 生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
//
// 建模口径（全项目统一，其余模块同此）：
// - 只在本模块声明「本模块产生」的信号（Direction.In = 相对本模块是产出）；
// - 消费别人的信号只在函数体里读，不重复声明 —— drawcode 按信号名全局映射，
//   同名声明后写的会覆盖先写的，重复声明会让边指向错误的文件。
// - 函数体必须是能编译的真代码：边是从函数体的读写语句扫出来的，注释不产生任何边。

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-001 HTTP/MCP 入口")]
public static class Mod001Entry
{
    /// <summary>23 个 MCP 工具的统一入参信封，产生后交给业务模块。</summary>
    [Drawcode(Direction.In, Alias = "MCP 工具调用", Path = "MOD-001/接入")]
    public static McpToolCall McpCall;

    /// <summary>REST 请求；与 MCP 并列的第二种接入方式。</summary>
    [Drawcode(Direction.In, Alias = "REST 请求", Path = "MOD-001/接入")]
    public static RestRequest RestCall;

    /// <summary>统一错误体；所有业务的失败最终都从这里出。</summary>
    [Drawcode(Direction.In, Alias = "错误信封", Path = "MOD-001/接入")]
    public static ErrorEnvelope ErrorOut;

    /// <summary>认证失败 / 限流命中的审计素材，交给 MOD-007 落库。</summary>
    [Drawcode(Direction.In, Alias = "接入审计素材", Path = "MOD-001/接入")]
    public static HarnessAuditNote AccessAudit;

    /// <summary>
    /// 把一次请求拆成「工具名 + 通道 + 参数」并交给业务模块。
    /// 这是整棵调用链的起点：下游所有模块消费的都是这里产出的 McpCall。
    /// </summary>
    [Drawcode(Alias = "路由分发", Path = "MOD-001/接入")]
    public static void RouteRequest()
    {
        McpCall = new McpToolCall();
        RestCall = new RestRequest();
    }

    /// <summary>
    /// 认证 + 限流。按令牌限流（REQ-FN-028：每令牌 300/分钟，burst 60），
    /// 不是按 IP —— 同一台机器可能同时跑多个 harness。
    /// 心跳来自 MOD-009，配置来自 MOD-007；两者都读不到时按「离线」处理并写审计。
    /// </summary>
    [Drawcode(Alias = "认证与限流", Path = "MOD-001/接入")]
    public static void AuthenticateCaller()
    {
        var heartbeat = Mod009ShellCli.Heartbeat;
        var config = Mod007AuditConfig.Config;
        if (heartbeat is null || config is null)
        {
            AccessAudit = new HarnessAuditNote();
            ErrorOut = new ErrorEnvelope();
        }
    }

    /// <summary>把业务模块抛上来的原因码翻译成统一错误体（含 retryable）。</summary>
    [Drawcode(Alias = "错误映射", Path = "MOD-001/接入")]
    public static void MapError()
    {
        var code = Mod002ChannelCard.LastReasonCode;
        if (code is not null)
        {
            ErrorOut = new ErrorEnvelope();
        }
    }
}
