-- migrate:up
-- グループの会話を文脈として覚える（本人の設計 2026-10-28:「会話は理解する。ただし、呼ばれたときだけ発言する」）。
--
--   context  … 使い始めた（「@Genie このグループで使う」）グループの発言を覚える。呼ばれたら、その流れを踏まえて答える
--   mentions … 呼ばれたときの発言だけを使う（覚えない）
--   paused   … 一時停止。覚えない・答えない（「@Genie 再開」まで）
--
-- 既にあるグループは mentions のまま（黙って覚え始めない）。新しく使い始めたときに context にして、そのことをグループに知らせる。
-- 覚えた発言は context_days（既定 7 日）で消える。送信の取り消し・「忘れて」でも消す（deleted_at）。
-- 本人の Google カレンダー・家計簿・メールは、グループの答えに使わない（グループの会話だけが材料）。
ALTER TABLE households
  ADD COLUMN context_mode text NOT NULL DEFAULT 'mentions' CHECK (context_mode IN ('context', 'mentions', 'paused')),
  ADD COLUMN context_days integer NOT NULL DEFAULT 7 CHECK (context_days IN (1, 7, 30)),
  ADD COLUMN conversation_id uuid REFERENCES conversations(id);

CREATE TABLE group_messages (
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  household_id       uuid NOT NULL REFERENCES households(id),
  message_id         text NOT NULL CHECK (length(message_id) BETWEEN 1 AND 64),
  sender_id          text NOT NULL CHECK (length(sender_id) BETWEEN 1 AND 64),
  sender_name        text,
  text               text NOT NULL CHECK (length(text) <= 2000),
  quoted_message_id  text,
  from_genie         boolean NOT NULL DEFAULT false,
  sent_at            timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  deleted_at         timestamptz,
  PRIMARY KEY (tenant_id, household_id, message_id)
);
CREATE INDEX group_messages_recent ON group_messages (tenant_id, household_id, sent_at DESC);
ALTER TABLE group_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY group_messages_tenant_isolation ON group_messages
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS group_messages;
ALTER TABLE households DROP COLUMN IF EXISTS conversation_id, DROP COLUMN IF EXISTS context_days, DROP COLUMN IF EXISTS context_mode;
