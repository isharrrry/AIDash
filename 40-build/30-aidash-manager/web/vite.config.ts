import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 产物固定输出到 30-aidash-manager/web-dist（本目录上一级），
 * 管理台服务端按这个目录托管静态资源，npm pack 时一并带走。
 * 开发期把 /api 代理到默认管理台端口，前端代码不需要区分环境。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
  },
  server: {
    port: 4281,
    proxy: {
      '/api': 'http://127.0.0.1:4280',
    },
  },
});
