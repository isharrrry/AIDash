// drawcode 元数据模板（C#）。
//
// 用法、参数表、可读成员与构建约束见 docs/templates.md 的「C# template (.NET)」一节；
// 本文件只保留特性定义本身。
//
// 把本文件复制进你的工程即可，不需要任何 NuGet 包或构建步骤。
// 特性编译进程序集后，`drawcode inspect` / VS Code 插件从元数据里读回声明，
// 再从 IL 的 ldsfld/stsfld 还原读写边 —— 不需要源码、也不会执行你的程序集。
//
// 与旧版模板的差异只有新增的四个命名参数，
// 旧的 [Drawcode(Direction.In, Unit = "V", Alias = "电压")] 原样编译、行为不变。

using System;

namespace Drawcode;

/// <summary>信号方向。</summary>
/// <remarks>
/// 注意 <see cref="In"/> / <see cref="Out"/> 的语义按「相对模块」定义，
/// 与很多人的直觉相反；drawcode 按枚举名原样映射，不做纠正。
/// </remarks>
[Drawcode(Exclude = true)]
public enum Direction
{
    /// <summary>Not a signal — the annotated member is only documented.</summary>
    None,

    /// <summary>Produced by the module (a source of data).</summary>
    In,

    /// <summary>Consumed by the module (a sink of data).</summary>
    Out,

    /// <summary>Bidirectional.</summary>
    Io,
}

/// <summary>
/// Marks a field, property, method or type as part of the generated diagram, and carries
/// the metadata that would otherwise live in a drawcode comment.
/// </summary>
/// <remarks>
/// <para>
/// 字段/属性要成为<b>信号</b>必须同时满足：<c>Direction != None</c>，且可被 IL 直接访问
/// （<c>static</c> 字段最稳妥）。<c>const</c> 会被 C# 编译器内联成字面量，IL 里没有字段访问，
/// 读不到；<c>static readonly</c> 仍编译为 <c>ldsfld</c>，可以读到。
/// </para>
/// <para>
/// 不要对带本特性的程序集开启 <c>PublishTrimmed</c> 或 <c>PublishSingleFile</c>：
/// 裁剪可能移除未被引用的特性/字段，单文件会把元数据藏进 bundle，读取器都读不到。
/// </para>
/// </remarks>
[Drawcode(Exclude = true)]
[AttributeUsage(
    AttributeTargets.Field | AttributeTargets.Property | AttributeTargets.Method |
    AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Enum |
    AttributeTargets.Interface,
    AllowMultiple = false,
    Inherited = false)]
public sealed class DrawcodeAttribute : Attribute
{
    public DrawcodeAttribute(Direction direction = Direction.None) => Direction = direction;

    /// <summary>Signal direction. Positional so an editor completes <c>Direction.</c> for you.</summary>
    public Direction Direction { get; }

    /// <summary>Physical unit, shown on the node.</summary>
    public string? Unit { get; set; }

    /// <summary>Human-readable name, shown instead of the identifier.</summary>
    public string? Alias { get; set; }

    /// <summary>Longer prose attached to the node.</summary>
    public string? Note { get; set; }

    /// <summary>Hover text in draw.io.</summary>
    public string? Tooltip { get; set; }

    /// <summary>Render the node in the dashed "external" style.</summary>
    public bool External { get; set; }

    /// <summary>Image path recorded on the node. The path is recorded, never resolved.</summary>
    public string? Asset { get; set; }

    /// <summary>
    /// Container hierarchy, e.g. <c>"adc/采样前端"</c>. Slash-separated; each segment becomes a
    /// nested box and the last one is the node's own box title.
    /// </summary>
    public string? Path { get; set; }

    // —— 以下为产物视图新增；全部可选，不影响旧代码 ——

    /// <summary>
    /// Comma-separated business tags, e.g. <c>"rmem,telemetry"</c>.
    /// Used by the viewer's filter box; tags are stored as separate strings.
    /// </summary>
    public string? Tags { get; set; }

    /// <summary>
    /// Marks a type as persistent data. Types with <c>Store = true</c> appear in the
    /// viewer's ER table, together with their fields' names, types and offsets.
    /// </summary>
    public bool Store { get; set; }

    /// <summary>
    /// Marks a type/module as a root of the ICD decomposition. When any root exists, the
    /// module tree initially lists only roots; the user can switch to "show all".
    /// </summary>
    public string? Root { get; set; }

    /// <summary>
    /// Hides the entity from the tree by default. It is still present in the model and
    /// becomes visible when the user enables "show excluded".
    /// </summary>
    public bool Exclude { get; set; }

    /// <summary>
    /// Debug-time initial value, e.g. <c>"0"</c> or an enum member name <c>"Idle"</c>.
    /// The viewer shows it in the groupbox's “初值” column. Enum signals may omit it:
    /// the reader then fills in the member whose value is 0.
    /// </summary>
    public string? Initial { get; set; }
}

/// <summary>Marks the accessor of an external device, e.g. <c>AdcRead()</c>.</summary>
[Drawcode(Exclude = true)]
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)]
public sealed class DeviceAttribute : Attribute
{
    /// <summary>Device manufacturer.</summary>
    public string? Vendor { get; set; }

    /// <summary>Part number.</summary>
    public string? Model { get; set; }

    /// <summary>Free-form specification string, e.g. <c>16bit/860SPS</c>.</summary>
    public string? Spec { get; set; }

    /// <summary>Package size, e.g. <c>2.0x3.0mm</c>.</summary>
    public string? Size { get; set; }

    /// <summary>Image path recorded on the node.</summary>
    public string? Asset { get; set; }
}
