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

-- 公開 viewer 専用ロール: 共有テーブルだけ。artifact は解決後に withTenant で読む。
GRANT USAGE ON SCHEMA public TO astra_share;
GRANT SELECT, UPDATE ON shares TO astra_share;
GRANT INSERT ON share_access_logs TO astra_share;
