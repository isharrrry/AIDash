import type { ReactElement } from 'react';
import { getKbDoc } from '../api/endpoints';
import { useApp } from '../AppContext';
import { useAsync } from '../hooks/useAsync';
import { Loading, ErrorBox } from './Feedback';
import { Markdown } from './Markdown';

/** 抽屉与知识库页共用的文章预览；正文来自只读 KB 接口。 */
export function KbDocPreview({
  path,
  onClose,
}: {
  path: string;
  onClose?: () => void;
}): ReactElement {
  const { refreshNonce } = useApp();
  const doc = useAsync(() => getKbDoc(path), [path, refreshNonce]);

  return (
    <section className="panel kb-doc-preview">
      <header className="panel-header">
        <div>
          <h3>{doc.data?.title || path}</h3>
          <p className="muted small">
            {path}
            {doc.data?.type ? ` · ${doc.data.type}` : ''}
          </p>
        </div>
        {onClose ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
            关闭预览
          </button>
        ) : null}
      </header>

      {doc.loading ? <Loading label="读取知识库文章…" /> : null}
      {doc.error ? <ErrorBox message={doc.error} onRetry={doc.reload} /> : null}
      {doc.data ? (
        <>
          {doc.data.tags.length > 0 ? (
            <div className="tag-list">
              {doc.data.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <Markdown source={doc.data.body} />
        </>
      ) : null}
    </section>
  );
}
