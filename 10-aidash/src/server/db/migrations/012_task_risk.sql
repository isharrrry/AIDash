-- 012：任务“隐患”标记。
--
-- 要解决的问题：
--   为了保住交付节奏，很多任务会“带病完成”（没做全量回归、绕过某个边界、
--   先上再补）。这类完成如果和普通完成长得一样，复盘时根本找不到当时
--   冒过什么险，也就无法判断“这次冒险是对是错”。
--
-- 为什么不复用 defer：
--   defer 的语义是“现在不做、以后再看”，且只允许 draft/pending，认领会清空；
--   隐患的语义是“已经做了，但留下一个已知风险”，必须能挂在 done 上长期保留。
--   两者生命周期相反，混用会让任务树把“带隐患完成”显示成“已暂缓”。
--
-- 为什么解除后不删 note：
--   复盘要回答的是“当时留隐患的抉择对不对”，风险后来被修掉不代表当时的
--   判断不存在。risk_note / risk_flagged_at 永久保留，risk_resolved_at 只表示
--   “这个风险已经处理完”，列表仍可按“曾经带隐患”筛出历史记录。
ALTER TABLE task ADD COLUMN risk_note TEXT;
ALTER TABLE task ADD COLUMN risk_flagged_at INTEGER;
ALTER TABLE task ADD COLUMN risk_resolved_at INTEGER;

-- 看板/任务树主要关心“仍未解除的隐患”；部分索引只覆盖打开中的行，
-- 不给绝大多数没有隐患的任务增加写放大。
CREATE INDEX idx_task_risk_open
  ON task(risk_flagged_at)
  WHERE risk_note IS NOT NULL AND risk_resolved_at IS NULL;
