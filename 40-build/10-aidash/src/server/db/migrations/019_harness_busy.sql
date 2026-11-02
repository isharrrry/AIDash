-- 心跳里的 status_hint（idle/busy）需要落库：UI 才能把“在线”拆成
-- “运行中”和“空闲在线”。没有这一列时，轮询等任务的 runner 和执行长任务的
-- runner 在注册表里长得一模一样，用户无法判断它到底在不在干活。
--
-- 为什么不把 busy 并进 status：
--   1. status 带 CHECK 约束，且允许运营页 PATCH 手工改成 disabled/offline；
--      把运行态塞进去后，人工操作和下一拍心跳会互相覆盖；
--   2. status 表达“能不能联系上”，busy 表达“联系上时在不在干活”，两者正交。
-- 因此保留 status，新增 busy 列由心跳单独维护。
ALTER TABLE harness ADD COLUMN busy INTEGER NOT NULL DEFAULT 0;

-- 最近一次收到 busy/idle 提示的时间。NULL = 客户端从未上报过 status_hint，
-- 用来区分“上报了 idle”和“老客户端根本没有这个字段”。
ALTER TABLE harness ADD COLUMN busy_at INTEGER;
