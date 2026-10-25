// MOD-008 Web UI。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
//
// UI 在图上是一个「只读为主 + 两个动作」的模块：展示任务树/卡片/汇报，
// 但拖动任务与批量决策是两个真正改变后端状态的动作，它们的入参由这里产生。

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-008 Web UI")]
public static class Mod008WebUi
{
    /// <summary>拖动任务请求；由 UI 产生、MOD-003 处理。</summary>
    [Drawcode(Direction.In, Alias = "拖动任务请求", Path = "MOD-008/界面")]
    public static TaskMoveRequest MoveRequest;

    /// <summary>批量决策请求；由 UI 产生、MOD-004 处理。</summary>
    [Drawcode(Direction.In, Alias = "批量决策请求", Path = "MOD-008/界面")]
    public static DecisionBatch DecisionBatchRequest;

    /// <summary>
    /// 任务树看板。一次取整棵树（depth=10），前端本地过滤；
    /// 默认把已结束父节点拍平，要看原始层级得显式切「全部（含已结束）」。
    /// </summary>
    [Drawcode(Alias = "任务树看板", Path = "MOD-008/界面")]
    public static void RenderTaskBoard()
    {
        // UI 的每一次取数都来自 MOD-001 转过来的 REST 请求；没有它，这个页面不会刷新。
        var request = Mod001Entry.RestCall;
        var task = Mod003TaskTree.Task;
        var card = Mod002ChannelCard.Card;
        if (request is null || (task is null && card is null))
        {
            return;
        }
    }

    /// <summary>
    /// 拖动任务。前端先做「不能挂到自己/后代」的校验，
    /// 但服务端仍要再校验一次 —— 前端校验只是体验优化，不是安全边界。
    /// </summary>
    [Drawcode(Alias = "拖动任务", Path = "MOD-008/界面")]
    public static void DragTask()
    {
        var task = Mod003TaskTree.Task;
        if (task is null)
        {
            return;
        }
        MoveRequest = new TaskMoveRequest();
    }

    /// <summary>
    /// 决策面板提交。选完一组卡片后一次性提交，避免每点一次发一个请求。
    /// </summary>
    [Drawcode(Alias = "提交决策", Path = "MOD-008/界面")]
    public static void SubmitDecision()
    {
        var card = Mod002ChannelCard.Card;
        if (card is null)
        {
            return;
        }
        DecisionBatchRequest = new DecisionBatch();
    }

    /// <summary>
    /// 记忆页：展示归纳后的记忆条目。
    /// 没有这个出口，MOD-005 产出的 MemoryDigest 在图上就是一条断头路 ——
    /// 设计里确实有这一页（MOD-008 职责含「记忆页」），只是它不改变任何后端状态。
    /// </summary>
    [Drawcode(Alias = "展示记忆", Path = "MOD-008/界面")]
    public static void ShowMemory()
    {
        var digest = Mod005Enhance.Digest;
        if (digest is null)
        {
            return;
        }
    }

    /// <summary>汇报页：展示周期/专题汇报草稿与其数据来源。</summary>
    [Drawcode(Alias = "展示汇报", Path = "MOD-008/界面")]
    public static void ShowReport()
    {
        var report = Mod005Enhance.Report;
        if (report is null)
        {
            return;
        }
    }
}
