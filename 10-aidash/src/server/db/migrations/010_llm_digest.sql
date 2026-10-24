-- LLM 自动记忆归纳的运行记录。
--
-- 为什么单独建表，而不是把结果塞进 setting：
--   1. 归纳是按项目、按时间窗反复执行的过程，需要历史可追溯；
--   2. 用户要能看到“这次归纳了哪些行、为什么没写进去”，这属于运行时数据，
--      与运行参数（setting.runtime）的生命周期不同；
--   3. 表只追加，不参与业务外键，删除项目/通道也不会连带删掉历史诊断。
--
-- lines_json 存本次真正追加成功的记忆行（最多 5 行），用于页面回显；
-- error_message 只存收敛后的错误码/短消息，绝不落上游响应体或请求头。
CREATE TABLE memory_digest_run (
  id                 TEXT PRIMARY KEY,
  project            TEXT NOT NULL,
  trigger            TEXT NOT NULL CHECK (trigger IN ('manual','schedule')),
  window_start       INTEGER NOT NULL,
  window_end         INTEGER NOT NULL,
  source_count       INTEGER NOT NULL DEFAULT 0,
  appended           INTEGER NOT NULL DEFAULT 0,
  skipped_duplicates INTEGER NOT NULL DEFAULT 0,
  result             TEXT NOT NULL CHECK (result IN ('ok','empty','unavailable','failed')),
  error_message      TEXT,
  lines_json         TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_memory_digest_project
  ON memory_digest_run(project, created_at DESC);
