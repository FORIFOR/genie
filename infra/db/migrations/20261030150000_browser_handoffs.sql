-- migrate:up
-- Genie 専用のブラウザがつまずいたとき（ログインが要るページ）の引き継ぎ。
-- 本人が LINE のリンク（LIFF）から同じブラウザの画面を見て操作し、終わったら Genie が続ける
-- （services/api-gateway/src/browser-handoff.ts、workers/agent-host/src/browser-handoff.ts）。
-- リンクはサインインの代わりの 24 バイトの乱数（残すのはハッシュ）。15 分で切れる。
-- 画面の画像と入力（文字）は残さない（gateway のメモリで取り次ぐだけ）。ここに残すのは、いつ・どのサイトで・どうなったかだけ。

CREATE TABLE browser_handoffs (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_id    uuid NOT NULL,
  host_id       uuid NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('login_required')),
  -- 開いていたサイトの名前（ホスト名だけ。アドレスの道・問いは残さない）
  site          text NOT NULL CHECK (length(site) BETWEEN 1 AND 253),
  token_hash    text NOT NULL UNIQUE,
  state         text NOT NULL DEFAULT 'waiting'
                  CHECK (state IN ('waiting', 'resumed', 'timed_out', 'cancelled', 'failed')),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  CHECK ((state = 'waiting') = (ended_at IS NULL))
);
CREATE INDEX browser_handoffs_task ON browser_handoffs (tenant_id, task_id);
CREATE INDEX browser_handoffs_user ON browser_handoffs (tenant_id, user_id, created_at DESC);
ALTER TABLE browser_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_handoffs_tenant_isolation ON browser_handoffs
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS browser_handoffs;
