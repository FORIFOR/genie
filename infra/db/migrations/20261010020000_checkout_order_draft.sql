-- Order terms remain with the conversation across reconnects and interruptions.
-- migrate:up
ALTER TABLE conversation_states ADD COLUMN checkout_draft jsonb;

-- migrate:down
ALTER TABLE conversation_states DROP COLUMN checkout_draft;
