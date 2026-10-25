-- 007：通道最后 MCP 活动时间。
--
-- 为什么需要这一列：
--   旧版通道树用 open_task_count > 0 推导“进行中”，只要还有 pending/blocked
--   任务就永远转圈。任务没做完不等于 agent 还连着——两者必须分开表达。
--   这个列由 MCP tools/call 入口统一刷新：任何一次带 channel_key/task_id/card_id
--   的调用都算“这条通道刚被 agent 碰过”，读操作也算。
--
-- 为什么不复用 updated_at：
--   updated_at 被发卡/建任务/用户改字段等所有写操作刷新，REST 也会写；
--   用它判断“agent 在线”会把用户的网页操作误算成 agent 活动。
--   单独一列只由 MCP 入口写，语义单一，阈值判定才可信。
--
-- 为什么允许为空：
--   迁移前的历史通道没有任何 MCP 活动事实。若回填成 now，所有旧通道会先显示
--   在线三分钟，反而制造假信号。空值 = 从未观测到活动，页面显示“无活动记录”。
ALTER TABLE channel ADD COLUMN last_mcp_at INTEGER;

-- 列表按 last_mcp_at 判定在线时会做范围比较；通道数量不大，但索引成本极低。
CREATE INDEX idx_channel_last_mcp_at ON channel(last_mcp_at);
