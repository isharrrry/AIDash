import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { describeError } from '../api/client';
import { listMemoryDigestRuns, runMemoryDigest } from '../api/endpoints';
import { formatAbsolute, formatRelative } from '../lib/format';
import type { MemoryDigestRunView } from '../types';
import { ErrorBox, Loading } from './Feedback';
import { MarkdownInline } from './Markdown';
import { useToast } from './Toast';

const RESULT_LABEL: Record<MemoryDigestRunView['result'], string> = {
  ok: '已新增',
  empty: '无新增',
  unavailable: '模型未配置',
  failed: '失败',
};

/**
 * 单个项目的记忆归纳面板。
 *
 * 历史记录连失败/空结果一起展示：用户最常问的是“为什么这次没新增”，
 * 只显示成功记录会让失败看起来像“根本没跑”。归纳完成后通知父级刷新记忆正文，
 * 否则用户会看到“新增 2 行”但正文没变，以为没生效。
 */
export function MemoryDigestPanel({
  project,
  onChanged,
}: {
  project: string;
  onChanged: () => void;
}): ReactElement {
  const notify = useToast().notify;
  const [runs, setRuns] = useState<MemoryDigestRunView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await listMemoryDigestRuns(project, 10));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setRuns(null);
    void load();
    // project 变了就重新拉；load 内部只依赖 project，不需要额外依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const run = async (): Promise<void> => {
    setRunning(true);
    try {
      const result = await runMemoryDigest(project);
      notify(
        result.result === 'failed' || result.result === 'unavailable' ? 'error' : 'success',
        result.result === 'ok'
          ? `归纳完成：新增 ${result.appended} 行，跳过重复 ${result.skipped_duplicates} 行`
          : `归纳完成：${RESULT_LABEL[result.result]}`,
      );
      await load();
      onChanged();
    } catch (cause) {
      notify('error', `归纳失败：${describeError(cause)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="panel" aria-label={`记忆归纳 ${project}`}>
      <header className="panel-header">
        <div>
          <h2>自动归纳</h2>
          <p className="muted small">
            从最近的卡片/任务里提炼长期约束，写回上方记忆；重复内容会被自动跳过。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-small"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? '归纳中…' : '立即归纳'}
        </button>
      </header>

      {loading && !runs ? <Loading label="加载归纳历史…" /> : null}
      {error ? (
        <ErrorBox message={`归纳历史加载失败：${error}`} onRetry={() => void load()} />
      ) : null}

      {runs && runs.length === 0 ? (
        <p className="muted small">
          还没有归纳记录。点“立即归纳”试一次；素材少于 3 条时不会调用模型。
        </p>
      ) : null}

      {runs && runs.length > 0 ? (
        <ul className="digest-run-list">
          {runs.map((item) => (
            <li key={item.id} className="digest-run">
              <div className="inline wrap">
                <span className={`badge digest-${item.result}`}>{RESULT_LABEL[item.result]}</span>
                <span className="muted small">
                  {item.trigger === 'manual' ? '手动' : '定时'} · 来源 {item.source_count} 条 ·
                  新增 {item.appended} · 跳过 {item.skipped_duplicates}
                </span>
                <span className="muted small" title={formatAbsolute(item.created_at)}>
                  {formatRelative(item.created_at)}
                </span>
              </div>
              <p className="muted small">
                窗口：{formatAbsolute(item.window_start)} ~ {formatAbsolute(item.window_end)}
              </p>
              {item.error_message ? (
                <p className="muted small warn-text">原因：{item.error_message}</p>
              ) : null}
              {item.lines.length > 0 ? (
                <ul className="digest-lines">
                  {item.lines.map((line) => (
                    <li key={line}>
                      {/* 归纳结果也是长期约束，按行内 Markdown 渲染：
                          加粗/高亮与记忆正文保持一致，不再显示成一整段等宽代码。 */}
                      <MarkdownInline source={line} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
