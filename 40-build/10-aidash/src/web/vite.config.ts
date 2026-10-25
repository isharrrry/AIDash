import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 构建产物固定输出到 40-build/10-aidash/dist/web（从本目录上两级），服务端按 staticDir 托管。
 * 开发期把 /api 代理到 127.0.0.1:8787，浏览器只认同源相对路径，
 * 生产与开发的前端代码因此完全一致（不需要注入不同的 baseURL）。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
