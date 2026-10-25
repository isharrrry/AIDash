/**
 * MCP 工具注册入口。
 *
 * 为什么只保留 re-export：HTTP 路由只依赖 `registerTools` 这个符号；
 * 领域拆分放到 `./tools/` 后，入口签名与注册顺序保持不变，调用方无需感知文件结构。
 */
export { registerTools } from './tools/register.js';
