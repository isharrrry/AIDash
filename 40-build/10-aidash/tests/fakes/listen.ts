import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Fetch 规范禁止的端口（https://fetch.spec.whatwg.org/#bad-port）。
 *
 * 本机 Windows 的动态端口范围是 1024–15000，包含其中若干值（如 2049、6000、6697、
 * 10080）。测试里的回环服务用 `listen(0)` 随机取端口，一旦分到这些值，后续
 * `fetch` 会直接报 "bad port"，表现为与业务无关的偶发失败。分到坏端口时关闭重试。
 */
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export function isFetchBadPort(port: number): boolean {
  return FETCH_BAD_PORTS.has(port);
}

/** 在 127.0.0.1 的随机端口监听，避开 Fetch 规范禁止的端口。 */
export async function listenOnFetchSafePort(server: Server): Promise<AddressInfo> {
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    if (!isFetchBadPort(address.port)) return address;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
