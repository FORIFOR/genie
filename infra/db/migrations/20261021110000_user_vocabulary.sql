-- migrate:up
-- 個人の辞書（置き換え）。音声入力で「こう聞こえたら、こう書く」。
--
--   ジーニー → Genie         （聞き違い・表記の直し）
--   カレンダーリンク → https://…（決まった文を入れる）
--   スーパーインターン → スーパーインターン（認識の手がかりだけ。spoken = written）
--
-- 会話で登録・一覧・削除する（「辞書に登録: ジーニーは Genie」）。Mac の音声入力が取りに来て、
-- 認識の手がかり（contextualStrings）と、入れる前の置き換えに使う。**モデルは通さない**（決定的に置き換える）。

CREATE TABLE user_vocabulary (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  -- 聞こえ方（認識の結果）。比べるときは前後の空白を除いたまま
  spoken      text NOT NULL CHECK (length(spoken) BETWEEN 1 AND 100),
  -- 書き方（入れる文）
  written     text NOT NULL CHECK (length(written) BETWEEN 1 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_vocabulary_spoken ON user_vocabulary (tenant_id, user_id, spoken);
ALTER TABLE user_vocabulary ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_vocabulary FORCE ROW LEVEL SECURITY;
CREATE POLICY user_vocabulary_tenant_isolation ON user_vocabulary
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS user_vocabulary;
