// MOD-011 外部系统（范围外）（已移出本仓）。
// 无 importers/callers：建模文件，仅被 drawcode 解析；不接入生产代码，不改现有 API/schema。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
//
// 它不实现、也不随 AIDash 发布。图上保留这个节点只有一个目的：
// 把边界画出来 —— 双方无接口、无配置、无凭证共享，AIDash 不持有它的地址与令牌。
// 用 External = true 画成虚线，避免读者以为本仓里还有一份实现。

using Drawcode;

namespace AidashTwin;

[Drawcode(Root = "MOD-011 外部系统（范围外）")]
public static class Mod011ExternalSystem
{
    /// <summary>
    /// 外部记录。方向标 Out 表示「本仓消费不到它」：
    /// 它属于另一条产品线，AIDash 只在文档里承认这条边界存在。
    /// </summary>
    [Drawcode(Direction.Out, Alias = "外部系统（范围外）", External = true, Path = "MOD-011/边界")]
    public static ExternalSystemRecord Ticket;
}
