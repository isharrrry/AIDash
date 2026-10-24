-- 009：通道别名。
--
-- 为什么需要别名：
--   channel_key 是 `host/project/topic` 的机器标识，topic 往往是英文短名（auth-bug、
--   deploy），用户打开通道树时无法一眼看出 agent 正在做什么。别名是给人看的一句话
--   概述，由 agent 在 channel.upsert 时写入或中途更新，Web 默认优先显示它。
--
-- 为什么不覆盖 title/topic：
--   title 是通道的正式名称，topic 是 key 的解析结果，两者都可能被外部系统引用；
--   别名是展示层的可变标签，单独一列才能“改别名不影响筛选键和已有链接”。
--
-- 为什么允许为空：
--   历史通道没有别名，空值表示“回退到 topic/title/channel_key”，不回填假数据。
ALTER TABLE channel ADD COLUMN alias TEXT;

-- 列表搜索要能按别名命中：用户记得“登录 500 排查”，不一定记得 channel_key。
CREATE INDEX idx_channel_alias ON channel(alias);
