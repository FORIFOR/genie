-- migrate:up
-- Media Resolver（本人の方針 2026-10-28: 実在のものに紐づいた本物の画像だけ。作った画像で代えない）。
--
-- LINE のカードに出す画像（店の写真・地図）は、Genie の gateway が中継する。
--   - Google のキーを LINE や端末へ出さない（キーは gateway から Google への見出し・URL にだけ載る）
--   - 写真そのものは保存しない。残すのは「どの店の・どの写真か / どこの地図か」と期限だけで、開かれるたびに取り直す
--   - リンクは乱数（平文は返すだけ、残すのはハッシュ）。7 日で使えなくなる
CREATE TABLE channel_media (
  token_hash        text PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  kind              text NOT NULL CHECK (kind IN ('place_photo', 'static_map')),
  -- place_photo: { place_id, photo_name } / static_map: { markers: [{ lat, lng, label }] }
  ref               jsonb NOT NULL,
  -- どの店・どこの画像か（Media Resolver の検証。place_photo は店の ID、static_map は 'search'）
  source_entity_id  text NOT NULL CHECK (length(source_entity_id) BETWEEN 1 AND 200),
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_media_expiry ON channel_media (expires_at);
ALTER TABLE channel_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_media FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_media_tenant_isolation ON channel_media
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS channel_media;
