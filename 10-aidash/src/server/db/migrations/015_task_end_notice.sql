-- 015：任务结束通知已读时间。
--
-- 语义：任务进入终态（done/failed/cancelled）时把该列清空，表示“产生了一条未确认的结束通知”；
-- 用户在任务树点一下该行后写入当前时间，表示已确认。之所以存在任务行而不是浏览器本地：
-- 换设备/清缓存后通知不应复活，也不应因为另一台设备点过就丢掉提醒。
ALTER TABLE task ADD COLUMN end_notice_read_at INTEGER;

-- 升级前的历史终态任务统一视为已读：否则升级后整棵任务树会一起高亮，
-- 用户无法分辨“刚结束的任务”和“几个月前就结束了、只是当时没有这个功能”。
-- 单位为毫秒，与其余时间列保持一致（SQLite 的 strftime 返回秒，需要乘 1000）。
UPDATE task
SET end_notice_read_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status IN ('done', 'failed', 'cancelled');
