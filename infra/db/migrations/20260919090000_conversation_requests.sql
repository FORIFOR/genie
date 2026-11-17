-- Durable receipt reserved before any conversation/task side effect.
-- migrate:up
CREATE TABLE conversation_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  body_hash text NOT NULL,
  turn_id uuid NOT NULL,
  response jsonb,
  response_status integer CHECK (response_status IN (200, 202)),
  prepared_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, conversation_id, request_id),
  CHECK ((response IS NULL) = (response_status IS NULL))
);
ALTER TABLE conversation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_requests_tenant ON conversation_requests
  USING (tenant_id = astra_current_tenant()) WITH CHECK (tenant_id = astra_current_tenant());
-- migrate:down
DROP TABLE conversation_requests;
