// MOD-009 值守壳 CLI。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
//
// 它是唯一「从外部进程发起」的模块：注册心跳、认领任务、起 harness、回报进度。
// 图上它的入边来自任务树（看有哪些可认领），出边回到接入层（心跳）。

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-009 值守壳 CLI")]
public static class Mod009ShellCli
{
    /// <summary>心跳；MOD-001 认证时据此判断 harness 是否在线。</summary>
    [Drawcode(Direction.In, Alias = "Harness 心跳", Path = "MOD-009/值守壳")]
    public static HarnessHeartbeat Heartbeat;

    /// <summary>进度回报；交给 MOD-003 更新任务状态。</summary>
    [Drawcode(Direction.In, Alias = "进度回报", Path = "MOD-009/值守壳")]
    public static ProgressReport Progress;

    /// <summary>
    /// 注册并维持心跳。离线判定用「最后一次心跳 + 阈值」，
    /// 不用进程存活 —— CLI 崩了进程表里也查不到，两者是两回事。
    /// </summary>
    [Drawcode(Alias = "注册心跳", Path = "MOD-009/值守壳")]
    public static void RegisterHarness()
    {
        var config = Mod007AuditConfig.Config;
        if (config is null)
        {
            return;
        }
        Heartbeat = new HarnessHeartbeat();
    }

    /// <summary>
    /// 认领下一个可做的任务。按优先级 + 创建时间取，不按 id 排序；
    /// 认领失败（别人抢先）是正常竞争，换下一个而不是重试。
    /// </summary>
    [Drawcode(Alias = "认领下一个", Path = "MOD-009/值守壳")]
    public static void ClaimNextTask()
    {
        var task = Mod003TaskTree.Task;
        if (task is null)
        {
            return;
        }
        Progress = new ProgressReport();
    }

    /// <summary>
    /// 回报进度。超时与失败都要回报，不能只在成功时说话 ——
    /// 沉默的任务会被误判成「还在跑」。
    /// </summary>
    [Drawcode(Alias = "回报进度", Path = "MOD-009/值守壳")]
    public static void ReportProgress()
    {
        var task = Mod003TaskTree.Task;
        if (task is null)
        {
            return;
        }
        Progress = new ProgressReport();
    }

    /// <summary>
    /// 加载安全约束（来自 MOD-010 的契约）：令牌只从环境变量读、
    /// 收到 401 立即停止不重试、不代持第三方凭据。
    /// </summary>
    [Drawcode(Alias = "加载安全约束", Path = "MOD-009/值守壳")]
    public static void LoadSafetyConstraints()
    {
        var constraints = Mod010HarnessContract.Safety;
        if (constraints is null)
        {
            return;
        }
    }
}
