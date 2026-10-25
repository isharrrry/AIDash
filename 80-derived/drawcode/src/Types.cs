// 领域类型的「名称替身」。
//
// importers/callers：只被同项目 src/Mod001~Mod011 的信号字段引用；AIDash 生产代码不引用本文件。
// affected API：无。data schema：无 —— 这些类不落地、不序列化，只借类型名让 drawcode 的
// 节点标签写出「哪个模块传了什么类型的什么数据」。真正的表结构在 30-design/05-数据库设计说明.md。
// 用户逐字原话：「我没找到AIDash仓的设计的孪生Drawcode工程在哪，是否做好了同步演进，补齐并检查」
//
// 为什么每个类型都是空 class：
// - drawcode 的 csparse 只把「带 Direction 特性的字段」当信号，普通类型声明不进图；
// - 这里要的不是可运行行为，而是图上一个能读懂的类型名。写字段反而会让「持久化数据」
//   （stores/ 下 Store=true 的类）与「跨模块流动的数据」两件事混在一起。
// - 刻意不用 record：drawcode 会整段跳过 record 声明（见 csparse.ts 的 RECORD_DECL_RE），
//   用 record 会让类型在解析时彻底消失。

namespace AidashTwin;

/// <summary>MCP 工具调用的统一入参信封（23 个工具共用）。</summary>
public sealed class McpToolCall { }

/// <summary>REST 请求；与 MCP 调用并列的第二种接入方式。</summary>
public sealed class RestRequest { }

/// <summary>统一错误体 <c>{code,message,retryable,details}</c>。</summary>
public sealed class ErrorEnvelope { }

/// <summary>通道键（<c>project/conversation</c> 形式）。</summary>
public sealed class ChannelKey { }

/// <summary>卡片草稿：尚未落库的卡片内容。</summary>
public sealed class CardDraft { }

/// <summary>已落库的卡片记录；决策与 UI 都读它。</summary>
public sealed class CardRecord { }

/// <summary>对卡片的回答；由决策服务产生、卡片服务落库。</summary>
public sealed class CardAnswer { }

/// <summary>卡片事件流的一条（只追加）。</summary>
public sealed class CardEventEntry { }

/// <summary>任务创建请求。</summary>
public sealed class TaskDraft { }

/// <summary>任务树节点；物化路径 <c>path</c> 决定层级。</summary>
public sealed class TaskNode { }

/// <summary>拖动任务请求：把 source 挂到新的 parent 下。</summary>
public sealed class TaskMoveRequest { }

/// <summary>任务状态变更事件；写事件表并联动审计。</summary>
public sealed class TaskStateChange { }

/// <summary>完成任务时必须挂上的证据卡引用。</summary>
public sealed class EvidenceCardRef { }

/// <summary>认领租约：</summary>
public sealed class HarnessLease { }

/// <summary>批量推进决策：一次回答多张待决卡片。</summary>
public sealed class DecisionBatch { }

/// <summary>决策超时：到期未回答，卡片转 expired。</summary>
public sealed class DecisionTimeout { }

/// <summary>增强上下文：任务、卡片、知识引用拼成的提示词素材。</summary>
public sealed class ContextBundle { }

/// <summary>LLM 生成的一条建议；由卡片服务写成建议卡。</summary>
public sealed class LlmSuggestion { }

/// <summary>记忆归纳结果：按行去重、限长、过敏感扫描后落 TBL-013/015。</summary>
public sealed class MemoryDigest { }

/// <summary>周期/专题汇报草稿。</summary>
public sealed class ReportDraft { }

/// <summary>知识库源文档（OKF 目录下的一篇）。</summary>
public sealed class OkfDocument { }

/// <summary>知识引用：检索命中的路径与摘要，挂在卡片或建议上。</summary>
public sealed class KbCitation { }

/// <summary>任务事件（只追加）；记录每一次状态转移与原因码。</summary>
public sealed class TaskEventEntry { }

/// <summary>接入域写审计的素材（认证失败、限流命中）。</summary>
public sealed class HarnessAuditNote { }

/// <summary>已落库的审计条目；健康指标与报告读它。</summary>
public sealed class AuditPersisted { }

/// <summary>运行时配置快照（表 TBL-011 + 环境变量合并后的结果）。</summary>
public sealed class RuntimeConfig { }

/// <summary>健康快照：<c>/api/health</c> 与 <c>/api/metrics</c> 的数据源。</summary>
public sealed class HealthSnapshot { }

/// <summary>Harness 必须遵守的安全约束集合（由 MOD-010 契约导出）。</summary>
public sealed class SafetyConstraintSet { }

/// <summary>Harness 心跳；离线判定依赖它。</summary>
public sealed class HarnessHeartbeat { }

/// <summary>值守壳回报的进度。</summary>
public sealed class ProgressReport { }

/// <summary>外部系统（范围外）：MOD-011 已移出本仓，图上只留一条虚线边界。</summary>
public sealed class ExternalSystemRecord { }
