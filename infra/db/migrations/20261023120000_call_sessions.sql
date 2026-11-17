-- migrate:up
-- LINE から Genie と話す（通話のページ）。1 回の通話につき 1 行。
--
--   1:1 のトークで「電話して」→ 10 分・1 回だけ使えるリンク（平文は返すだけ、残すのはハッシュ）
--   → ページを開いて話す → 音声は Gemini Live（本人のキー）→ 頼みは Genie の仕事（LINE の会話と同じ conversation）
--
-- 月の上限（分）は秒で数える。音声も文字起こしも残さない（残すのは時刻と長さだけ）。
CREATE TABLE call_sessions (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  link_id         uuid NOT NULL REFERENCES channel_links(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  started_at      timestamptz,
  ended_at        timestamptz,
  seconds         integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  end_reason      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_sessions_month ON call_sessions (tenant_id, user_id, started_at);
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY call_sessions_tenant_isolation ON call_sessions
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS call_sessions;
