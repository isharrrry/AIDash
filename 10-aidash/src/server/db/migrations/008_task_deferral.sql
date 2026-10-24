-- 008：任务暂缓/排期标记。
--
-- 要解决的问题：
--   pending 任务既不能 block（状态机只允许 in_progress → blocked），也不该被
--   当成“正在执行”。上一轮会话留下的活就卡在这里：状态是待认领，用户看不出
--   “是没人接，还是 agent 明确决定先不做”。
--
-- 为什么不新增 deferred 状态：
--   task 表 CHECK 规定 blocked 必须带 claim_token，claim_token 又活不过会话；
--   把 pending 改成 blocked 会同时违背“状态必须能自洽”和“待认领 ≠ 有人接了但停”。
--   重建 task 表去放宽 CHECK 会牵动外键与索引，风险远大于收益。
--
-- 为什么用三列而不是复用 due_at：
--   due_at 是“承诺的截止时间”，defer 是“明确决定现在不做、什么时候再看”。
--   两者可以同时存在（例如“暂缓到下周，但月底前必须交”），混用会丢失语义。
ALTER TABLE task ADD COLUMN defer_reason TEXT;
ALTER TABLE task ADD COLUMN deferred_at INTEGER;
ALTER TABLE task ADD COLUMN deferred_until INTEGER;

-- 任务树/看板会按“是否暂缓”做展示与筛选；只索引非空值，避免给绝大多数普通任务加负担。
CREATE INDEX idx_task_defer_reason ON task(defer_reason) WHERE defer_reason IS NOT NULL;
