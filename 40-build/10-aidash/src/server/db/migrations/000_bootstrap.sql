-- 000：迁移记录表本身。
-- 只允许迁移执行器读写；应用层不得修改历史记录。
CREATE TABLE IF NOT EXISTS schema_migration (
  version     INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
