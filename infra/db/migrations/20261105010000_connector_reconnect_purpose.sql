-- migrate:up
-- LINE からの手続きで、切れた接続のつなぎ直しに加えて「カレンダーに予定を入れる許可」も取れるようにする。
--   purpose = reconnect      … いままでのつなぎ直し（読む接続）
--   purpose = calendar_write … Google カレンダーの予定を作る接続（google-calendar-actions、calendar.events）。
--                              グループで頼まれた会議を Meet 付きで入れるときに要る
ALTER TABLE connector_reconnects
  ADD COLUMN purpose text NOT NULL DEFAULT 'reconnect'
  CHECK (purpose IN ('reconnect', 'calendar_write'));
-- カレンダーの書き込みは Google だけ
ALTER TABLE connector_reconnects ADD CONSTRAINT connector_reconnects_purpose_provider
  CHECK (purpose <> 'calendar_write' OR provider = 'google');

-- migrate:down
DELETE FROM connector_reconnects WHERE purpose = 'calendar_write';
ALTER TABLE connector_reconnects DROP CONSTRAINT connector_reconnects_purpose_provider;
ALTER TABLE connector_reconnects DROP COLUMN purpose;
