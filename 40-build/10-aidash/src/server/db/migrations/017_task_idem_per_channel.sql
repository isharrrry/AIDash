-- D-1：任务幂等键改为「按通道隔离」。
--
-- 原 uq_task_idem 是全局唯一索引：同一个 idempotency_key 在另一个通道再建任务时，
-- 服务层会命中别的通道的旧任务并返回它，还会把请求里的新通道建成空记录。
-- 幂等键的语义是「同一集合内重试不重复建」，任务集合天然按通道划分，
-- 因此索引键改为 (channel_id, idempotency_key)，与 card 表的做法保持一致。
--
-- 现有数据不会冲突：旧索引已保证全局唯一，放宽到通道内唯一必然成立。
DROP INDEX IF EXISTS uq_task_idem;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_channel_idem
  ON task(channel_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
