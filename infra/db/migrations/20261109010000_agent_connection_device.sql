-- migrate:up
-- 別の PC の Claude Code（本人の設計 2026-11-09「別のPCの claude code も通知が来るように」）。
-- hooks の鍵を、この Mac の外の PC に渡したときは、その PC の名前を持つ。知らせの文を
-- 「Claude Code（genie・MacBook Air）が…MacBook Air のターミナルで確かめてください」にする。
-- null はこの Mac（いままでどおり）。
ALTER TABLE agent_connections
  ADD COLUMN device text CHECK (device IS NULL OR length(device) BETWEEN 1 AND 40);

-- migrate:down
ALTER TABLE agent_connections DROP COLUMN IF EXISTS device;
