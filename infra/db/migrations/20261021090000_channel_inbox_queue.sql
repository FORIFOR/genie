-- migrate:up
-- チャットの受信を「保存してから受け取ったと返す」ようにする（openclaw の ingress queue と同じ考え）。
--
-- これまでは 200 を返してから同じプロセスの中で処理していた。処理の途中でプロセスが落ちると、
-- 提供者はもう送り直さないので依頼が消えていた。
--
-- 本文を置くのは GENIE_SECRET_KEY があるときだけ。**封じて（AES-256-GCM）置き、処理したら消す。**
-- 鍵が無ければ payload は NULL のままで、これまでどおり本文を持たない（status は 'done' で入る）。

ALTER TABLE channel_inbox
  ADD COLUMN status text NOT NULL DEFAULT 'done'
    CHECK (status IN ('pending','processing','turning','done','dead')),
  -- 受けたものの種類（発話・ボタン・友だち追加）
  ADD COLUMN kind text CHECK (kind IN ('message','action','follow')),
  -- 封じた本文（aad は provider:event_id）。処理を終えたら NULL にする
  ADD COLUMN payload text,
  ADD COLUMN attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN last_error text,
  -- 同じ相手の発話は順番どおりに処理する（provider:workspace:subject）
  ADD COLUMN lane text;

-- 処理待ちと、途中で止まったものを拾う
CREATE INDEX channel_inbox_open ON channel_inbox (received_at)
  WHERE status IN ('pending','processing','turning');

-- チャットへの送信: 待ってから送り直す（429 の Retry-After、指数の間隔）
ALTER TABLE channel_outbox
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();

-- migrate:down
DROP INDEX IF EXISTS channel_inbox_open;
ALTER TABLE channel_outbox DROP COLUMN IF EXISTS next_attempt_at;
ALTER TABLE channel_inbox
  DROP COLUMN IF EXISTS lane,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS attempts,
  DROP COLUMN IF EXISTS payload,
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS status;
