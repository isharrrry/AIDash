-- 018：讨论任务的结论。
--
-- 为什么单独加列，而不是复用 description_md 或证据卡：
--   * description_md 是“要讨论什么”，会被编辑覆盖；结论是讨论结束时的产出，
--     需要保留“回答时的原始版本”，Web 详情与子讨论的父链上下文都直接读它；
--   * 证据卡记录执行过程（日志/产物），讨论的产出就是这段大白话回答，
--     混进卡片会让“结论”散落在多条消息里，子任务无法一次拿到完整上下文。
-- 非讨论任务的两列保持 NULL：结论只在 complete + kind='discussion' 时写入。
--
-- 为什么不给 kind 加 CHECK：与 004 同理，SQLite 的 ADD COLUMN 不会重新校验历史行，
-- 加在这里只会制造“新行受约束”的假象；类型枚举仍由 zod（taskCreateSchema）在入口收窄。
ALTER TABLE task ADD COLUMN discussion_answer_md TEXT;
ALTER TABLE task ADD COLUMN discussion_answered_at INTEGER;
