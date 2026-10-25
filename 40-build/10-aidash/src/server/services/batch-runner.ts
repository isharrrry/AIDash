export type BatchRunOutcome = 'done' | 'cancelled' | 'halted' | 'failed';

/**
 * begin 的两种结果。
 *
 * 用显式 kind 而不是“看有没有 halt 字段”：TContext 是泛型，业务上下文
 * 恰好带 halt 属性时不能被误判成中止。
 */
export type BatchPreparation<TContext> =
  | { kind: 'continue'; context: TContext }
  | { kind: 'halt'; reason: string };

export interface BatchRunHooks<TItem, TContext, TResult> {
  /** 取消标记以数据库为准；这里只读状态，不负责收尾。 */
  isCancelled(): boolean;
  /**
   * 进入一条前准备上下文；抛出的异常视为批次级故障（交给上层兜底），
   * 返回 halt 则按“目标已不存在”这类预期中止处理。
   */
  begin(item: TItem, completed: number): BatchPreparation<TContext>;
  execute(item: TItem, context: TContext, signal: AbortSignal): Promise<TResult>;
  /** 模型返回后已再次检查取消；确认未取消才会进入这里。 */
  complete(item: TItem, context: TContext, result: TResult, completed: number): void;
  /** context 为空表示“在开始下一条之前就发现取消”，此时没有当前条目需要标记。 */
  cancelled(context: TContext | undefined, completed: number): void;
  halted(item: TItem, reason: string, completed: number): void;
  failed(
    item: TItem,
    context: TContext,
    error: unknown,
    reason: string,
    completed: number,
  ): void;
  done(completed: number): void;
  reasonForError(error: unknown): string;
}

/**
 * 逐条推进一个批次。
 *
 * 为什么把顺序写死在这里：报告、专题以及未来其他批次的取消语义必须一致——
 * 每条开始前查一次取消；模型返回后再查一次，避免把取消前已经返回的
 * 半成品写进库；失败时不再开始后续条目。把这三处判定留在各服务里，
 * 迟早会出现某个批次“取消后还多写一条”的分叉。
 */
export async function runBatch<TItem, TContext, TResult>(
  items: readonly TItem[],
  signal: AbortSignal,
  hooks: BatchRunHooks<TItem, TContext, TResult>,
): Promise<BatchRunOutcome> {
  let completed = 0;

  for (const item of items) {
    if (hooks.isCancelled()) {
      hooks.cancelled(undefined, completed);
      return 'cancelled';
    }

    const prepared = hooks.begin(item, completed);
    if (prepared.kind === 'halt') {
      hooks.halted(item, prepared.reason, completed);
      return 'halted';
    }

    try {
      const result = await hooks.execute(item, prepared.context, signal);
      if (hooks.isCancelled()) {
        hooks.cancelled(prepared.context, completed);
        return 'cancelled';
      }
      completed += 1;
      hooks.complete(item, prepared.context, result, completed);
    } catch (error) {
      if (hooks.isCancelled()) {
        hooks.cancelled(prepared.context, completed);
        return 'cancelled';
      }
      hooks.failed(item, prepared.context, error, hooks.reasonForError(error), completed);
      return 'failed';
    }
  }

  hooks.done(completed);
  return 'done';
}

/**
 * 后台批次的生命周期管理器。
 *
 * 负责“这一批还在不在当前进程里跑”：AbortController 用于立即断开在途模型请求，
 * pending 集合用于关机时等收尾写完再关库。它不解释业务状态，调用方仍通过
 * 自己的 repo 落库；这样报告批次和记忆归纳可以共用同一套启停语义。
 */
export class BatchRunner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();

  /** 启动并跟踪一个后台任务；调用方仍需自行处理返回 promise 的失败。 */
  run<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.set(id, controller);

    // 用 then 包一层：task 同步抛错也要变成受跟踪的 rejection，而不是绕过清理。
    const running = Promise.resolve()
      .then(() => task(controller.signal))
      .finally(() => {
        this.controllers.delete(id);
        this.pending.delete(running);
      });
    this.pending.add(running);
    // 调用方可能故意不 await（纯后台批次）；挂一个空 catch 只消除未处理拒绝，
    // 原 promise 仍把错误交给真正的订阅者。
    void running.catch(() => {});
    return running;
  }

  /** 后台启动；失败交给 onError 收尾，避免进程级未处理 rejection。 */
  spawn(
    id: string,
    task: (signal: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void,
  ): void {
    void this.run(id, task).catch(onError);
  }

  /** 只有当前进程真的持有该批次时才 abort；返回 false 让调用方走“孤儿批次”收尾。 */
  abort(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
