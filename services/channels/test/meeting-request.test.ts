/**
 * グループの「@Genie 明日15時から30分 打ち合わせ、Meet作って」を読む（決まった言い方だけ。モデルは使わない）。
 */
import { describe, expect, it } from 'vitest';
import { parseInviteRequest, parseMeetingRequest } from '../src/meeting-request.js';

// 2026-11-05（木）07:00 JST
const NOW = Date.parse('2026-11-05T07:00:00+09:00');
const read = (text: string) => parseMeetingRequest(text, NOW, 'Asia/Tokyo');

describe('meeting requests in a group', () => {
  it('reads the day, the time and the length', () => {
    expect(read('明日15時から30分 打ち合わせ、Meet作って')).toEqual({
      title: '打ち合わせ',
      start: '2026-11-06T15:00:00+09:00',
      end: '2026-11-06T15:30:00+09:00',
      whenLabel: '11/6(金) 15:00〜15:30',
      attendees: [],
    });
    expect(read('11/10 14:00〜15:30 定例MTG')).toMatchObject({
      title: '定例MTG',
      start: '2026-11-10T14:00:00+09:00',
      end: '2026-11-10T15:30:00+09:00',
    });
    expect(read('１１月７日１０：００ ミーティング 1時間半')).toMatchObject({
      start: '2026-11-07T10:00:00+09:00',
      end: '2026-11-07T11:30:00+09:00',
    });
  });

  it('reads afternoon, weekdays and next week', () => {
    // 「午後3時〜4時」の 4 時は午後
    expect(read('来週月曜 午後3時から4時まで 会議お願い')).toMatchObject({
      title: '会議',
      start: '2026-11-09T15:00:00+09:00',
      end: '2026-11-09T16:00:00+09:00',
    });
    // 曜日だけなら次のその曜日。長さが無ければ 1 時間
    expect(read('金曜10時半 Google Meetで採用面談')).toMatchObject({
      title: '採用面談',
      start: '2026-11-06T10:30:00+09:00',
      end: '2026-11-06T11:30:00+09:00',
    });
    // 来週の木曜（今日が木曜でも、来週のもの）
    expect(read('来週木曜 9時 MTG')?.start).toBe('2026-11-12T09:00:00+09:00');
    // 過ぎた月日は来年
    expect(read('1/8 10時 会議')?.start).toBe('2027-01-08T10:00:00+09:00');
  });

  it('reads invitees and ignores an @Genie prefix sent in a 1:1 chat', () => {
    // 実機（2026-11-05）: 1:1 トークで「@Genie …」と送られた
    expect(read('@Genie 明日15時から30分 打ち合わせ、Meet作って')).toMatchObject({
      title: '打ち合わせ',
      start: '2026-11-06T15:00:00+09:00',
      attendees: [],
    });
    expect(
      read('明日15時から30分 打ち合わせ、Taro.Y@Example.com と b@example.jp も招待して Meet作って'),
    ).toMatchObject({
      title: '打ち合わせ',
      end: '2026-11-06T15:30:00+09:00',
      attendees: ['taro.y@example.com', 'b@example.jp'],
    });
    // メールアドレスだけでは会議にしない
    expect(read('a@example.com も招待して')).toBeNull();
  });

  it('does not read questions, past times or requests without a time', () => {
    expect(read('Meet作って')).toBeNull();
    expect(read('明日の会議は何時？')).toBeNull();
    expect(read('今日6時 会議')).toBeNull();
    expect(read('明日15時 ランチ')).toBeNull();
    expect(read('買い物リストに牛乳')).toBeNull();
    // 終わりが始まりより前
    expect(read('明日23時から2時間 会議')).toBeNull();
  });

  it('reads a request to invite more people to the meeting already made', () => {
    // 実機（2026-11-05）の言い方
    expect(parseInviteRequest('horio.shuhei@saiteku.comも招待して')).toEqual([
      'horio.shuhei@saiteku.com',
    ]);
    expect(parseInviteRequest('@Genie A@example.com と b@example.jp を追加して')).toEqual([
      'a@example.com',
      'b@example.jp',
    ]);
    // 日本語入力の全角の＠も読む
    expect(parseInviteRequest('ｃ＠ｅｘａｍｐｌｅ．ｃｏｍ も入れて')).toEqual(['c@example.com']);
    expect(parseInviteRequest('c@example.com も入れて')).toEqual(['c@example.com']);
    // 招待の言葉が無い・問い・アドレスが無い
    expect(parseInviteRequest('a@example.com にメールして')).toBeNull();
    expect(parseInviteRequest('a@example.com は招待した？')).toBeNull();
    expect(parseInviteRequest('田中さんも招待して')).toBeNull();
  });
});
