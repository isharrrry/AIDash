/**
 * 令牌输入页：没有 token 时整个应用只渲染这一个表单。
 *
 * 先写入 localStorage 再调用受保护的 /digest 验证；验证失败立即清除，
 * 避免把错令牌留在浏览器里反复触发 401。令牌只进 Authorization 头，不拼 URL。
 */
import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { clearToken, describeError, setToken } from '../api/client';
import { getDigest } from '../api/endpoints';

export function TokenGate({
  onTokenSaved,
}: {
  onTokenSaved: (token: string) => void;
}): ReactElement {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      setError('请输入 AIDASH_TOKEN');
      return;
    }
    setBusy(true);
    setError(null);
    setToken(token);
    try {
      await getDigest();
      onTokenSaved(token);
    } catch (cause) {
      clearToken();
      const message = describeError(cause);
      setError(
        message.includes('UNAUTHORIZED') || message.includes('401')
          ? '令牌无效或已过期，请检查 AIDASH_TOKEN'
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="token-gate">
      <form className="token-card" onSubmit={(event) => void submit(event)}>
        <div className="brand-large">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          AIDash
        </div>
        <h1>连接你的决策面板</h1>
        <p className="muted">
          输入服务的访问令牌。令牌只保存在本机 <code>localStorage['aidash.token']</code>，
          请求时通过 <code>Authorization: Bearer</code> 头发送，不会出现在 URL 或日志里。
        </p>
        <label className="field">
          <span>访问令牌</span>
          <input
            type="password"
            value={value}
            autoComplete="off"
            autoFocus
            placeholder="AIDASH_TOKEN"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {error ? <div className="error-box" role="alert">{error}</div> : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '验证中…' : '验证并进入'}
        </button>
        <p className="muted small">
          令牌来自服务端环境变量 <code>AIDASH_TOKEN</code>。若尚未配置，请先在启动服务时设置。
        </p>
      </form>
    </div>
  );
}
