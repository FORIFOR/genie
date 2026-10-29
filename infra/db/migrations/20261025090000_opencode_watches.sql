-- migrate:up
-- opencode のセッションの見守り。本人が「このセッションを10分ごとに見て、止まっていたら続けさせて」と頼んだもの。
--
--   決まった間隔で opencode の API（状態・最後の返答・承認待ち）を見る → 止まっていて終わっていなければ「続けて」を送る
--   → 承認・質問を待っていれば促さずに知らせる（1 回）。終わった・促しても進まない・つながらない・期限 で止めて知らせる
--
-- 残すのは、どこを見るか・最後に見た返答の印・回数だけ。セッションの本文は残さない。
CREATE TABLE opencode_watches (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  conversation_id   uuid NOT NULL REFERENCES conversations(id),
  base_url          text NOT NULL CHECK (length(base_url) BETWEEN 8 AND 300),
  session_id        text NOT NULL CHECK (session_id ~ '^ses_[A-Za-z0-9]{1,64}$'),
  interval_seconds  integer NOT NULL CHECK (interval_seconds BETWEEN 300 AND 7200),
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'done', 'stalled', 'unreachable', 'expired', 'stopped')),
  next_check_at     timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  -- 最後に促した時点の、セッションの最後の返答の印（促しても変わらなければ進んでいない）
  last_signature    text,
  nudges            integer NOT NULL DEFAULT 0 CHECK (nudges >= 0),
  idle_nudges       integer NOT NULL DEFAULT 0 CHECK (idle_nudges >= 0),
  failures          integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  -- 承認・質問の待ちを知らせた（待ちの間は促さずに見続け、知らせは 1 回だけ）
  waiting_notified  boolean NOT NULL DEFAULT false,
  ended_reason      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opencode_watches_due ON opencode_watches (next_check_at) WHERE status = 'active';
CREATE UNIQUE INDEX opencode_watches_one_active ON opencode_watches (tenant_id, user_id, base_url, session_id)
  WHERE status = 'active';
ALTER TABLE opencode_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE opencode_watches FORCE ROW LEVEL SECURITY;
CREATE POLICY opencode_watches_tenant_isolation ON opencode_watches
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS opencode_watches;
