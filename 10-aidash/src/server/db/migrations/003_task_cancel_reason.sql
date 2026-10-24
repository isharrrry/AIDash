-- 003：取消原因。
--
-- 为什么现在才加：002 给任务补了“什么时候发生”，但没有给“为什么结束”。
-- 阻塞和失败早就有原因列，取消是唯一一个可以无理由消失的终态——
-- 看板上只剩一个“已取消”，用户无法判断是重复任务、判断错了，还是被误建。
-- 所以从这一版起，cancel 与 block/fail 一样强制要求 reason。

ALTER TABLE task ADD COLUMN cancel_reason TEXT;

-- 历史回填：升级前的取消没有强制记录原因。
-- 这里显式写“未记录”，而不是留空：留空看起来像页面没渲染，写明白才知道该去问谁。
UPDATE task
SET cancel_reason = '历史任务：取消时未强制记录原因（003 迁移回填）'
WHERE status = 'cancelled' AND cancel_reason IS NULL;
