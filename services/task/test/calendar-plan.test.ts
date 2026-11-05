/**
 * 予定を読む・時間を変える仕事の計画と、端末の事実から作る答え（仕様 v1.0 §11・§5⑤）。
 */
import { describe, expect, it } from 'vitest';
import { formatCalendarArtifact } from '../src/calendar-plan.js';
import { approvalSummaryFor, planTask } from '../src/plan.js';

describe('calendar plans', () => {
  it('reads the agenda on the device, and changes an event only with approval', () => {
    const agenda = planTask('calendar.agenda', {
      time_min: '2026-10-28T00:00:00+09:00',
      time_max: '2026-10-29T00:00:00+09:00',
      label: '明日',
    });
    expect(agenda.steps).toEqual([
      expect.objectContaining({ toolId: 'calendar.list_events', risk: 'READ', surface: 'local' }),
    ]);
    expect(agenda.artifact.mimeType).toBe('application/vnd.genie.agenda+json');

    const move = planTask('calendar.move', {
      event_id: 'ev-1',
      title: '定例ミーティング',
      after_start: '2026-10-28T14:00:00+09:00',
      after_end: '2026-10-28T15:00:00+09:00',
      before_label: '10/28（水） 10:00〜11:00',
      after_label: '10/28（水） 14:00〜15:00',
      time_zone: 'Asia/Tokyo',
    });
    expect(move.steps[0]).toMatchObject({
      toolId: 'calendar.move_event',
      risk: 'EXTERNAL_COMMIT',
      requiresConfirmation: true,
      message:
        '予定「定例ミーティング」を 10/28（水） 10:00〜11:00 → 10/28（水） 14:00〜15:00 に変更します',
      args: {
        event_id: 'ev-1',
        start: '2026-10-28T14:00:00+09:00',
        end: '2026-10-28T15:00:00+09:00',
      },
    });
    // 承認カードは、何がどう変わるかだけ（id や ISO の時刻は見せない）
    expect(approvalSummaryFor(move.steps[0]!)).toMatchObject({
      summary: '予定「定例ミーティング」を 10/28（水） 10:00〜11:00 → 10/28（水） 14:00〜15:00 に変更します',
      details: [
        { label: '変更前', value: '10/28（水） 10:00〜11:00' },
        { label: '変更後', value: '10/28（水） 14:00〜15:00' },
      ],
      impact: { primary_action_label: '変更する', scope: 'external' },
    });
    expect(() => planTask('calendar.move', { title: 'x' })).toThrow();
  });

  it('builds the answers from what the device returned', () => {
    const agenda = formatCalendarArtifact('calendar.agenda', { label: '明日' }, [
      [
        {
          id: 'ev-2',
          title: '打ち合わせ',
          status: 'confirmed',
          start: { dateTime: '2026-10-28T14:30:00+09:00' },
          end: { dateTime: '2026-10-28T15:30:00+09:00' },
        },
        {
          id: 'ev-x',
          title: '消えた予定',
          status: 'cancelled',
          start: { dateTime: '2026-10-28T09:00:00+09:00' },
          end: { dateTime: '2026-10-28T09:30:00+09:00' },
        },
        {
          id: 'ev-3',
          title: '誕生日',
          status: 'confirmed',
          start: { date: '2026-10-28' },
          end: { date: '2026-10-29' },
        },
      ],
    ])!;
    const card = JSON.parse(agenda.markdown) as { text: string; events: { id: string }[] };
    expect(card.text).toBe('明日の予定は 2 件です。\n・14:30〜15:30 打ち合わせ\n・終日 誕生日');
    expect(card.events.map((e) => e.id)).toEqual(['ev-2', 'ev-3']);
    expect(
      JSON.parse(formatCalendarArtifact('calendar.agenda', { label: '明日' }, [[]])!.markdown).text,
    ).toBe('明日の予定はありません。');

    expect(
      formatCalendarArtifact('calendar.move', { time_zone: 'Asia/Tokyo' }, [
        {
          before: {
            id: 'ev-1',
            title: '定例ミーティング',
            start: { dateTime: '2026-10-28T10:00:00+09:00' },
            end: { dateTime: '2026-10-28T11:00:00+09:00' },
          },
          after: {
            id: 'ev-1',
            title: '定例ミーティング',
            start: { dateTime: '2026-10-28T14:00:00+09:00' },
            end: { dateTime: '2026-10-28T15:00:00+09:00' },
          },
        },
      ])!.markdown,
    ).toBe(
      '予定「定例ミーティング」を 14:00〜15:00 に変更しました。元に戻すときは「元に戻して」と送ってください。',
    );
    // 端末が変えた結果を返さなければ、完了と書かない
    expect(() => formatCalendarArtifact('calendar.move', {}, [{}])).toThrow();
    expect(formatCalendarArtifact('research', {}, [])).toBeNull();
  });

  it('puts a meeting asked for in a group on the calendar with Meet, only with approval', () => {
    const input = {
      title: '打ち合わせ',
      start: '2026-11-06T15:00:00+09:00',
      end: '2026-11-06T15:30:00+09:00',
      when_label: '11/6(金) 15:00〜15:30',
      group_id: 'Cgroup',
      requested_by: '田中',
      meet_request_id: 'genie-123',
    };
    const plan = planTask('calendar.meeting', input);
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step).toMatchObject({
      toolId: 'calendar.create_event',
      risk: 'EXTERNAL_COMMIT',
      surface: 'local',
      requiresConfirmation: true,
      args: {
        title: '打ち合わせ',
        start: '2026-11-06T15:00:00+09:00',
        end: '2026-11-06T15:30:00+09:00',
        meet: true,
        meet_request_id: 'genie-123',
      },
    });
    // 承認カード: どこから・誰が・いつ。グループの id や ISO の時刻は見せない
    const card = approvalSummaryFor(step);
    expect(card.summary).toContain('田中さん');
    expect(card.summary).toContain('打ち合わせ');
    expect(card.details).toEqual([
      { label: '頼まれた場所', value: 'グループ' },
      { label: '頼んだ人', value: '田中さん' },
      { label: '日時', value: '11/6(金) 15:00〜15:30' },
    ]);
    expect(JSON.stringify(card)).not.toContain('Cgroup');
    expect(card.impact.primary_action_label).toBe('予定を入れる');
    expect(() => planTask('calendar.meeting', { ...input, start: '' })).toThrow();

    // 答え: 端末が返した Meet のリンクから。付かなかったら付かなかったと言う
    const made = formatCalendarArtifact('calendar.meeting', input, [
      { title: '打ち合わせ', conferenceUri: 'https://meet.google.com/x' },
    ]);
    expect(made?.markdown).toContain('Google Meet: https://meet.google.com/x');
    const none = formatCalendarArtifact('calendar.meeting', input, [
      { title: '打ち合わせ', conferenceUri: null },
    ]);
    expect(none?.markdown).toContain('Meet のリンクは付きませんでした');
    expect(() => formatCalendarArtifact('calendar.meeting', input, [])).toThrow();
  });

  it('puts a meeting the owner asked for in 1:1 on the calendar, inviting only the people on the card', () => {
    const input = {
      title: '打ち合わせ',
      start: '2026-11-06T15:00:00+09:00',
      end: '2026-11-06T15:30:00+09:00',
      when_label: '11/6(金) 15:00〜15:30',
      attendees: 'a@example.com,not-an-email,b@example.jp',
      requested_by: '本人には出さない',
    };
    const step = planTask('calendar.meeting', input).steps[0]!;
    expect(step.message).toBe(
      '予定「打ち合わせ」（11/6(金) 15:00〜15:30）を Google Meet 付きでカレンダーに入れます、a@example.com・b@example.jp を招待して',
    );
    expect(step.args).toMatchObject({
      meet: true,
      attendees: ['a@example.com', 'b@example.jp'],
      send_invites: true,
    });
    const card = approvalSummaryFor(step);
    expect(card.details).toEqual([
      { label: '日時', value: '11/6(金) 15:00〜15:30' },
      { label: '招待する人', value: 'a@example.com、b@example.jp' },
    ]);
    expect(card.impact.recovery_note).toContain('このトーク');
    const made = formatCalendarArtifact('calendar.meeting', input, [
      { title: '打ち合わせ', conferenceUri: 'https://meet.google.com/x' },
    ]);
    expect(made?.markdown).toContain('a@example.com、b@example.jp に招待を送りました。');

    // 招待する人がいなければ、招待は送らない
    const alone = planTask('calendar.meeting', { ...input, attendees: undefined }).steps[0]!;
    expect(alone.args).not.toHaveProperty('send_invites');
    expect(alone.args).not.toHaveProperty('attendees');
  });
});
