import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 统一的假 LLM 网关。
 *
 * 为什么需要一个「能主动造错」的桩：
 * MOD-005 增强服务的价值不在顺利路径，而在失败路径——模型 429、网关返回一坨
 * HTML、连接被重置、请求挂死。这些分支以前只能靠真实网络偶发触发，或者干脆不测。
 * 指南 5A 的硬要求是「每个桩都要能主动造错」，否则「桩上通过」就等于没测。
 *
 * 为什么不用 mock fetch：
 * 这里要验证的是真实 HTTP 形状——路径补全、Bearer 头、messages 与 max_tokens
 * 是否按档位发出、超时是否真的中断了连接。mock 掉 fetch 会把这些细节一起 mock 掉，
 * 测试就只剩「函数被调用过」。
 *
 * 铁律：本桩只替代**外部系统**（LLM 网关）。任何被测代码的调用方式都不为它改动。
 */

export interface FakeLlmRequest {
  url: string;
  auth: string | undefined;
  body: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    messages?: Array<{ role: string; content: string }>;
  };
}

/**
 * 故障形状。
 *
 * `hang` 与 `reset` 的区别是刻意的：
 * - `hang` 让请求永远不返回，用来验证**客户端超时**是否真的生效；
 * - `reset` 直接掐断连接，用来验证「网络层炸了」被收敛成可读的错误码。
 * 两者在 fetch 层都会变成异常，但映射到的业务码不同，混在一起就测不出区别。
 */
export type FakeLlmFault =
  /** 返回指定状态码（429 限流 / 500 上游炸）。 */
  | { kind: 'status'; status: number; body?: string }
  /** 状态码 200，但响应体不是合法 JSON。 */
  | { kind: 'invalid-json' }
  /** 状态码 200，JSON 合法但 choices 为空。 */
  | { kind: 'empty' }
  /** 收下请求后永不响应，直到客户端超时。 */
  | { kind: 'hang' }
  /** 收下请求后直接掐断 TCP。 */
  | { kind: 'reset' };

export interface FakeLlm {
  /** 填进 settings.llm_endpoint 的地址，形如 http://127.0.0.1:PORT/v1。 */
  base: string;
  /** 收到的全部请求，按到达顺序。 */
  requests: FakeLlmRequest[];
  /** 正常回答时 choices[0].message.content 的内容。 */
  setContent: (content: string) => void;
  /** 设置常驻状态码故障（等价于 setFault({kind:'status'})）。 */
  setStatus: (status: number, body?: string) => void;
  /** 设置常驻故障；传 null 恢复正常。 */
  setFault: (fault: FakeLlmFault | null) => void;
  /** 只让下一次请求失败，之后自动恢复——用来模拟偶发 429 与重试。 */
  failNext: (fault: FakeLlmFault) => void;
  close: () => Promise<void>;
}

/** 429 时默认回一段带密钥回显的响应体，专门用来证明我们没把它存进卡片。 */
const LEAKY_BODY = JSON.stringify({
  error: 'rate limited',
  echo: 'authorization: Bearer sk-leak-canary',
});

export async function startFakeLlm(content = '{"lines":[]}'): Promise<FakeLlm> {
  let reply = content;
  let fault: FakeLlmFault | null = null;
  let nextFault: FakeLlmFault | null = null;
  const requests: FakeLlmRequest[] = [];
  /** 挂死不回的响应，close() 时必须显式销毁，否则 close 会一直等着。 */
  const hanging = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: FakeLlmRequest['body'] = {};
      try {
        body = raw ? (JSON.parse(raw) as FakeLlmRequest['body']) : {};
      } catch {
        // 请求体不是 JSON 本身就是要观察的现象，不能让它变成测试进程里的未捕获异常。
      }
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, body });

      // failNext 优先，且只消费一次；常驻故障在恢复前一直生效。
      const active = nextFault ?? fault;
      nextFault = null;

      if (!active) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
        return;
      }

      switch (active.kind) {
        case 'status':
          res.writeHead(active.status, { 'content-type': 'application/json' });
          res.end(active.body ?? LEAKY_BODY);
          return;
        case 'invalid-json':
          // 故意不是 JSON：模拟网关挂了返回错误页的情况。
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('<html>502 Bad Gateway</html>');
          return;
        case 'empty':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [] }));
          return;
        case 'hang':
          // 不回也不结束，把连接挂在这里等客户端自己超时。
          hanging.add(res);
          res.on('close', () => hanging.delete(res));
          return;
        case 'reset':
          req.socket.destroy();
          return;
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    setContent: (value) => {
      reply = value;
    },
    setStatus: (status, body) => {
      fault = { kind: 'status', status, ...(body === undefined ? {} : { body }) };
    },
    setFault: (value) => {
      fault = value;
    },
    failNext: (value) => {
      nextFault = value;
    },
    close: async () => {
      for (const res of hanging) res.destroy();
      hanging.clear();
      // 成功请求留下的 keep-alive 空闲连接也要清掉，否则 close 会一直等它们超时。
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
