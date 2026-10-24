import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 配置位于 00-platform/config/，向上两级回到 workspace 根（即本仓库根）。
// 显式指定 root，避免 vitest 把配置目录当作 root 而找不到 tests 与 src。
// root 固定为 workspace 根：vitest 的缓存默认写在 <root>/node_modules 下，
// 与 pnpm 的依赖目录同处一处，不会散落到其他层级。
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: workspaceRoot,
  test: {
    include: ['10-aidash/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: '10-aidash/coverage',
      include: [
        '10-aidash/src/server/**/*.ts',
        '10-aidash/src/shared/**/*.ts',
        '10-aidash/src/cli/**/*.ts',
      ],
      exclude: [
        '10-aidash/src/server/main.ts',
        '10-aidash/src/server/db/migrations/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
