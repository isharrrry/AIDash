import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { searchKb } from '../api/endpoints';
import type { KbSearchResult } from '../types';
import { useAsync } from '../hooks/useAsync';
import { ErrorBox, Loading } from './Feedback';
import { Highlight } from './Highlight';

const EMPTY_RESULT: KbSearchResult = { items: [], total: 0 };

/**
 * 卡片详情里的知识库检索（SCR-02 R3）。
 * 显式提交而不是边输入边搜：KB 的 FTS 查询成本高，且用户通常只查一两次。
 */
export function KbMiniSearch({
  onOpenDoc,
}: {
  onOpenDoc: (path: string) => void;
}): ReactElement {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const result = useAsync(
    () => (query ? searchKb({ q: query, top_k: 5 }) : Promise.resolve(EMPTY_RESULT)),
    [query],
  );

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next = input.trim();
    if (!next) return;
    setQuery(next);
  };

  return (
    <div className="kb-mini">
      <form className="inline" onSubmit={submit}>
        <input
          type="search"
          value={input}
          placeholder="在知识库中查依据…"
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit" className="btn btn-small" disabled={!input.trim()}>
          查询
        </button>
      </form>

      {result.loading ? <Loading label="检索知识库…" /> : null}
      {result.error ? <ErrorBox message={result.error} onRetry={result.reload} /> : null}
      {result.data?.kbStatus && result.data.kbStatus !== 'ok' ? (
        <p className="warn-text">知识库状态：{result.data.kbStatus}</p>
      ) : null}

      {result.data && query ? (
        result.data.items.length === 0 ? (
          <p className="muted small">没有匹配的文章。知识库不可用不影响回答卡片。</p>
        ) : (
          <ul className="kb-mini-results">
            {result.data.items.map((hit) => (
              <li key={hit.path}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpenDoc(hit.path)}
                >
                  {hit.title || hit.path}
                </button>
                <p className="muted small">{hit.path}</p>
                {hit.snippet ? (
                  <p className="kb-snippet">
                    <Highlight text={hit.snippet} />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
