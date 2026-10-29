-- migrate:up
-- ほかの AI（まず Claude Code）に頼んだ仕事の見守り（本人の方針 2026-10-28: Agent Orchestration の第 1 段）。
--
--   Claude Code の hooks が、セッションの出来事（始まった・頼まれた・道具を使った・承認を待っている・応答を終えた・終わった）
--   を手元の gateway へ送る → セッションごとに「いまどうなっているか」を 1 行に畳む → Task Dock が一覧で見る
--
-- 残すのは、どのセッションか・どのフォルダか・頼みの頭（短く）・状態・時刻だけ。
-- 道具の入出力・応答の本文・会話の記録の場所は残さない。
-- 「応答を終えた（Stop）」は「仕事が終わった」ではない。状態は idle（次の頼みを待っている）にする。
-- 本人が止めた（paused_by_user）セッションは、静かでも「止まっているかも」と言わない。

-- hooks が名乗るための鍵。平文は発行したときに 1 回返すだけで、残すのはハッシュ。
CREATE TABLE agent_connections (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  source        text NOT NULL CHECK (source IN ('claude_code')),
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  token_hash    text NOT NULL UNIQUE,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_connections_owner ON agent_connections (tenant_id, user_id);
ALTER TABLE agent_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_connections_tenant_isolation ON agent_connections
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

CREATE TABLE agent_sessions (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  connection_id        uuid NOT NULL REFERENCES agent_connections(id),
  source               text NOT NULL CHECK (source IN ('claude_code')),
  external_session_id  text NOT NULL CHECK (length(external_session_id) BETWEEN 1 AND 128),
  -- 作業フォルダの名前だけ（フルパスは残さない）
  project              text CHECK (length(project) <= 120),
  -- 最初の頼みの頭（1 行・80 字まで・鍵らしい文字列は伏せる）
  title                text CHECK (length(title) <= 120),
  state                text NOT NULL DEFAULT 'idle'
                       CHECK (state IN ('working', 'waiting_user', 'idle', 'error', 'ended')),
  -- waiting_user のとき: permission（道具の承認）/ input（返事・質問）。error のとき: 失敗の種類
  waiting_reason       text CHECK (length(waiting_reason) <= 60),
  user_policy          text NOT NULL DEFAULT 'watch' CHECK (user_policy IN ('watch', 'paused_by_user')),
  last_event           text NOT NULL CHECK (length(last_event) <= 40),
  last_activity_at     timestamptz NOT NULL,
  -- 応答を終えた時刻。直後に遅れて届いた道具の出来事で working に戻さないため
  turn_ended_at        timestamptz,
  ended_at             timestamptz,
  end_reason           text CHECK (length(end_reason) <= 40),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_sessions_external
  ON agent_sessions (tenant_id, user_id, source, external_session_id);
CREATE INDEX agent_sessions_recent ON agent_sessions (tenant_id, user_id, last_activity_at DESC);
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_sessions_tenant_isolation ON agent_sessions
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

COMMENT ON TABLE agent_connections IS
  'hooks が届いた時点ではテナントが分からないので、鍵のハッシュの照合は astra_identity（bootstrap.sql で列を限って SELECT）で行う';

-- migrate:down
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS agent_connections;
