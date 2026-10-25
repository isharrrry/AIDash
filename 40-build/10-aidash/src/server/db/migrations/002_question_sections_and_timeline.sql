-- 002：决策卡四段背景、通道工作路径、任务状态时间线。
--
-- 为什么全部用可空列：旧库已有卡片/通道/任务，迁移不能要求历史数据补齐；
-- 新卡的四段必填规则放在 shared/schemas.ts 的提交校验里，旧卡按“未提供”降级展示。
-- 为什么任务时间落在 task 行而不是只查 task_event：任务树一次要渲染几十上百个节点，
-- 逐节点查事件会变成 N+1；这里用事件回填一次，之后由状态迁移同步维护。

ALTER TABLE card ADD COLUMN goal_md TEXT;
ALTER TABLE card ADD COLUMN research_md TEXT;
ALTER TABLE card ADD COLUMN decision_md TEXT;

ALTER TABLE channel ADD COLUMN workdir TEXT;

ALTER TABLE task ADD COLUMN claimed_at INTEGER;
ALTER TABLE task ADD COLUMN blocked_at INTEGER;
ALTER TABLE task ADD COLUMN completed_at INTEGER;
ALTER TABLE task ADD COLUMN failed_at INTEGER;
ALTER TABLE task ADD COLUMN cancelled_at INTEGER;

-- 历史回填：只补“从未有过值”的行，重复执行也不会覆盖运行期新写入的时间。
-- claimed 取最早一次，blocked/failed/cancelled 取最近一次；完成是终态，取最近一次。
UPDATE task
SET claimed_at = (
  SELECT MIN(e.created_at) FROM task_event e
  WHERE e.task_id = task.id AND e.event = 'claimed'
)
WHERE claimed_at IS NULL;

UPDATE task
SET blocked_at = (
  SELECT MAX(e.created_at) FROM task_event e
  WHERE e.task_id = task.id AND e.event = 'block'
)
WHERE blocked_at IS NULL;

UPDATE task
SET completed_at = (
  SELECT MAX(e.created_at) FROM task_event e
  WHERE e.task_id = task.id AND e.event = 'complete'
)
WHERE completed_at IS NULL;

UPDATE task
SET failed_at = (
  SELECT MAX(e.created_at) FROM task_event e
  WHERE e.task_id = task.id AND e.event = 'fail'
)
WHERE failed_at IS NULL;

UPDATE task
SET cancelled_at = (
  SELECT MAX(e.created_at) FROM task_event e
  WHERE e.task_id = task.id AND e.event = 'cancel'
)
WHERE cancelled_at IS NULL;
