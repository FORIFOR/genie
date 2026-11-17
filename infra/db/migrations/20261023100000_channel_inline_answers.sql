-- migrate:up
-- チャットでの会話（あいさつ・質問）は「受け付けました」を返さず、答えの文をそのまま返す。
-- 受付の行は見回りの起点として残すが、送らない（送った扱いにする）。この印が付いた仕事は、
-- 終わったら答えの本文を送る（連携の posting_policy が要約だけでも。本人がそのチャットで聞いた答えなので）。
ALTER TABLE channel_outbox ADD COLUMN answer_inline boolean NOT NULL DEFAULT false;

-- migrate:down
ALTER TABLE channel_outbox DROP COLUMN IF EXISTS answer_inline;
