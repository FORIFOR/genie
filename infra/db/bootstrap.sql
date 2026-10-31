-- クラスタ側の前提。マイグレーションではなく運用手順（ロールはデータベースを跨ぐため）。
-- 本番では terraform / Cloud SQL の IAM で同等の構成を作る。
--
--   psql "$ADMIN_DATABASE_URL" -f infra/db/bootstrap.sql
--
-- 重要: genie_app は superuser でも BYPASSRLS でもない。
--       superuser は FORCE ROW LEVEL SECURITY すら無視するため、
--       アプリが superuser で繋いだ瞬間にテナント隔離が消える（実装仕様 §4.4）。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'genie_app') THEN
    CREATE ROLE genie_app LOGIN PASSWORD 'genie_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astra_migrate') THEN
    -- マイグレーションと世界横断の保守だけがこのロールを使う
    CREATE ROLE astra_migrate LOGIN PASSWORD 'astra_migrate' BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astra_share') THEN
    -- 公開 viewer 専用（逸脱 D-22）。共有リンクの解決はテナントが分からない状態で
    -- 始まるため。BYPASSRLS だが GRANT を共有テーブルに限定する。
    CREATE ROLE astra_share LOGIN PASSWORD 'astra_share' BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'astra_identity') THEN
    -- 認証専用（逸脱 D-14）。ログインとサインアップはテナント確定前に走るため、
    -- RLS 下では users を引けない。BYPASSRLS だが GRANT を identity テーブルに限定し、
    -- このロールでは他のテーブルに一切触れないようにする。
    CREATE ROLE astra_identity LOGIN PASSWORD 'astra_identity' BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO genie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO genie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO genie_app;

-- 認証専用ロール: identity テーブルだけ。DELETE も与えない（identity は論理削除）。
GRANT USAGE ON SCHEMA public TO astra_identity;
GRANT SELECT, INSERT, UPDATE ON tenants, users, memberships, devices, sessions, user_identities
  TO astra_identity;
-- チャネル連携の照合も、受信した時点ではテナントが分からない。引くのと last_seen_at の更新だけ。
-- 連携を作る・切るのは本人の操作（テナント確定後、genie_app）で行う。
GRANT SELECT, UPDATE ON channel_links TO astra_identity;
-- グループ → 共有スペース。受信時はテナントが分からないので引くだけ（書くのは持ち主のテナントの中）
GRANT SELECT ON channel_groups TO astra_identity;
-- 通話のリンクは開いた時点でテナントが分からないので、ハッシュで引いて使った印を付けるだけ
GRANT SELECT (id, tenant_id, user_id, link_id, conversation_id, token_hash, expires_at, started_at, opening, household_id, group_id), UPDATE (started_at) ON call_sessions TO astra_identity;
-- opencode の見守りは、時間が来たものをテナントをまたいで取り出すだけ（見る・送るのは本人のテナントの中）
GRANT SELECT (id, tenant_id, status, next_check_at, auto_approve) ON opencode_watches TO astra_identity;
-- みんなの計画（Action Board）のページは開いた時点でテナントが分からないので、リンクのハッシュでテナントと計画を引くだけ
-- （計画の中身は、そのテナントの中で読む）
GRANT SELECT (token_hash, tenant_id, board_id, expires_at) ON group_board_links TO astra_identity;
-- 仕事のホーム（本人 1 人のページ）も同じく、リンクのハッシュでテナントと本人を引くだけ
GRANT SELECT (token_hash, tenant_id, user_id, expires_at) ON work_links TO astra_identity;
-- ブラウザの引き継ぎのリンク（LIFF から開く。リンクから本人と引き継ぎを引く）
GRANT SELECT (id, token_hash, tenant_id, user_id, state, expires_at) ON browser_handoffs TO astra_identity;
-- カードの画像（店の写真・地図）は LINE が取りに来た時点でテナントが分からないので、リンクのハッシュで引くだけ
GRANT SELECT (token_hash, tenant_id, kind, ref, source_entity_id, expires_at) ON channel_media TO astra_identity;
-- 連携コードの引き換え（使ったら used_at を入れる）。発行は本人の操作（genie_app）で行う。
GRANT SELECT, UPDATE ON channel_link_codes TO astra_identity;
-- 受信箱はテナントを持たない。重複の判定、処理待ちの取り出し（本文は封じたまま）、古い行の掃除。
GRANT SELECT, INSERT, UPDATE, DELETE ON channel_inbox TO astra_identity;
-- 着信の取り込みは、電話を繋いでいる利用者をテナントを跨いで知る必要がある。
-- **だれが繋いでいるかの列だけ。**トークン（token_ciphertext）はこのロールから読めない。
GRANT SELECT (tenant_id, user_id, revoked_at) ON phone_connections TO astra_identity;
-- 予約の見回りは、期限の来たテナントをテナントを跨いで知る必要がある。
-- **いつ・どのテナントかの列だけ。**頼みの中身（payload・name）はこのロールから読めない。
GRANT SELECT (tenant_id, status, next_run_at, running_at) ON scheduled_jobs TO astra_identity;
-- ほかの AI（Claude Code）の hooks は届いた時点でテナントが分からないので、鍵のハッシュでだれのものかを引くだけ
-- （セッションを書くのは、そのテナントの中で genie_app が行う）
GRANT SELECT (id, tenant_id, user_id, source, token_hash, revoked_at) ON agent_connections TO astra_identity;
-- 知らせの見回りは、時間が来たセッションをテナントをまたいで取り出すだけ（見る・知らせるのは本人のテナントの中）
GRANT SELECT (id, tenant_id, check_after) ON agent_sessions TO astra_identity;
-- エージェントの仕事の見回り（どのテナントに動かす仕事があるかだけ）
GRANT SELECT (id, tenant_id, status, control, next_run_at) ON agent_jobs TO astra_identity;
GRANT SELECT (id, tenant_id, user_id, provider, state, token_hash, expires_at) ON connector_reconnects TO astra_identity;
-- 保留の日が来たか・前の仕事を待っている頼みがあるかを、テナントをまたいで知るだけ（名前・理由・頼みの文は読めない）
GRANT SELECT (id, tenant_id, status, until_date, due_noticed_at) ON work_holds TO astra_identity;
GRANT SELECT (id, tenant_id, status) ON task_followups TO astra_identity;

-- 公開 viewer 専用ロール: 共有テーブルだけ。artifact は解決後に withTenant で読む。
GRANT USAGE ON SCHEMA public TO astra_share;
GRANT SELECT, UPDATE ON shares TO astra_share;
GRANT INSERT ON share_access_logs TO astra_share;
