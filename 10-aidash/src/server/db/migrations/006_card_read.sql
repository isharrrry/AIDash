-- 006：卡片已读状态（信息流“未读红点”的服务端真相）。
--
-- 为什么单独建表，而不是给 card 加 read_at 列：
--   1. 已读是“人看到过这条信息”的事件，和卡片内容无关。独立表让读卡这个高频、
--      无审计价值的动作只写一行，不会更新 card 行、也不会触发卡片编辑相关逻辑。
--   2. 将来多用户时，主键自然扩成 (user_id, card_id)；card 表加列只能表达
--      “最后一个人什么时候读过”，无法区分谁读过，迁移时还得回填/拆表。
--
-- 为什么主键是 card_id：
--   当前是单令牌、单人使用的本机工具，一条卡只有一个“我读没读过”的状态。
--   多用户版本需要同时改认证模型，届时再升主键，不需要改这里的读写语义。
--
-- 为什么不回填历史已读：
--   历史上没有任何“读过”的事实。若迁移时把所有旧卡标成已读，红点一上线就是 0，
--   用户反而看不到真正没读过的信息。未读是一份诚实的事实，不是需要清洗的脏数据。
CREATE TABLE card_read (
  card_id TEXT PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL
);

-- 按时间清理/排查用；红点统计走 task_id 索引 + card_read 主键查找。
CREATE INDEX idx_card_read_read_at ON card_read(read_at);
