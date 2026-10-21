-- migrate:up
-- 予約（時間になったら知らせる・頼む）と、端末へのお知らせ。
--
-- 予約は話し言葉から作る（「明日 9 時に〜教えて」「毎朝 8 時に〜まとめて」）。作る前に必ず言い直して
-- 確かめる（proposed → active）。時間になったら、お知らせ（reminder）を残すか、Task Dock で頼んだのと
-- 同じ入口（handleTurn）で頼む（task）。仕事の承認は、その仕事のときに承認カードで行う。

CREATE TABLE scheduled_jobs (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  -- 頼まれた会話。結果はここへ返す（Slack / LINE のスレッドならチャットへ）
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  -- 言い直した文（「平日の 9:00 に『日報を書く』をお知らせ」）
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  -- proposed: 確かめ中（10 分で消える） / active / paused / done（1 回だけのものが済んだ）
  -- cancelled（本人が取り消した） / disabled（失敗が続いて止めた。理由は last_error）
  status          text NOT NULL CHECK (status IN
    ('proposed','active','paused','done','cancelled','disabled')),
  -- {kind:'at',at} | {kind:'every',everyMs,anchorMs} | {kind:'weekly',days,hour,minute,tz} | {kind:'monthly',...}
  schedule        jsonb NOT NULL,
  -- {kind:'reminder',text} | {kind:'task',text}
  payload         jsonb NOT NULL,
  tz              text NOT NULL,
  -- 寝ていた・止まっていた間に過ぎた回: once = 1 回だけ追いつく / skip = 次の回まで待つ
  catch_up        text NOT NULL DEFAULT 'once' CHECK (catch_up IN ('once','skip')),
  next_run_at     timestamptz,
  -- 走っている回（1 つの予約で同時に走るのは 1 回だけ）
  running_at      timestamptz,
  last_run_at     timestamptz,
  last_status     text CHECK (last_status IN ('ok','error','skipped','interrupted')),
  last_error      text,
  consecutive_errors int NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  proposed_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_jobs_due ON scheduled_jobs (next_run_at) WHERE status = 'active';
CREATE INDEX scheduled_jobs_by_user ON scheduled_jobs (tenant_id, user_id, created_at);
-- 確かめ中の予約は、会話ごとに 1 つ
CREATE UNIQUE INDEX scheduled_jobs_one_proposal
  ON scheduled_jobs (conversation_id) WHERE status = 'proposed';
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_jobs_tenant_isolation ON scheduled_jobs
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
COMMENT ON TABLE scheduled_jobs IS
  '期限の来たテナントを探すときだけ astra_identity（bootstrap.sql で列を限って SELECT）。中身は withTenant で読む';

-- 1 回ごとの記録。実行の結果と、届けた結果は分けて持つ
CREATE TABLE scheduled_runs (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  job_id          uuid NOT NULL REFERENCES scheduled_jobs(id),
  -- 本来の予定時刻と、実際に始めた時刻（遅れを数えるため）
  scheduled_for   timestamptz NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL CHECK (status IN ('running','ok','error','skipped','interrupted')),
  -- delivered / failed / unknown（届いたか分からない。送り直さない） / none（届け先なし）
  delivery_status text CHECK (delivery_status IN ('delivered','failed','unknown','none')),
  task_id         uuid REFERENCES tasks(id),
  late_ms         bigint NOT NULL DEFAULT 0,
  error           text
);
-- 1 つの予約で走るのは 1 回だけ（DB が守る）
CREATE UNIQUE INDEX scheduled_runs_one_running ON scheduled_runs (job_id) WHERE status = 'running';
-- 同じ予定時刻を二度走らせない
CREATE UNIQUE INDEX scheduled_runs_once ON scheduled_runs (job_id, scheduled_for);
CREATE INDEX scheduled_runs_by_job ON scheduled_runs (tenant_id, job_id, started_at);
ALTER TABLE scheduled_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_runs_tenant_isolation ON scheduled_runs
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 端末へのお知らせ。Mac は数十秒ごとに取りに来て、macOS の通知に出す。
-- 予約のお知らせ・予約で始めた仕事・予約が止まったこと、を残す。
CREATE TABLE user_notices (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('reminder','scheduled_task','schedule_problem')),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body            text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  job_id          uuid REFERENCES scheduled_jobs(id),
  task_id         uuid REFERENCES tasks(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- 端末が受け取った（通知に出した）時刻。出したものは二度出さない
  delivered_at    timestamptz
);
CREATE INDEX user_notices_pending ON user_notices (tenant_id, user_id, created_at)
  WHERE delivered_at IS NULL;
ALTER TABLE user_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY user_notices_tenant_isolation ON user_notices
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS user_notices;
DROP TABLE IF EXISTS scheduled_runs;
DROP TABLE IF EXISTS scheduled_jobs;
