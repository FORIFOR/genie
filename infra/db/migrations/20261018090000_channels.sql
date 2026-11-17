-- migrate:up
-- チャネル連携（Slack / LINE）の Phase 0。外へは何も送らない。表だけを用意する。
--
-- 受けてよいのは、連携済みの本人が 1:1 で書いた発話だけ。仕事の入口は Task Dock と同じ
-- handleTurn（service-conversation）で、チャネルのための別の流れは作らない。

-- 連携 1 件につき仮の端末を 1 つ持つ（contracts の DevicePlatform）。
-- requirePrincipal が deviceId を求めるのを緩めずに済み、監査に「どこから来たか」が残る。
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check
  CHECK (platform IN ('macos','windows','linux','web','slack','line'));

-- 外のアカウント → Genie の利用者。連携は本人が明示したときだけ作る（推測で結ばない）。
CREATE TABLE channel_links (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  provider       text NOT NULL CHECK (provider IN ('slack','line')),
  -- Slack は team（ワークスペース）、LINE は Bot の userId（Webhook の destination）
  workspace_id   text NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  -- 提供者側の利用者 ID（Slack の user、LINE の userId）
  subject        text NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  device_id      uuid NOT NULL REFERENCES devices(id),
  -- チャットへ返すのは外部への送信。既定は要約と Genie を開くリンクだけ
  posting_policy text NOT NULL DEFAULT 'summary_and_link'
    CHECK (posting_policy IN ('summary_and_link','full_text')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz,
  revoked_at     timestamptz
);
-- 有効な連携は、外の 1 人につき 1 つ。切ってから結び直すのは許す
CREATE UNIQUE INDEX channel_links_active_subject
  ON channel_links (provider, workspace_id, subject) WHERE revoked_at IS NULL;
CREATE INDEX channel_links_by_user ON channel_links (tenant_id, user_id) WHERE revoked_at IS NULL;
ALTER TABLE channel_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_links FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_links_tenant_isolation ON channel_links
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
COMMENT ON TABLE channel_links IS
  '受信時はテナントが分からないので、照合は astra_identity（bootstrap.sql で SELECT/UPDATE のみ）で引く';

-- 会話の単位 → conversation。Slack はスレッド、LINE は相手ごとに 1 つ。
CREATE TABLE channel_threads (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  link_id         uuid NOT NULL REFERENCES channel_links(id),
  thread_key      text NOT NULL CHECK (length(thread_key) BETWEEN 1 AND 128),
  -- 返す先（Slack の DM channel、LINE の userId）
  destination     text NOT NULL CHECK (length(destination) BETWEEN 1 AND 128),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, thread_key)
);
CREATE INDEX channel_threads_by_conversation ON channel_threads (tenant_id, conversation_id);
ALTER TABLE channel_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_threads_tenant_isolation ON channel_threads
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 受信箱。**同じ配信を二度受けない**（Slack の再送・LINE の再配信）。
-- 連携を照合する前に引くので tenant_id を持たない。そのぶん本文も持たない。
CREATE TABLE channel_inbox (
  provider    text NOT NULL CHECK (provider IN ('slack','line')),
  event_id    text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 256),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
-- 再送の窓（数分）を過ぎた行は消してよい
CREATE INDEX channel_inbox_by_age ON channel_inbox (received_at);

-- 送信待ち。task のイベント 1 つにつき、チャットへ送るのは一度だけ。
CREATE TABLE channel_outbox (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  link_id             uuid NOT NULL REFERENCES channel_links(id),
  task_id             uuid REFERENCES tasks(id),
  -- 送るきっかけになった task_events の sequence（受付の返事など、task に依らないものは NULL）
  event_sequence      bigint,
  -- 送るのは受付・承認待ち・一時停止・終わり（完了 / 失敗 / 中止）だけ。途中経過は流さない
  kind                text NOT NULL CHECK (kind IN
    ('accepted','waiting_approval','paused','completed','failed','cancelled','notice')),
  destination         text NOT NULL CHECK (length(destination) BETWEEN 1 AND 128),
  thread_key          text NOT NULL CHECK (length(thread_key) BETWEEN 1 AND 128),
  body                jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts            int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id text,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE UNIQUE INDEX channel_outbox_once
  ON channel_outbox (link_id, task_id, event_sequence)
  WHERE task_id IS NOT NULL AND event_sequence IS NOT NULL;
CREATE INDEX channel_outbox_pending ON channel_outbox (created_at) WHERE status = 'PENDING';
ALTER TABLE channel_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_outbox_tenant_isolation ON channel_outbox
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS channel_outbox;
DROP TABLE IF EXISTS channel_inbox;
DROP TABLE IF EXISTS channel_threads;
DROP TABLE IF EXISTS channel_links;
DELETE FROM devices WHERE platform IN ('slack','line');
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check
  CHECK (platform IN ('macos','windows','linux','web'));
