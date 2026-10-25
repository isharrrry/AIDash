-- 016：AIDash 自己的记忆。
--
-- 为什么不复用 project_memory：
-- 1. 归属不同：project_memory 的键是 channel_key 的 project 段，属于“某个主对话”；
--    AIDash 的记忆属于“AIDash 这个工具自己”，没有 project 维度。
-- 2. 读写者不同：主对话记忆由外部 agent 通过 MCP 读写；AIDash 记忆只由 AIDash 的
--    AI 能力在内部读取、由汇报学习器自动更新，不通过 MCP 暴露，避免外部 agent 把
--    自己的项目约束写进“工具经验”里。
-- 3. 生命周期不同：项目记忆跟着项目走，AIDash 记忆跟着工具版本走，需要独立备份/清空。
--
-- 单行表（id 固定为 1）：这份记忆就是一篇 Markdown，不需要按 key 分片。
-- 用 CHECK 约束把“只许一行”写进数据库，而不是只靠应用层约定。
CREATE TABLE IF NOT EXISTS assistant_memory (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content_md TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
