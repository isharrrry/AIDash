-- 005：主通道（project）记忆。
--
-- 为什么按 project 而不是 channel 存：
--   AGENTS §3.4 把 `host/project/topic` 中的 project 定义为“主对话”，topic 是它下面的
--   子话题。记忆要跨同一个项目的多个话题通道复用——在 auth 话题里踩过的坑，下次在
--   deploy 话题里也要能读到。按 channel 存会让同一份约束被复制成 N 份并逐渐分叉。
--
-- 为什么整篇存 Markdown，而不是拆成 key-value 行表：
--   用户要的是“可整体编辑的 Markdown 文档 + 按 key 搜行”。行表需要稳定的行 ID 和排序，
--   一旦用户在 Web 上整篇重写，行 ID 与文档内容就会失去对应关系；两套真相必然漂移。
--   这里把文档作为唯一真相，搜索在读取时按行切分，写入用版本号做乐观锁。
--
-- 为什么单独一张表，不塞进 setting：
--   setting 是配置快照（key/value JSON），没有版本、更新人、审计语义；
--   把会频繁追加的长期记忆混进配置表，会让“配置”与“内容”无法分别备份和排查。
CREATE TABLE project_memory (
  -- 主通道标识（channel_key 的第二段）。允许中文，不做外键：
  -- 通道可能被归档，但项目记忆应当保留，不能因为入口消失就级联删除。
  project    TEXT PRIMARY KEY,
  content_md TEXT NOT NULL DEFAULT '',
  -- 乐观锁版本：每次实际内容变化 +1。0 只出现在“尚未创建”的视图里，不落库。
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 最近一次写入者（harness/用户标签）。只用于排查“这条约束是谁加的”，不是权限依据。
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
