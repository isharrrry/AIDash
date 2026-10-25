import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  DEFAULT_API_TIMEOUT_MS,
  apiRequest,
} from '../src/web/src/api/client.js';

/**
 * Web 请求超时的单元测试。
 *
 * Web 侧没有 DOM 测试环境；这里只 mock 全局 fetch，验证超时与用户取消
 * 在 apiRequest 这一层的语义，不启动浏览器、不访问真实服务。
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
}

describe('apiRequest 超时', () => {
  it('默认超时为 20 秒，超时映射成可重试的 TIMEOUT', async () => {
    // Arrange
    expect(DEFAULT_API_TIMEOUT_MS).toBe(20_000);
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    // Act
    let error: unknown;
    try {
      await apiRequest('/slow', { timeoutMs: 20 });
    } catch (cause) {
      error = cause;
    }

    // Assert
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('TIMEOUT');
    expect(apiError.retryable).toBe(true);
    expect(apiError.status).toBe(0);
    expect(apiError.message).toContain('请求超时');
  });

  it('用户取消保留 AbortError，不会被误报成超时或网络错误', async () => {
    // Arrange
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    // Act
    const request = apiRequest('/slow', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    let error: unknown;
    try {
      await request;
    } catch (cause) {
      error = cause;
    }

    // Assert
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('普通网络异常仍映射为 NETWORK_ERROR，而不是一律算超时', async () => {
    // Arrange
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    // Act
    let error: unknown;
    try {
      await apiRequest('/offline', { timeoutMs: 1000 });
    } catch (cause) {
      error = cause;
    }

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
  });

  it('成功响应后清理计时器，避免一个请求留下一个空转的超时定时器', async () => {
    // Arrange
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { value: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    // Act
    const result = await apiRequest<{ value: number }>('/ok', { timeoutMs: 1000 });

    // Assert
    expect(result.value).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
