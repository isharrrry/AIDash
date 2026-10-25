// MOD-007 审计与配置。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
//
// 这个模块被其余所有模块依赖，但在图上只有「出边」：它产出的 RuntimeConfig 被各模块读。
// 「审计」方向相反 —— 各模块写自己的事件，MOD-007 统一落库，所以是入边。

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-007 审计与配置")]
public static class Mod007AuditConfig
{
    /// <summary>运行时配置快照：TBL-011 与启动参数合并后的结果，全模块共享。</summary>
    [Drawcode(Direction.In, Alias = "运行时配置", Path = "MOD-007/审计与配置")]
    public static RuntimeConfig Config;

    /// <summary>已落库的审计条目；健康指标与汇报从它派生。</summary>
    [Drawcode(Direction.In, Alias = "已落库审计", Path = "MOD-007/审计与配置")]
    public static AuditPersisted AuditTrail;

    /// <summary>健康快照：/api/health 与 /api/metrics 的数据源。</summary>
    [Drawcode(Direction.In, Alias = "健康快照", Path = "MOD-007/审计与配置")]
    public static HealthSnapshot Health;

    /// <summary>
    /// 配置加载与校验。Schema 校验必须在启动时做且失败即退出，
    /// 不能「读不到就用默认值」——那会让配置错误在运行期静默变现。
    /// </summary>
    [Drawcode(Alias = "加载配置", Path = "MOD-007/审计与配置")]
    public static void LoadConfig()
    {
        Config = new RuntimeConfig();
    }

    /// <summary>
    /// 迁移。版本号单调递增，已应用的不重复执行；
    /// 迁移失败必须回滚并拒绝启动，不能留下半迁移的库。
    /// </summary>
    [Drawcode(Alias = "执行迁移", Path = "MOD-007/审计与配置")]
    public static void MigrateSchema()
    {
        var config = Mod007AuditConfig.Config;
        if (config is null)
        {
            return;
        }
        AuditTrail = new AuditPersisted();
    }

    /// <summary>
    /// 审计落库。只追加、不提供删除 API（REQ-FN-061）；
    /// 保留期清理是唯一的删入口，且必须留「已清理到哪个水位」的记录。
    /// </summary>
    [Drawcode(Alias = "审计落库", Path = "MOD-007/审计与配置")]
    public static void WriteAuditTrail()
    {
        var access = Mod001Entry.AccessAudit;
        var cardEvent = Mod002ChannelCard.CardEvent;
        var taskEvent = Mod003TaskTree.TaskEvent;
        if (access is null && cardEvent is null && taskEvent is null)
        {
            return;
        }
        AuditTrail = new AuditPersisted();
    }

    /// <summary>
    /// 健康指标。库可写、知识库可读、LLM 端点可达三项分别报告，
    /// 不要合成一个布尔值 —— 「哪个子系统坏了」比「坏了」有用。
    /// </summary>
    [Drawcode(Alias = "健康检查", Path = "MOD-007/审计与配置")]
    public static void CheckHealth()
    {
        var trail = Mod007AuditConfig.AuditTrail;
        if (trail is null)
        {
            return;
        }
        Health = new HealthSnapshot();
    }
}
