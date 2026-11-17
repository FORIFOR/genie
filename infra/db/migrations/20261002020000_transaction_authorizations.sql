-- Bounded human consent and an append-only quota reservation ledger.
-- Reservations are never refunded after failure, cancellation or unknown outcome.
-- migrate:up
CREATE TABLE transaction_authorizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  initial_approval_id uuid REFERENCES approvals(id),
  spec jsonb NOT NULL,
  spec_hash char(64) NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, created_by, request_id),
  CHECK (expires_at > created_at),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX transaction_authorizations_active ON transaction_authorizations (tenant_id, created_by, expires_at)
  WHERE status = 'ACTIVE';
CREATE FUNCTION genie_bound_authorization_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.created_by, NEW.request_id, NEW.initial_approval_id, NEW.spec, NEW.spec_hash, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.created_by, OLD.request_id, OLD.initial_approval_id, OLD.spec, OLD.spec_hash, OLD.created_at, OLD.expires_at)
    OR (OLD.status = 'REVOKED' AND ROW(NEW.status, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.status, OLD.revoked_at)) THEN
    RAISE EXCEPTION 'bounded authorization terms are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transaction_authorizations_immutable_terms BEFORE UPDATE ON transaction_authorizations
  FOR EACH ROW EXECUTE FUNCTION genie_bound_authorization_update();
CREATE TRIGGER transaction_authorizations_no_delete BEFORE DELETE OR TRUNCATE ON transaction_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION astra_deny_mutation();

CREATE TABLE transaction_authorization_uses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  authorization_id uuid NOT NULL,
  approval_id uuid NOT NULL UNIQUE REFERENCES approvals(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  step_index integer NOT NULL CHECK (step_index >= 0),
  provider text NOT NULL,
  mode text NOT NULL CHECK (mode = 'simulation'),
  account text NOT NULL,
  order_key text NOT NULL,
  inputs_hash char(64) NOT NULL CHECK (inputs_hash ~ '^[0-9a-f]{64}$'),
  quote_hash char(64) NOT NULL CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, authorization_id) REFERENCES transaction_authorizations(tenant_id, id),
  UNIQUE (tenant_id, provider, mode, account, order_key),
  UNIQUE (task_id, step_index)
);
CREATE INDEX transaction_authorization_uses_grant ON transaction_authorization_uses (tenant_id, authorization_id);
CREATE TRIGGER transaction_authorization_uses_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON transaction_authorization_uses
  FOR EACH STATEMENT EXECUTE FUNCTION astra_deny_mutation();

ALTER TABLE transaction_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY transaction_authorizations_tenant ON transaction_authorizations
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
ALTER TABLE transaction_authorization_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_authorization_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY transaction_authorization_uses_tenant ON transaction_authorization_uses
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
-- migrate:down
DROP TABLE transaction_authorization_uses;
DROP TABLE transaction_authorizations;
DROP FUNCTION genie_bound_authorization_update();
