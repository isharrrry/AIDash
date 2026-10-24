import { newRequestId } from '../../shared/ids.js';
import type { Clock } from '../../shared/time.js';
import type { Ctx } from '../../shared/types.js';
import type { ReportRepo } from '../repos/report-repo.js';
import type { AssistantMemoryService } from './assistant-memory-service.js';
import type { AuditService } from './audit-service.js';
import type { LlmService } from './llm-service.js';
import { sanitizeDigestLines } from './memory-digest-service.js';

/** 一次学习最多新增几行：记忆是长期经验，不是把汇报再抄一遍。 */
const MAX_LEARNED_LINES = 3;
/** 单条汇报喂给模型的正文上限；超长汇报（如年报）只取前段，仍保留结论。 */
const MAX_REPORT_CHARS = 6_000;
/** 所有汇报加起来的正文上限，防止一次学习吃光模型上下文。 */
const MAX_MATERIAL_CHARS = 36_000;
/** 已有记忆只回传前段用于去重参考；太长时让模型少看到一些旧内容，也比超上下文好。 */
const MAX_EXISTING_CHARS = 8_000;
const LEARN_MAX_TOKENS = 1_024;

export type AssistantMemoryLearnResult = 'ok' | 'empty' | 'skipped' | 'failed';

export interface AssistantMemoryLearnOutcome {
  run_id: string;
  result: AssistantMemoryLearnResult;
  appended: number;
  skipped_duplicates: number;
  error_message: string | null;
}

export interface AssistantMemoryLearnerDeps {
  reports: ReportRepo;
  memory: AssistantMemoryService;
  llm: LlmService;
  audit: AuditService;
  clock: Clock;
}

/**
 * 汇报完成后自动更新 AIDash 自己的记忆。
 *
 * 为什么要等“汇报批次完成”才学：
 * - 单条汇报只是片段，一批（尤其周期更新）才包含同一时间窗内的完整视角；
 * - 学到的内容要能反过来改进下一次汇报，放在批次结束后，下一次生成就能用上；
 * - 失败/取消的批次不触发，避免把半成品当成结论记进长期记忆。
 *
 * 约束：
 * - 绝不抛出异常。学习是旁路，不能把已经完成（done）的汇报批次改成 failed；
 * - 调用模型时关闭“注入 AIDash 记忆”，否则同一份记忆既在 system 里又在 user 里，
 *   既浪费 token，也容易让模型直接复述旧记忆而不是提炼本次的新经验；
 * - 写入走 AssistantMemoryService，继承去重、敏感词扫描与 64,000 字符上限。
 */
export class AssistantMemoryLearner {
  /** 同一批次正在学习时再次触发直接跳过：重复调用不应产生两次模型费用与重复行。 */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: AssistantMemoryLearnerDeps) {}

  async learn(runId: string): Promise<AssistantMemoryLearnOutcome> {
    if (this.inFlight.has(runId)) {
      return {
        run_id: runId,
        result: 'skipped',
        appended: 0,
        skipped_duplicates: 0,
        error_message: null,
      };
    }
    this.inFlight.add(runId);
    try {
      return await this.doLearn(runId);
    } catch (error) {
      // 理论上 doLearn 已经内部兜底；这里再兜一层，保证调用方永远拿到结果而不是 rejection。
      const message = errorText(error);
      this.recordAudit(runId, 'error', { error: message });
      return {
        run_id: runId,
        result: 'failed',
        appended: 0,
        skipped_duplicates: 0,
        error_message: message,
      };
    } finally {
      this.inFlight.delete(runId);
    }
  }

  private async doLearn(runId: string): Promise<AssistantMemoryLearnOutcome> {
    const deps = this.deps;
    if (!deps.llm.isConfigured()) {
      // 正常路径不会走到：汇报本身就要求模型已配置。保留判断是为了将来从别处调用时
      // 不把“没配模型”记成一次失败学习。
      return {
        run_id: runId,
        result: 'skipped',
        appended: 0,
        skipped_duplicates: 0,
        error_message: null,
      };
    }

    const reports = deps.reports.listReadyByRun(runId);
    if (reports.length === 0) {
      return {
        run_id: runId,
        result: 'empty',
        appended: 0,
        skipped_duplicates: 0,
        error_message: null,
      };
    }

    const existing = deps.memory.get().content_md;
    let content: string;
    try {
      content = await deps.llm.chat({
        system: deps.llm.prompt('assistant_memory'),
        user: buildLearnPrompt(reports, existing),
        maxTokens: LEARN_MAX_TOKENS,
        // 关掉注入：要学的内容已经在 user 里，重复注入只会挤占上下文。
        withAssistantMemory: false,
      });
    } catch (error) {
      const message = errorText(error);
      this.recordAudit(runId, 'error', { error: message });
      return {
        run_id: runId,
        result: 'failed',
        appended: 0,
        skipped_duplicates: 0,
        error_message: message,
      };
    }

    const lines = sanitizeDigestLines(content).slice(0, MAX_LEARNED_LINES);
    if (lines.length === 0) {
      // 模型认为“这次没有值得长期保留的经验”是合法结果，不是失败。
      return {
        run_id: runId,
        result: 'empty',
        appended: 0,
        skipped_duplicates: 0,
        error_message: null,
      };
    }

    const ctx: Ctx = {
      actorLabel: 'assistant-memory',
      requestId: newRequestId(),
      isOwner: false,
    };
    try {
      const appended = deps.memory.append(lines, ctx, { dedupe: true });
      this.recordAudit(runId, 'ok', {
        appended: appended.appended,
        skipped_duplicates: appended.skipped_duplicates,
      });
      return {
        run_id: runId,
        result: appended.appended > 0 ? 'ok' : 'empty',
        appended: appended.appended,
        skipped_duplicates: appended.skipped_duplicates,
        error_message: null,
      };
    } catch (error) {
      const message = errorText(error);
      this.recordAudit(runId, 'error', { error: message });
      return {
        run_id: runId,
        result: 'failed',
        appended: 0,
        skipped_duplicates: 0,
        error_message: message,
      };
    }
  }

  /**
   * 审计是旁路：写审计失败不能反过来把学习判成失败。
   * 只记结论与计数，不记模型输出原文（可能很长，也没必要复制一份）。
   */
  private recordAudit(
    runId: string,
    result: 'ok' | 'error',
    details: Record<string, unknown>,
  ): void {
    try {
      this.deps.audit.record(
        { actorLabel: 'assistant-memory', requestId: `assistant_memory_${runId}`, isOwner: false },
        'assistant_memory.learn',
        result,
        'report_run',
        runId,
        details,
      );
    } catch {
      // 审计写不进去时，汇报结果也不该受影响。
    }
  }
}

/**
 * 组装学习提示词。
 *
 * 把“已有记忆”和“本次汇报”分成两段，并明确告诉模型已有记忆不要重复：
 * 精确去重只能挡住一字不差的重复，模型知道哪些已经记过，才能主动换角度补充。
 */
export function buildLearnPrompt(
  reports: Array<{ title: string; content_md: string | null }>,
  existing: string,
): string {
  const lines: string[] = [
    '以下是刚生成完成的一批汇报。请从中提炼 AIDash 以后做汇报/分析时能复用的经验。',
    '',
    '已有 AIDash 记忆（不要重复；没有就写“（空）”）：',
    clip(existing.trim() || '（空）', MAX_EXISTING_CHARS),
    '',
    '本次汇报：',
  ];

  let budget = MAX_MATERIAL_CHARS;
  for (const report of reports) {
    if (budget <= 0) {
      lines.push('（其余汇报已省略）');
      break;
    }
    const body = clip((report.content_md ?? '').trim(), Math.min(MAX_REPORT_CHARS, budget));
    budget -= body.length;
    lines.push(`## ${report.title}`, body || '（空）', '');
  }

  lines.push('只输出 JSON，不要代码块，不要解释。');
  return lines.join('\n');
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  // 按行截断，避免把一句话切成两半；找不到换行时才硬截。
  const cut = value.slice(0, max);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > max * 0.5 ? cut.slice(0, lastBreak) : cut}\n…（已截断）`;
}

/** 只保留错误码/信息，不把上游响应体带进记忆或审计。 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
