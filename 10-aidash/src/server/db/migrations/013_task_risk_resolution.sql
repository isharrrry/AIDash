-- 隐患解除说明：复盘时直接读任务行，不必回查 task_event.detail_json。
--
-- 为什么单独加列而不是复用 risk_note：
-- risk_note 记录“当时留了什么坑”，是判断的原素材，不能被后来的结论覆盖；
-- risk_resolution 记录“后来补齐时怎么判断的”，两者并排展示才能复盘
-- “留隐患的抉择是否正确”。解除时不传说明则为 NULL（允许只点解除）。
ALTER TABLE task ADD COLUMN risk_resolution TEXT;
