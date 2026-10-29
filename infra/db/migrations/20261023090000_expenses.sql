-- migrate:up
-- 家計簿（1 人分）。LINE などにレシートの写真を送ると、読んで付ける。
--
--   送る → 読む（モデル）→ 値を検める（合計・日付・通貨）→ 重複を見る → 付ける / 確かめる
--
-- **写真そのものは残さない。**残すのは読んだ値と、同じレシートを二度付けないための指紋だけ。
-- 共有（夫婦・家族）は次の段階。いまは付けた本人だけが見る。

CREATE TABLE expenses (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  -- 円なら円（最小単位ではない）。通貨ごとに集計する
  amount        numeric(12, 2) NOT NULL CHECK (amount > 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  category      text NOT NULL,
  merchant      text,
  spent_on      date NOT NULL,
  -- どこから付けたか（line / slack / manual）
  source        text NOT NULL,
  -- 同じレシートの指紋（店・日付・合計）と、写真の指紋。どちらかが同じなら二度付けない
  receipt_key   text NOT NULL,
  image_sha256  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 取り消した（消さずに印を付ける。取り消しを取り消せるように）
  voided_at     timestamptz
);
CREATE UNIQUE INDEX expenses_receipt_key ON expenses (tenant_id, user_id, receipt_key)
  WHERE voided_at IS NULL;
CREATE UNIQUE INDEX expenses_image ON expenses (tenant_id, user_id, image_sha256)
  WHERE voided_at IS NULL AND image_sha256 IS NOT NULL;
CREATE INDEX expenses_month ON expenses (tenant_id, user_id, spent_on);
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY expenses_tenant_isolation ON expenses
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- 費目ごとの月の予算（「食費の予算を 6 万円にして」）。
CREATE TABLE expense_budgets (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  category    text NOT NULL,
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  monthly     numeric(12, 2) NOT NULL CHECK (monthly > 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, category, currency)
);
ALTER TABLE expense_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_budgets_tenant_isolation ON expense_budgets
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());

-- migrate:down
DROP TABLE IF EXISTS expense_budgets;
DROP TABLE IF EXISTS expenses;
