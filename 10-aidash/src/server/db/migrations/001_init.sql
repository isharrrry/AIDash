-- 001：AIDash V2.0 初始 schema（05 §3，TBL-001~012）。
-- 设计纪律：
--   * 时间一律整数毫秒；
--   * 所有外键 RESTRICT，不使用 CASCADE；
--   * 业务记录只归档不物理删除；
--   * 状态枚举的 CHECK 只保证“值合法”，转移规则由 service 层守卫。

CREATE TABLE channel (
  id            TEXT PRIMARY KEY,
  channel_key   TEXT NOT NULL UNIQUE,
  title         TEXT,
  harness_id    TEXT,
  project       TEXT,
  topic         TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','archived')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER,

  CHECK (status <> 'archived' OR archived_at IS NOT NULL)
);

CREATE INDEX idx_channel_status_updated ON channel(status, updated_at DESC);

CREATE TABLE task (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES channel(id) ON DELETE RESTRICT,
  parent_id         TEXT REFERENCES task(id) ON DELETE RESTRICT,
  path              TEXT NOT NULL,
  title             TEXT NOT NULL,
  description_md    TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending','claimed','in_progress',
                                      'blocked','done','failed','cancelled')),
  priority          TEXT NOT NULL DEFAULT 'P2'
                    CHECK (priority IN ('P0','P1','P2','P3')),
  assignee          TEXT,
  tags_json         TEXT,
  due_at            INTEGER,

  claimed_by        TEXT,
  claim_token       TEXT,
  claim_expires_at  INTEGER,
  started_at        INTEGER,
  blocked_reason    TEXT,
  fail_reason       TEXT,
  evidence_json     TEXT,

  idempotency_key   TEXT,
  created_by        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  CHECK (id <> parent_id),
  CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL),
  CHECK (status <> 'failed'  OR fail_reason IS NOT NULL),
  CHECK (status NOT IN ('claimed','in_progress','blocked')
         OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('done','failed','cancelled') OR claim_token IS NULL),
  CHECK (status <> 'done' OR evidence_json IS NOT NULL)
);

CREATE INDEX idx_task_channel_status ON task(channel_id, status, created_at DESC);
CREATE INDEX idx_task_parent          ON task(parent_id);
CREATE INDEX idx_task_path            ON task(path);
CREATE INDEX idx_task_assignee_status ON task(assignee, status);
CREATE INDEX idx_task_lease           ON task(claim_expires_at)
  WHERE status IN ('claimed','in_progress','blocked');

CREATE UNIQUE INDEX uq_task_idem
  ON task(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE card (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES channel(id) ON DELETE RESTRICT,
  type              TEXT NOT NULL
                    CHECK (type IN ('info','handoff','question','suggestion','status','artifact')),
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','answered','dismissed','expired','archived')),
  priority          TEXT NOT NULL DEFAULT 'P2'
                    CHECK (priority IN ('P0','P1','P2','P3')),

  title             TEXT,
  body_md           TEXT,
  background_md     TEXT,
  message_md        TEXT,
  summary           TEXT,
  detail_md         TEXT,

  severity          TEXT CHECK (severity IS NULL OR severity IN ('info','warn','critical')),
  recipient         TEXT,
  channel_kind      TEXT CHECK (channel_kind IS NULL OR channel_kind IN ('email','wechat','other')),
  reason            TEXT,
  handoff_state     TEXT CHECK (handoff_state IS NULL OR handoff_state IN ('draft','copied','sent','ack')),
  options_json      TEXT,
  allow_free_text   INTEGER NOT NULL DEFAULT 0 CHECK (allow_free_text IN (0,1)),
  default_action    TEXT,
  due_at            INTEGER,
  answer_json       TEXT,
  answered_at       INTEGER,
  artifact_url      TEXT,
  artifact_kind     TEXT,
  links_json        TEXT,

  -- 04 已定义、05 初版漏写的类型字段（本次实现补齐，回写 05）
  result            TEXT CHECK (result IS NULL OR result IN ('success','failed','blocked','partial')),
  suggestions_json  TEXT,
  kb_refs_json      TEXT,
  confidence        REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  blocking          INTEGER NOT NULL DEFAULT 0 CHECK (blocking IN (0,1)),

  task_id           TEXT REFERENCES task(id) ON DELETE SET NULL,
  enrichment_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (enrichment_status IN ('pending','running','done','unavailable','skipped')),
  enrichment_json   TEXT,

  idempotency_key   TEXT,
  created_by        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER,

  CHECK (type <> 'question' OR (background_md IS NOT NULL AND options_json IS NOT NULL)),
  CHECK (type <> 'handoff'  OR (recipient IS NOT NULL AND channel_kind IS NOT NULL
                                AND reason IS NOT NULL AND message_md IS NOT NULL)),
  CHECK (type <> 'artifact' OR (artifact_url IS NOT NULL AND artifact_kind IS NOT NULL)),
  CHECK (type <> 'info' OR (title IS NOT NULL AND body_md IS NOT NULL AND severity IS NOT NULL)),
  CHECK (type <> 'status' OR (summary IS NOT NULL AND result IS NOT NULL)),
  CHECK (type <> 'suggestion' OR (body_md IS NOT NULL AND suggestions_json IS NOT NULL)),
  CHECK (status <> 'answered' OR (type = 'question' AND answered_at IS NOT NULL)),
  CHECK (status <> 'expired'  OR type = 'question'),
  CHECK (status <> 'archived' OR archived_at IS NOT NULL)
);

CREATE INDEX idx_card_channel_status_priority
  ON card(channel_id, status, priority, created_at DESC);
CREATE INDEX idx_card_type_status ON card(type, status, created_at DESC);
CREATE INDEX idx_card_task_type ON card(task_id, type, status);
CREATE UNIQUE INDEX uq_card_idem
  ON card(channel_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_card_due ON card(type, status, due_at)
  WHERE type = 'question' AND status = 'open';

CREATE TABLE card_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     TEXT NOT NULL REFERENCES card(id) ON DELETE RESTRICT,
  event       TEXT NOT NULL,
  actor       TEXT,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_card_event_card ON card_event(card_id, created_at);

CREATE TABLE task_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE RESTRICT,
  event       TEXT NOT NULL,
  actor       TEXT,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_task_event_task ON task_event(task_id, created_at);

CREATE TABLE artifact (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES card(id) ON DELETE RESTRICT,
  kind       TEXT NOT NULL CHECK (kind IN ('commit','file','log','report','url','other')),
  url        TEXT NOT NULL,
  summary    TEXT,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_artifact_card ON artifact(card_id, created_at);

CREATE TABLE harness (
  harness_id        TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  host              TEXT,
  capabilities_json TEXT,
  status            TEXT NOT NULL DEFAULT 'online'
                    CHECK (status IN ('online','offline','disabled')),
  last_seen         INTEGER NOT NULL,
  registered_at     INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_harness_status_seen ON harness(status, last_seen);

CREATE TABLE kb_doc (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  tags_json   TEXT,
  doc_date    TEXT,
  hash        TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL
);

CREATE INDEX idx_kb_doc_type ON kb_doc(type, indexed_at DESC);

CREATE VIRTUAL TABLE kb_fts USING fts5(
  title,
  description,
  body,
  tags,
  tokenize = 'unicode61'
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor_label  TEXT,
  action       TEXT NOT NULL,
  object_type  TEXT,
  object_id    TEXT,
  result       TEXT NOT NULL CHECK (result IN ('ok','denied','error')),
  request_id   TEXT,
  detail_json  TEXT,
  prev_hash    TEXT,
  hash         TEXT NOT NULL
);

CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX idx_audit_object ON audit_log(object_type, object_id, ts DESC);
CREATE INDEX idx_audit_action ON audit_log(action, ts DESC);
CREATE UNIQUE INDEX uq_audit_request ON audit_log(request_id)
  WHERE request_id IS NOT NULL;

CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
