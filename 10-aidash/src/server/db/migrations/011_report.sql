-- 汇报（report）与更新批次（report_run）。
--
-- 为什么拆两张表：
--   1. 一次“更新汇报”会依次生成 6 个自然周期（日/周/月/季/半年/年），
--      用户需要看到整体进度、取消状态与失败原因；这些是“批次”的属性，
--      不能塞进任何一条汇报里。
--   2. 专题汇报是单条、非周期性的；它同样走批次，才能和周期更新共用
--      “同一时间只允许一个生成任务”的并发闸门。
--
-- 为什么周期汇报用唯一索引：
--   同一天重复点“更新汇报”应当覆盖当天的日报，而不是堆出几十条同名记录。
--   专题汇报没有周期 key，允许重复创建，因此唯一索引只覆盖 kind='period'。
CREATE TABLE report (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('period','topic')),
  period         TEXT NOT NULL
                 CHECK (period IN ('day','week','month','quarter','half','year','topic')),
  -- 自然周期键：2026-10-24 / 2026-W43 / 2026-10 / 2026-Q4 / 2026-H2 / 2026；
  -- 专题汇报用生成时刻的 ISO 日期，仅用于展示与排序。
  period_key     TEXT NOT NULL,
  title          TEXT NOT NULL,
  content_md     TEXT,
  status         TEXT NOT NULL
                 CHECK (status IN ('generating','ready','failed','cancelled')),
  run_id         TEXT,
  error_message  TEXT,
  source_count   INTEGER NOT NULL DEFAULT 0,
  -- 专题汇报的“用户那段话”；周期汇报为 NULL。
  instruction_md TEXT,
  model          TEXT,
  mode           TEXT,
  generated_at   INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 只对周期汇报去重；专题汇报允许同名多条。
CREATE UNIQUE INDEX uq_report_period
  ON report(kind, period, period_key)
  WHERE kind = 'period';

CREATE INDEX idx_report_period_list ON report(period, updated_at DESC);
CREATE INDEX idx_report_updated ON report(updated_at DESC);

CREATE TABLE report_run (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('period','topic')),
  status            TEXT NOT NULL CHECK (status IN ('running','done','cancelled','failed')),
  -- 依次生成时的当前条目；失败/取消后保留最后处理到的位置，便于用户判断。
  current_period    TEXT,
  total             INTEGER NOT NULL DEFAULT 0,
  completed         INTEGER NOT NULL DEFAULT 0,
  cancel_requested  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  error_message     TEXT,
  -- 专题更新已有汇报时指向目标；新建专题为 NULL。
  target_report_id  TEXT,
  instruction_md    TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER
);

CREATE INDEX idx_report_run_status ON report_run(status, started_at DESC);
