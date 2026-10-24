import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { describeError } from '../api/client';
import {
  cancelReportRun,
  deleteReport,
  getReportStatus,
  listReports,
  startReportUpdate,
  startTopicReport,
} from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { usePolling } from '../hooks/usePolling';
import { downloadMarkdown } from '../lib/download';
import { formatRelative, formatStamp, truncate } from '../lib/format';
import type {
  ReportPeriod,
  ReportRunView,
  ReportStatus,
  ReportStatusView,
  ReportView,
} from '../types';
import { EmptyState, ErrorBox, Loading } from '../components/Feedback';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';

const PERIOD_ORDER: ReportPeriod[] = [
  'topic',
  'day',
  'week',
  'month',
  'quarter',
  'half',
  'year',
];

const PERIOD_LABELS: Record<ReportPeriod, string> = {
  day: '日报',
  week: '周报',
  month: '月报',
  quarter: '季度报',
  half: '半年报',
  year: '年报',
  topic: '专题报',
};

const STATUS_LABELS: Record<ReportStatus, string> = {
  generating: '生成中',
  ready: '已就绪',
  failed: '失败',
  cancelled: '已取消',
};

const RUN_STATUS_LABELS: Record<ReportRunView['status'], string> = {
  running: '进行中',
  done: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

const PAGE_SIZE = 20;
/** 生成要调六次模型，4 秒轮询足够让进度条“动起来”，又不会把日志刷满。 */
const POLL_MS = 4_000;

/**
 * 汇报 Tab。
 *
 * 页面只做三件事：看历次汇报、点“更新汇报”触发六种周期依次生成、写一段要求生成/更新专题。
 * 生成过程本身在服务端后台跑，页面只轮询 /status；因此刷新页面不会打断生成，
 * 多个浏览器窗口看到的进度也一致（进度存在 report_run 表，不在浏览器内存里）。
 */
export function ReportsPage(): ReactElement {
  const { refreshNonce } = useApp();
  const notify = useToast().notify;

  const [filter, setFilter] = useState<ReportPeriod | 'all'>('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const status = useAsync<ReportStatusView>(() => getReportStatus(), []);
  const reports = useAsync(
    () =>
      listReports({
        period: filter === 'all' ? undefined : filter,
        page,
        page_size: PAGE_SIZE,
      }),
    [filter, page, refreshNonce],
  );

  const running = status.data?.running ?? null;
  const previousRunId = useRef<string | null>(null);

  // 批次从“有”变成“没有”时补拉一次列表：最后一次轮询可能发生在最后一期写入之前，
  // 不补拉的话，进度显示完成但右侧内容还是上一版。
  useEffect(() => {
    const id = running?.id ?? null;
    if (previousRunId.current && !id) reports.reload();
    previousRunId.current = id;
    // reports.reload 是稳定回调；只在批次变化时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id]);

  usePolling(() => status.reload(), POLL_MS, true);
  // 批次进行中时列表里的状态徽标也要跟着变（生成中 → 已就绪）。
  usePolling(() => reports.reload(), POLL_MS, Boolean(running));

  const items = reports.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  const startPeriod = async (): Promise<void> => {
    setStarting(true);
    try {
      const run = await startReportUpdate();
      notify('success', `已开始更新六种周期汇报（批次 ${run.id.slice(0, 10)}…）`);
      status.reload();
    } catch (cause) {
      notify('error', `发起更新失败：${describeError(cause)}`);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!running) return;
    setCancelling(true);
    try {
      await cancelReportRun(running.id);
      notify('success', '已请求取消，当前模型调用结束后停止。');
      status.reload();
    } catch (cause) {
      notify('error', `取消失败：${describeError(cause)}`);
    } finally {
      setCancelling(false);
    }
  };

  /**
   * 下载当前汇报的 Markdown 原文。
   *
   * 列表接口已经带回 content_md，不需要再请求详情；文件名带周期键，
   * 同一个浏览器下载多条时自然按周期排序，不靠标题猜。
   */
  const download = (item: ReportView): void => {
    if (!item.content_md?.trim()) {
      notify('error', '这条汇报还没有正文，暂时不能下载。');
      return;
    }
    downloadMarkdown(`${item.period_key}-${item.title}`, item.content_md);
    notify('success', '已开始下载 Markdown');
  };

  /** 删除不可恢复，必须二次确认；生成中的汇报由服务端 409 兜底。 */
  const remove = async (item: ReportView): Promise<void> => {
    if (!window.confirm(`删除汇报「${item.title}」？删除后不可恢复。`)) return;
    try {
      await deleteReport(item.id);
      notify('success', '汇报已删除');
      // 删的是当前正在看的条目时清空选中，让列表回退到新的第一条。
      if (selected?.id === item.id) setSelectedId(null);
      reports.reload();
      status.reload();
    } catch (cause) {
      notify('error', `删除失败：${describeError(cause)}`);
    }
  };

  const chooseFilter = (next: ReportPeriod | 'all'): void => {
    setFilter(next);
    setPage(1);
    setSelectedId(null);
  };

  return (
    <div className="page reports-page">
      <header className="page-header">
        <div>
          <h1>汇报</h1>
          <p className="muted">
            AIDash 以“管多个 harness 任务的经理”视角，用系统内的任务、卡片与状态记录向老板汇报。
            日报→周报→月报→季度报→半年报→年报会依次生成或覆盖；专题报按你写的要求新建或更新。
          </p>
        </div>
        <div className="inline">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              status.reload();
              reports.reload();
            }}
          >
            刷新
          </button>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={Boolean(running) || starting}
            title={running ? '当前已有批次在跑，结束或取消后才能再次发起' : undefined}
            onClick={() => void startPeriod()}
          >
            {starting ? '发起中…' : '更新汇报'}
          </button>
          {running ? (
            <button
              type="button"
              className="btn btn-danger btn-small"
              disabled={cancelling || running.cancel_requested}
              onClick={() => void cancel()}
            >
              {running.cancel_requested ? '取消中…' : cancelling ? '提交中…' : '取消更新'}
            </button>
          ) : null}
        </div>
      </header>

      {status.error ? (
        <ErrorBox message={`批次状态加载失败：${status.error}`} onRetry={status.reload} />
      ) : null}
      {status.data ? <RunProgress running={running} runs={status.data.runs} /> : null}

      <div className="reports-layout">
        <section className="panel reports-sidebar" aria-label="汇报列表">
          <div className="chip-group" role="group" aria-label="按周期筛选">
            <button
              type="button"
              className={filter === 'all' ? 'chip active' : 'chip'}
              onClick={() => chooseFilter('all')}
            >
              全部
            </button>
            {PERIOD_ORDER.map((period) => (
              <button
                key={period}
                type="button"
                className={filter === period ? 'chip active' : 'chip'}
                onClick={() => chooseFilter(period)}
              >
                {PERIOD_LABELS[period]}
              </button>
            ))}
          </div>

          {reports.loading && !reports.data ? <Loading label="加载汇报…" /> : null}
          {reports.error ? (
            <ErrorBox message={`汇报列表加载失败：${reports.error}`} onRetry={reports.reload} />
          ) : null}

          {reports.data && items.length === 0 ? (
            <EmptyState
              title="还没有汇报"
              hint="点右上角“更新汇报”生成六种周期汇报；或在下方写一段要求新建专题。"
            />
          ) : null}

          {items.length > 0 ? (
            <ul className="report-list">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={selected?.id === item.id ? 'report-item active' : 'report-item'}
                >
                  <button
                    type="button"
                    className="report-item-main"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="report-item-title">{item.title}</span>
                    <span className="inline wrap">
                      <span className={`badge report-status-${item.status}`}>
                        {STATUS_LABELS[item.status]}
                      </span>
                      {/* 显示绝对修改时间；相对时间放 title，悬停即可知道“多久前”。 */}
                      <span className="muted small" title={`${formatRelative(item.updated_at)}更新`}>
                        修改于 {formatStamp(item.updated_at)}
                      </span>
                    </span>
                    <span className="muted small report-item-excerpt">
                      {truncate(item.content_md, 90) || '（暂无内容）'}
                    </span>
                  </button>
                  <div className="report-item-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={!item.content_md?.trim()}
                      title={
                        item.content_md?.trim()
                          ? '下载这条汇报的 Markdown 原文'
                          : '这条汇报还没有正文'
                      }
                      onClick={() => download(item)}
                    >
                      下载 md
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      disabled={item.status === 'generating'}
                      title={
                        item.status === 'generating'
                          ? '生成中不能删除，先取消或等批次结束'
                          : '删除后不可恢复'
                      }
                      onClick={() => void remove(item)}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {reports.data && reports.data.total > PAGE_SIZE ? (
            <div className="pagination">
              <button
                type="button"
                className="btn btn-small"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </button>
              <span className="muted small">
                第 {reports.data.page} / {Math.max(1, Math.ceil(reports.data.total / PAGE_SIZE))} 页
              </span>
              <button
                type="button"
                className="btn btn-small"
                disabled={!reports.data.has_more}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}
        </section>

        <section className="reports-main">
          <ReportDetail report={selected} />
          <TopicPanel
            reports={items}
            disabled={Boolean(running) || reports.loading}
            onStarted={() => {
              status.reload();
              reports.reload();
            }}
          />
        </section>
      </div>
    </div>
  );
}

/** 当前批次进度 + 最近批次历史。没有批次时只显示最近历史，避免面板无意义地占位。 */
function RunProgress({
  running,
  runs,
}: {
  running: ReportRunView | null;
  runs: ReportRunView[];
}): ReactElement | null {
  if (!running && runs.length === 0) return null;
  const percent =
    running && running.total > 0
      ? Math.min(100, Math.round((running.completed / running.total) * 100))
      : 0;

  return (
    <section className="panel report-run-panel" aria-label="汇报批次">
      {running ? (
        <>
          <div className="inline wrap">
            <strong>{running.kind === 'period' ? '周期汇报更新中' : '专题汇报生成中'}</strong>
            <span className="muted small">
              已完成 {running.completed}/{running.total}
              {running.current_period
                ? ` · 当前：${PERIOD_LABELS[running.current_period]}`
                : ''}
            </span>
            {running.cancel_requested ? (
              <span className="badge report-status-cancelled">取消已请求</span>
            ) : null}
          </div>
          <div
            className="report-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="report-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted small">
            开始于 {formatStamp(running.started_at)}；刷新页面不会中断，进度存在服务端。
          </p>
        </>
      ) : null}

      {runs.length > 0 ? (
        <ul className="report-run-list">
          {runs.slice(0, 5).map((run) => (
            <li key={run.id} className="inline wrap">
              <span className={`badge report-status-${run.status}`}>
                {RUN_STATUS_LABELS[run.status]}
              </span>
              <span className="muted small">
                {run.kind === 'period' ? '周期' : '专题'} · {run.completed}/{run.total} ·{' '}
                {formatStamp(run.started_at)}
              </span>
              {run.error_message ? (
                <span className="muted small warn-text">原因：{run.error_message}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ReportDetail({ report }: { report: ReportView | null }): ReactElement {
  if (!report) {
    return (
      <section className="panel reports-detail">
        <EmptyState title="选择一条汇报" hint="左侧列表里点一条，正文会显示在这里。" />
      </section>
    );
  }

  return (
    <section className="panel reports-detail" aria-label={report.title}>
      <header className="panel-header">
        <div>
          <h2>{report.title}</h2>
          <p className="muted small">
            {PERIOD_LABELS[report.period]} · {report.period_key} ·{' '}
            {report.generated_at
              ? `生成于 ${formatStamp(report.generated_at)}`
              : `更新于 ${formatStamp(report.updated_at)}`}
          </p>
        </div>
        <span className={`badge report-status-${report.status}`}>
          {STATUS_LABELS[report.status]}
        </span>
      </header>

      <p className="muted small">
        素材 {report.source_count} 条
        {report.model ? ` · 模型 ${report.model}` : ''}
        {report.mode ? ` · 档位 ${report.mode}` : ''}
      </p>

      {report.instruction_md ? (
        <div className="report-instruction">
          <span className="muted small">本次要求</span>
          <p className="small">{report.instruction_md}</p>
        </div>
      ) : null}

      {report.error_message ? (
        <div className="reason-box reason-box-danger">
          生成失败：{report.error_message}。修复后重新发起即可覆盖这一条。
        </div>
      ) : null}

      {/* 取消只中止这一次生成，旧内容不会被清掉；不说明的话，“已取消”会被误读成内容作废。 */}
      {report.status === 'cancelled' && report.content_md ? (
        <div className="reason-box">
          本次更新已取消；下面仍是上一次成功生成的内容
          {report.generated_at ? `（生成于 ${formatStamp(report.generated_at)}）` : ''}。
        </div>
      ) : null}

      {report.content_md ? (
        <div className="markdown reports-content">
          <Markdown source={report.content_md} />
        </div>
      ) : (
        <p className="muted small">
          {report.status === 'generating' ? '正在生成，稍候自动刷新…' : '这条汇报还没有内容。'}
        </p>
      )}
    </section>
  );
}

/**
 * 专题表单。
 *
 * 两个动作用同一段话：
 * - 不勾选目标：新建一条专题汇报；
 * - 勾选若干目标：按这段话更新那些已有汇报（一次批次逐条生成）。
 * 按钮在有批次进行中时禁用，真正并发闸门在服务端（409 REPORT_RUNNING）。
 */
function TopicPanel({
  reports,
  disabled,
  onStarted,
}: {
  reports: ReportView[];
  disabled: boolean;
  onStarted: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const [topic, setTopic] = useState('');
  const [instruction, setInstruction] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const toggleTarget = (id: string): void => {
    setTargets((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const submit = async (): Promise<void> => {
    if (!instruction.trim()) return;
    setSubmitting(true);
    try {
      const run = await startTopicReport({
        topic: topic.trim() || null,
        instruction: instruction.trim(),
        target_report_ids: targets,
      });
      notify(
        'success',
        targets.length > 0
          ? `已开始按你的要求更新 ${targets.length} 条汇报`
          : `已开始生成专题汇报（批次 ${run.id.slice(0, 10)}…）`,
      );
      setInstruction('');
      setTopic('');
      setTargets([]);
      onStarted();
    } catch (cause) {
      notify('error', `发起专题失败：${describeError(cause)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel report-topic" aria-label="专题汇报">
      <header className="panel-header">
        <div>
          <h2>专题汇报</h2>
          <p className="muted small">
            写一段要求；不勾选下面的汇报就是新建专题，勾选则按这段要求重写所选条目（标题保持不变）。
            主题只用于新建时的标题。
          </p>
        </div>
      </header>

      <label className="field">
        <span>主题（可留空）</span>
        <input
          type="text"
          value={topic}
          maxLength={200}
          placeholder="例如：本季度线上故障复盘"
          onChange={(event) => setTopic(event.target.value)}
        />
      </label>

      <label className="field">
        <span>要求（必填）</span>
        <textarea
          rows={4}
          value={instruction}
          maxLength={4_000}
          placeholder="例如：按故障影响、根因、修复动作、后续预防四部分重写，突出还没有闭环的风险。"
          onChange={(event) => setInstruction(event.target.value)}
        />
        <span className="muted small">{instruction.length} / 4000</span>
      </label>

      {reports.length > 0 ? (
        <div className="field">
          <span>要更新的已有汇报（不勾选 = 新建专题）</span>
          <div className="report-target-list">
            {reports.map((report) => (
              <label key={report.id} className="inline-check small">
                <input
                  type="checkbox"
                  checked={targets.includes(report.id)}
                  onChange={() => toggleTarget(report.id)}
                />
                <span>{report.title}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="inline">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={disabled || submitting || !instruction.trim()}
          onClick={() => void submit()}
        >
          {submitting
            ? '发起中…'
            : targets.length > 0
              ? `按此要求更新 ${targets.length} 条`
              : '生成专题汇报'}
        </button>
        {disabled ? (
          <span className="muted small">当前有批次在跑，结束或取消后才能发起。</span>
        ) : null}
      </div>
    </section>
  );
}
