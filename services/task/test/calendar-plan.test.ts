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
});
