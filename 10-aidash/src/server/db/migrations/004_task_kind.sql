-- 004：任务类型（普通任务 / 建议）。
--
-- 为什么不复用 tags：建议需要被稳定地识别与筛选（会话开始时找出“等我批准的建议”），
-- 标签只是文本，既不能保证唯一口径，也无法在任务树里作为类型徽标展示。
--
-- 为什么不在这里加 CHECK：SQLite 的 ADD COLUMN 虽然允许 CHECK，但历史行不会重新校验，
-- 加在这里只是“新行受约束”的假象；类型枚举由 zod（taskCreateSchema）在入口处校验。
ALTER TABLE task ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';

-- 历史任务全部是普通任务，默认值即为回填结果；建议类型从本版开始使用。
