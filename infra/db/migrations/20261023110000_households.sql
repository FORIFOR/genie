-- migrate:up
-- 家族・夫婦の共有スペース（LINE のグループに Genie を入れて使う）。
--
--   グループ ─ channel_groups ─ households ─ 家計簿（expenses.household_id）・買い物リスト・TODO・日程の候補
--
-- 共有スペースは、グループで「使う」と言った連携済みの本人（持ち主）のテナントに置く。
-- グループのほかの人は Genie の利用者でなくてよい（LINE の userId と表示名で記録する）。
-- **持ち主の個人のもの（メール・予定・ファイル・個人の家計簿）はグループからは読めない。**
-- グループから使えるのは、この共有スペースの表だけ。

CREATE TABLE households (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- グループに送られた写真を、メンションなしでもレシートとして読むか（既定は読まない）
  auto_receipts boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX households_by_owner ON households (tenant_id, owner_user_id);
ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
CREATE POLICY households_tenant_isolation ON households
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- LINE のグループ（複数人トークも）→ 共有スペース。受信時はテナントが分からないので astra_identity で引く。
CREATE TABLE channel_groups (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  household_id  uuid NOT NULL REFERENCES households(id),
  -- 持ち主（共有スペースの行はこの人の行として置く）
  owner_user_id uuid NOT NULL REFERENCES users(id),
  provider      text NOT NULL CHECK (provider IN ('line')),
  workspace_id  text NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  -- LINE の groupId（または roomId）
  group_id      text NOT NULL CHECK (length(group_id) BETWEEN 1 AND 128),
  -- 使い始めた人（連携済みの本人の LINE userId）
  enabled_by    text NOT NULL CHECK (length(enabled_by) BETWEEN 1 AND 128),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE UNIQUE INDEX channel_groups_active ON channel_groups (provider, workspace_id, group_id)
  WHERE revoked_at IS NULL;
ALTER TABLE channel_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_groups_tenant_isolation ON channel_groups
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 家計簿: 共有スペースの支出（household_id あり）と、個人の支出（なし）を分ける。
ALTER TABLE expenses ADD COLUMN household_id uuid REFERENCES households(id);
-- 共有スペースで付けた人（LINE の表示名）。個人の家計簿では null
ALTER TABLE expenses ADD COLUMN recorded_by text;
DROP INDEX IF EXISTS expenses_receipt_key;
DROP INDEX IF EXISTS expenses_image;
CREATE UNIQUE INDEX expenses_receipt_key ON expenses
  (tenant_id, user_id, coalesce(household_id, '00000000-0000-0000-0000-000000000000'::uuid), receipt_key)
  WHERE voided_at IS NULL;
CREATE UNIQUE INDEX expenses_image ON expenses
  (tenant_id, user_id, coalesce(household_id, '00000000-0000-0000-0000-000000000000'::uuid), image_sha256)
  WHERE voided_at IS NULL AND image_sha256 IS NOT NULL;
ALTER TABLE expense_budgets ADD COLUMN household_id uuid REFERENCES households(id);
ALTER TABLE expense_budgets DROP CONSTRAINT expense_budgets_pkey;
CREATE UNIQUE INDEX expense_budgets_scope ON expense_budgets
  (tenant_id, user_id, coalesce(household_id, '00000000-0000-0000-0000-000000000000'::uuid), category, currency);

-- 買い物リスト（共有スペースか、個人）。
CREATE TABLE shopping_items (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  household_id  uuid REFERENCES households(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  added_by      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  bought_at     timestamptz,
  bought_by     text
);
CREATE INDEX shopping_items_open ON shopping_items (tenant_id, household_id, created_at) WHERE bought_at IS NULL;
ALTER TABLE shopping_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_items FORCE ROW LEVEL SECURITY;
CREATE POLICY shopping_items_tenant_isolation ON shopping_items
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 共有の TODO（担当は LINE の表示名）。
CREATE TABLE household_todos (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  household_id  uuid REFERENCES households(id),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  assignee      text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz,
  done_by       text
);
CREATE INDEX household_todos_open ON household_todos (tenant_id, household_id, created_at) WHERE done_at IS NULL;
ALTER TABLE household_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_todos FORCE ROW LEVEL SECURITY;
CREATE POLICY household_todos_tenant_isolation ON household_todos
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 日程の候補と、各自の都合（「11/3 11/4 11/5 で日程調整」→「3日と5日なら行ける」→「決めて」）。
CREATE TABLE date_polls (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  household_id  uuid NOT NULL REFERENCES households(id),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- 候補（YYYY-MM-DD の配列）
  candidates    jsonb NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided       text,
  closed_at     timestamptz
);
CREATE INDEX date_polls_open ON date_polls (tenant_id, household_id, created_at) WHERE closed_at IS NULL;
ALTER TABLE date_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE date_polls FORCE ROW LEVEL SECURITY;
CREATE POLICY date_polls_tenant_isolation ON date_polls
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

CREATE TABLE date_poll_votes (
  poll_id       uuid NOT NULL REFERENCES date_polls(id),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  -- 答えた人（LINE の userId と表示名）
  voter         text NOT NULL CHECK (length(voter) BETWEEN 1 AND 128),
  voter_name    text,
  -- 行ける候補（YYYY-MM-DD の配列）
  available     jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, voter)
);
ALTER TABLE date_poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE date_poll_votes FORCE ROW LEVEL SECURITY;
CREATE POLICY date_poll_votes_tenant_isolation ON date_poll_votes
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS date_poll_votes;
DROP TABLE IF EXISTS date_polls;
DROP TABLE IF EXISTS household_todos;
DROP TABLE IF EXISTS shopping_items;
DROP INDEX IF EXISTS expense_budgets_scope;
ALTER TABLE expense_budgets DROP COLUMN IF EXISTS household_id;
ALTER TABLE expense_budgets ADD PRIMARY KEY (tenant_id, user_id, category, currency);
DROP INDEX IF EXISTS expenses_receipt_key;
DROP INDEX IF EXISTS expenses_image;
ALTER TABLE expenses DROP COLUMN IF EXISTS recorded_by;
ALTER TABLE expenses DROP COLUMN IF EXISTS household_id;
CREATE UNIQUE INDEX expenses_receipt_key ON expenses (tenant_id, user_id, receipt_key)
  WHERE voided_at IS NULL;
CREATE UNIQUE INDEX expenses_image ON expenses (tenant_id, user_id, image_sha256)
  WHERE voided_at IS NULL AND image_sha256 IS NOT NULL;
DROP TABLE IF EXISTS channel_groups;
DROP TABLE IF EXISTS households;
