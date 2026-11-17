-- migrate:up
-- Genie が本人に確かめている途中のこと（「家計簿に付けますか？」「カレンダーに入れますか？」）。会話に 1 つ。
--
-- これまではプロセスの記憶の中だけで、再起動すると「はい」が効かなかった（仕様 v1.0 §9: やり直させない）。
-- 中身は確かめている内容だけ（読み取った金額・日付・費目、入れる予定の文）。写真そのものは持たない。期限は 10 分。
CREATE TABLE pending_confirmations (
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  conversation_id  uuid NOT NULL REFERENCES conversations(id),
  kind             text NOT NULL CHECK (kind IN ('expense', 'event')),
  payload          jsonb NOT NULL,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id)
);
ALTER TABLE pending_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_confirmations_tenant_isolation ON pending_confirmations
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS pending_confirmations;
