-- The owner can confirm a mail-derived candidate as their own TODO. Confirming keeps the item
-- visible (marked as registered); every other correction still hides it.
-- migrate:up
ALTER TABLE work_corrections DROP CONSTRAINT work_corrections_action_check;
ALTER TABLE work_corrections ADD CONSTRAINT work_corrections_action_check
  CHECK (action = ANY (ARRAY['dismiss'::text, 'not_priority'::text, 'done'::text, 'wrong_project'::text, 'confirm'::text]));

-- migrate:down
DELETE FROM work_corrections WHERE action = 'confirm';
ALTER TABLE work_corrections DROP CONSTRAINT work_corrections_action_check;
ALTER TABLE work_corrections ADD CONSTRAINT work_corrections_action_check
  CHECK (action = ANY (ARRAY['dismiss'::text, 'not_priority'::text, 'done'::text, 'wrong_project'::text]));
