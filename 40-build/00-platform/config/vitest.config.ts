import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 配置位于 40-build/00-platform/config/，向上两级回到 workspace 根 40-build/。
// 显式指定 root，避免 vitest 把配置目录当作 root 而找不到 tests 与 src。
// root 必须指向 40-build 而不是仓库根：vitest 的缓存默认写在 <root>/node_modules 下，
// 若指向仓库根就会在仓根生成 node_modules/，破坏“仓根只留说明性文件”的约定。
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
      // 四条阈值统一对齐团队规则（testing.md：覆盖率最低 80%）。
      // branches 原来写 70，比团队规则松一档：当时真实分支覆盖只有 73.97%，
      // 抬到 80 会直接把构建打红。现在实测 89.73%，具备收紧条件——
      // 阈值的作用是「防回退」，不是「记录当前成绩」，所以按规则值定，不按实测值定。
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
