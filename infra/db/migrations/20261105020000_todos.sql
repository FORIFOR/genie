-- migrate:up
-- 締切のある「やること」（本人の設計 2026-11-05「予定とタスクを別の概念として管理する」）。
--
-- 予定（何時から何時）はカレンダーに、締切（いつまでに）はここに置く。LINE で「金曜までに見積書を出す」と
-- 言えば置き、「やることは？」で締切の早い順に見せ、「見積書出した」で済みにする。
-- 締切の朝の知らせは予約（scheduled_jobs）で作り、済んだら取り消す。
CREATE TABLE todos (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  -- 置いた会話（知らせはこの会話へ返す）
  conversation_id uuid REFERENCES conversations(id),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- 本人のタイムゾーンでの締切の日（時刻は持たない）
  due_date        date NOT NULL,
  -- open: まだ / done: 済んだ / deleted: 本人が消した
  status          text NOT NULL CHECK (status IN ('open', 'done', 'deleted')),
  reminder_job_id uuid REFERENCES scheduled_jobs(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);
CREATE INDEX todos_open ON todos (tenant_id, user_id, due_date) WHERE status = 'open';
-- 同じ名前のまだ済んでいないやることは 1 つ（言い直しは締切を変える）
CREATE UNIQUE INDEX todos_one_open_title ON todos (tenant_id, user_id, title) WHERE status = 'open';
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE todos FORCE ROW LEVEL SECURITY;
CREATE POLICY todos_tenant_isolation ON todos
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS todos;
