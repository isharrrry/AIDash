// MOD-003 任务树服务。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-003 任务树服务")]
public static class Mod003TaskTree
{
    /// <summary>任务节点；物化路径 path 决定层级，UI、增强、值守壳都读它。</summary>
    [Drawcode(Direction.In, Alias = "任务节点", Path = "MOD-003/任务树")]
    public static TaskNode Task;

    /// <summary>任务事件（只追加）；记录每一次状态转移与原因码。</summary>
    [Drawcode(Direction.In, Alias = "任务事件", Path = "MOD-003/任务树")]
    public static TaskEventEntry TaskEvent;

    /// <summary>认领租约；值守壳凭它续租与回报，过期即失去写权限。</summary>
    [Drawcode(Direction.In, Alias = "认领租约", Path = "MOD-003/任务树")]
    public static HarnessLease Lease;

    /// <summary>
    /// 建任务。父任务必须同通道，否则物化路径会跨树。
    /// 这是 SM-001 的起点：新建即 draft，submit 后才进 pending 等认领。
    /// </summary>
    [Drawcode(Alias = "建任务", Path = "MOD-003/任务树")]
    public static void CreateTask()
    {
        var call = Mod001Entry.McpCall;
        if (call is null)
        {
            return;
        }
        Task = new TaskNode();
        TaskEvent = new TaskEventEntry();
    }

    /// <summary>
    /// 拖动移动。禁用「挂到自己或自己后代下面」——否则子树会从树上消失。
    /// 移动后重写整棵子树的物化路径，不是只改被拖的那个节点。
    /// </summary>
    [Drawcode(Alias = "移动任务", Path = "MOD-003/任务树")]
    public static void MoveTask()
    {
        var move = Mod008WebUi.MoveRequest;
        if (move is null)
        {
            return;
        }
        Task = new TaskNode();
    }

    /// <summary>
    /// 认领任务。只允许 pending → claimed，且带租约；
    /// 同一 harness 重复认领是续租（返回原 claim_token），不是新租约。
    /// </summary>
    [Drawcode(Alias = "认领任务", Path = "MOD-003/任务树")]
    public static void ClaimTask()
    {
        var progress = Mod009ShellCli.Progress;
        if (progress is null)
        {
            return;
        }
        Task = new TaskNode();
        Lease = new HarnessLease();
        TaskEvent = new TaskEventEntry();
    }

    /// <summary>
    /// 带证据完成任务。证据必须挂在同一通道的卡片上（REQ-FN-020）；
    /// 找不到证据就拒绝，而不是让任务「悄悄完成」。
    /// </summary>
    [Drawcode(Alias = "带证据完成", Path = "MOD-003/任务树")]
    public static void CompleteWithEvidence()
    {
        var card = Mod002ChannelCard.Card;
        var lease = Mod003TaskTree.Lease;
        if (card is null || lease is null)
        {
            return;
        }
        Task = new TaskNode();
        TaskEvent = new TaskEventEntry();
    }
}
