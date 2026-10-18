/**
 * Work Context の純粋部分。正本 §6・§10、Phase 6。
 *
 * 見るのは:
 *   - 案件に寄る（cross-source: Gmail / Calendar / meeting が同じ案件に集まる）
 *   - 待ち（waiting on）と返すもの（owed）が推論される
 *   - 期限が文から取れる
 *   - スコアは決定的で、要因ごとに理由がある
 *   - **出所の無い出力は 1 件も無い**
 *   - 注入は関連する分だけ、上限つき
 *   - 推測を止めれば何も出ない（week の事実だけ残る）
 */
import { describe, expect, it } from 'vitest';
import type { WorkArtifact, WorkSemantic } from '@genie/contracts';
import { OwedItem } from '@genie/contracts';
import {
  applyUpdate,
  buildWorkContext,
  clusterProjects,
  deriveProfile,
  EMPTY_PERSONALIZATION,
  extractDeadline,
  injectionText,
  pressure,
  selectContextPack,
  rankPressure,
  ruleSemantic,
  selectInjection,
} from '../src/index.js';

const NOW = new Date('2026-09-07T09:00:00+09:00');
const iso = (d: string): string => new Date(d).toISOString();

function art(over: Partial<WorkArtifact> & { id: string; title: string }): WorkArtifact {
  return {
    source: 'gmail',
    kind: 'email',
    body_excerpt: null,
    people: [],
    direction: 'inbound',
    occurred_at: iso('2026-09-06T14:21:00+09:00'),
    ends_at: null,
    due_at: null,
    thread_id: null,
    project_hint: null,
    responded: null,
    completed: null,
    provenance: {
      source: over.source ?? 'gmail',
      external_id: over.id,
      label: over.title,
      observed_at: iso('2026-09-06T14:21:00+09:00'),
      url: null,
      excerpt: null,
    },
    semantic: null,
    origin: null,
    ...over,
  };
}
const sem = (over: Partial<WorkSemantic>): WorkSemantic => ({
  category: 'info',
  project: null,
  request: null,
  owner: null,
  waiting_on: null,
  due: null,
  confidence: 0.9,
  extracted_by: 'llm',
  ...over,
});

const MTI = { name: 'MTI 田中', email: 'tanaka@mti.example', role: 'from' as const };

const fixture: WorkArtifact[] = [
  art({
    id: 'm1',
    title: 'Re: MOPITA SITE_ID の件',
    thread_id: 'th-mopita',
    people: [MTI],
    direction: 'inbound',
    occurred_at: iso('2026-09-04T10:00:00+09:00'),
    semantic: sem({
      category: 'info',
      project: 'MOPITA連携',
      waiting_on: 'MTI',
      request: 'SITE_ID を受領する',
    }),
  }),
  art({
    id: 'm2',
    title: 'Re: MOPITA SITE_ID の件',
    thread_id: 'th-mopita',
    people: [{ name: 'MTI 田中', email: 'tanaka@mti.example', role: 'to' }],
    direction: 'outbound',
    occurred_at: iso('2026-09-05T11:00:00+09:00'),
    semantic: sem({
      category: 'request_to_other',
      project: 'MOPITA連携',
      waiting_on: 'MTI',
      request: 'SITE_ID の発行をお願いする',
    }),
  }),
  art({
    id: 'c1',
    title: 'MOPITA 定例',
    source: 'google_calendar',
    kind: 'calendar_event',
    occurred_at: iso('2026-09-07T15:00:00+09:00'),
    ends_at: iso('2026-09-07T16:00:00+09:00'),
    project_hint: 'MOPITA連携',
    people: [{ name: 'MTI 田中', email: 'tanaka@mti.example', role: 'attendee' }],
  }),
  art({
    id: 'mt1',
    title: 'MOPITA 定例（会議）',
    source: 'meeting',
    kind: 'action_item',
    occurred_at: iso('2026-09-06T16:42:00+09:00'),
    due_at: iso('2026-09-08T18:00:00+09:00'),
    semantic: sem({
      category: 'request_to_me',
      project: 'MOPITA連携',
      request: '本番対応',
      due: iso('2026-09-08T18:00:00+09:00'),
    }),
  }),
  art({
    id: 'e1',
    title: '【○○社】見積のご確認',
    people: [{ name: '佐藤', email: 'sato@example.com', role: 'from' }],
    thread_id: 'th-quote',
    occurred_at: iso('2026-09-05T09:30:00+09:00'),
    body_excerpt: '見積の確認をお願いします。9/9 までにご返信ください。',
    semantic: sem({
      category: 'request_to_me',
      project: '○○社 提案',
      request: '見積に返信する',
      due: iso('2026-09-09T18:00:00+09:00'),
    }),
  }),
  art({
    id: 'e2',
    title: 'Re: 【○○社】見積のご確認',
    people: [{ name: '佐藤', email: 'sato@example.com', role: 'from' }],
    thread_id: 'th-quote',
    occurred_at: iso('2026-09-06T18:00:00+09:00'),
    semantic: sem({ category: 'request_to_me', project: '○○社 提案', request: '見積に返信する' }),
  }),
  art({
    id: 'a1',
    title: 'Genie UI release',
    source: 'astra_task',
    kind: 'task',
    due_at: iso('2026-09-07T18:00:00+09:00'),
    direction: 'self',
    semantic: sem({
      category: 'request_to_me',
      project: 'Genie UI release',
      request: '無人 Verify driver',
    }),
  }),
  art({
    id: 'n1',
    title: '社内報 9 月号',
    occurred_at: iso('2026-09-01T09:00:00+09:00'),
    semantic: sem({ category: 'info' }),
  }),
];

describe('project clustering across sources', () => {
  it('puts Gmail, Calendar and the meeting action item of MOPITA into one project', () => {
    const clusters = clusterProjects(fixture);
    const mopita = clusters.find((c) => c.name === 'MOPITA連携')!;
    expect(mopita.artifacts.map((a) => a.source).sort()).toEqual([
      'gmail',
      'gmail',
      'google_calendar',
      'meeting',
    ]);
  });

  it('clusters by thread and by title overlap when no explicit project is given', () => {
    const clusters = clusterProjects([
      art({
        id: 'x1',
        title: 'Re: 契約書ドラフト 確認',
        thread_id: 't1',
        occurred_at: iso('2026-09-05T10:00:00+09:00'),
      }),
      art({
        id: 'x2',
        title: 'Fwd: 契約書ドラフト 確認',
        thread_id: 't1',
        occurred_at: iso('2026-09-05T11:00:00+09:00'),
      }),
      art({
        id: 'x3',
        title: '契約書ドラフト 確認 (再送)',
        occurred_at: iso('2026-09-06T11:00:00+09:00'),
      }),
      art({ id: 'y1', title: '忘年会の場所', occurred_at: iso('2026-09-06T12:00:00+09:00') }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.artifacts.map((a) => a.id)).toEqual(['x1', 'x2', 'x3']);
    expect(clusters[0]!.name).toBe('契約書ドラフト 確認');
  });
});

describe('waiting-on, owed and deadlines', () => {
  const ctx = buildWorkContext({
    artifacts: fixture,
    corrections: [],
    now: NOW,
    inferenceEnabled: true,
  });

  it('infers whom I am waiting on, from my own request without a reply', () => {
    expect(ctx.waiting_on.map((w) => [w.who, w.project])).toEqual([['MTI', 'MOPITA連携']]);
    expect(ctx.waiting_on[0]!.since_days).toBeGreaterThan(1.5);
  });

  it('infers what I owe, with the deadline the sender stated, and counts a resend', () => {
    const owed = ctx.owed.find((o) => o.to === '佐藤')!;
    expect(owed.what).toBe('見積に返信する');
    expect(owed.due_at).toBe(iso('2026-09-09T18:00:00+09:00'));
    const quote = ctx.priorities.find((p) => p.project === '○○社 提案')!;
    expect(quote.factors.find((f) => f.name === 'unanswered')!.reason).toContain('相手が再送');
  });

  it('does not list a request I already answered', () => {
    const answered = [
      art({
        id: 'q1',
        title: '資料ください',
        thread_id: 't',
        people: [{ name: '山田', email: null, role: 'from' }],
        occurred_at: iso('2026-09-05T09:00:00+09:00'),
        semantic: sem({ category: 'request_to_me' }),
      }),
      art({
        id: 'q2',
        title: 'Re: 資料ください',
        thread_id: 't',
        direction: 'outbound',
        occurred_at: iso('2026-09-05T10:00:00+09:00'),
      }),
    ];
    expect(
      buildWorkContext({ artifacts: answered, corrections: [], now: NOW, inferenceEnabled: true })
        .owed,
    ).toEqual([]);
  });

  it('extracts deadlines from Japanese and English phrases without guessing', () => {
    expect(extractDeadline('9/8 までにお願いします', NOW)?.at).toBe(
      iso('2026-09-08T18:00:00+09:00'),
    );
    expect(extractDeadline('明日までに返信ください', NOW)?.at).toBe(
      iso('2026-09-08T18:00:00+09:00'),
    );
    expect(extractDeadline('来週金曜に共有します', NOW)?.at).toBe(iso('2026-09-18T18:00:00+09:00'));
    expect(extractDeadline('please reply by Friday', NOW)?.at).toBe(
      iso('2026-09-11T18:00:00+09:00'),
    );
    expect(extractDeadline('2026-09-30T10:00 deadline', NOW)?.at).toBe(
      iso('2026-09-30T10:00:00+09:00'),
    );
    expect(extractDeadline('よろしくお願いします', NOW)).toBeNull();
  });
});

describe('priority scoring', () => {
  it('is deterministic and ranks the project that is due tomorrow, blocked and unanswered first', () => {
    const a = buildWorkContext({
      artifacts: fixture,
      corrections: [],
      now: NOW,
      inferenceEnabled: true,
    });
    const b = buildWorkContext({
      artifacts: [...fixture].reverse(),
      corrections: [],
      now: NOW,
      inferenceEnabled: true,
    });
    expect(a.priorities.map((p) => [p.project, p.score])).toEqual(
      b.priorities.map((p) => [p.project, p.score]),
    );
    expect(a.priorities[0]!.project).toBe('MOPITA連携');
    expect(a.priorities[0]!.lines).toContain('明日が期限');
    expect(a.priorities[0]!.lines).toContain('MTI からの返信待ち');
    expect(a.priorities[0]!.lines.some((l) => l.startsWith('今日 15:00'))).toBe(true);
    expect(a.priorities[0]!.counts).toMatchObject({ gmail: 2, google_calendar: 1, meeting: 1 });
  });

  it('explains every factor and keeps the weights summing to one', () => {
    const r = pressure({
      id: 'x',
      daysUntilDue: 1,
      unansweredHours: 50,
      resent: true,
      meetingsToday: 3,
      minGapMinutes: 15,
      hasPrepTask: true,
      blockedBy: 'MTI',
      lastActivityHours: 2,
      repetitions: 4,
      explicitPriority: 0,
    });
    expect(r.factors.map((f) => f.name)).toEqual([
      'deadline',
      'unanswered',
      'calendar',
      'dependency',
      'recency',
      'repetition',
      'explicit',
    ]);
    expect(r.factors.reduce((s, f) => s + f.weight, 0)).toBeCloseTo(1, 5);
    expect(r.factors.find((f) => f.name === 'deadline')!.reason).toBe('明日が期限');
    expect(r.factors.find((f) => f.name === 'dependency')!.reason).toBe('MTI 待ちで止まっている');
    expect(r.score).toBeGreaterThan(0.8);
    // 同点は id で並ぶ
    const same = {
      daysUntilDue: null,
      unansweredHours: null,
      resent: false,
      meetingsToday: 0,
      minGapMinutes: null,
      hasPrepTask: false,
      blockedBy: null,
      lastActivityHours: 1,
      repetitions: 1,
      explicitPriority: 0,
    };
    expect(
      rankPressure([
        { id: 'b', ...same },
        { id: 'a', ...same },
      ]).map((x) => x.id),
    ).toEqual(['a', 'b']);
  });

  it('gives every inference at least one source', () => {
    const ctx = buildWorkContext({
      artifacts: fixture,
      corrections: [],
      now: NOW,
      inferenceEnabled: true,
    });
    for (const p of ctx.priorities) expect(p.sources.length).toBeGreaterThan(0);
    for (const w of ctx.waiting_on) expect(w.sources.length).toBeGreaterThan(0);
    for (const o of ctx.owed) expect(o.sources.length).toBeGreaterThan(0);
    expect(ctx.week).toEqual({ meeting_hours: 1, deadlines: 3, unanswered: 2, waiting: 1 });
    // 同じ thread の再送は 1 件（出所は 2 つ、期限は最初のメールのもの）
    const quote = ctx.owed.find((o) => o.to === '佐藤')!;
    expect(quote.sources).toHaveLength(2);
  });

  it('honours a correction in one action and stops all inference in one action', () => {
    const corrected = buildWorkContext({
      artifacts: fixture,
      corrections: [{ item_id: 'project:p:mopita連携', action: 'not_priority', note: null }],
      now: NOW,
      inferenceEnabled: true,
    });
    expect(corrected.priorities.map((p) => p.project)).not.toContain('MOPITA連携');
    const off = buildWorkContext({
      artifacts: fixture,
      corrections: [],
      now: NOW,
      inferenceEnabled: false,
    });
    expect(off.priorities).toEqual([]);
    expect(off.owed).toEqual([]);
    expect(off.waiting_on).toEqual([]);
    expect(off.week.meeting_hours).toBe(1);
  });

  it('keeps a confirmed candidate visible as registered, and hides it once it is done or not mine', () => {
    const base = buildWorkContext({
      artifacts: fixture,
      corrections: [],
      now: NOW,
      inferenceEnabled: true,
    });
    const owed = base.owed[0]!;
    const priority = base.priorities[0]!;
    expect(base.owed.every((o) => o.confirmed === false)).toBe(true);
    const confirmed = buildWorkContext({
      artifacts: fixture,
      corrections: [
        { item_id: owed.id, action: 'confirm', note: null },
        { item_id: priority.id, action: 'confirm', note: null },
      ],
      now: NOW,
      inferenceEnabled: true,
    });
    expect(confirmed.owed.find((o) => o.id === owed.id)?.confirmed).toBe(true);
    expect(confirmed.priorities.find((p) => p.id === priority.id)?.confirmed).toBe(true);
    expect(confirmed.owed.filter((o) => o.confirmed)).toHaveLength(1);
    for (const action of ['done', 'dismiss'] as const) {
      const after = buildWorkContext({
        artifacts: fixture,
        corrections: [
          { item_id: owed.id, action: 'confirm', note: null },
          { item_id: owed.id, action, note: action === 'dismiss' ? '担当外' : null },
        ],
        now: NOW,
        inferenceEnabled: true,
      });
      expect(after.owed.map((o) => o.id)).not.toContain(owed.id);
    }
    for (const o of confirmed.owed) expect(OwedItem.parse(o).confirmed).toBe(o.confirmed);
  });
});

describe('context injection', () => {
  const ctx = buildWorkContext({
    artifacts: fixture,
    corrections: [],
    now: NOW,
    inferenceEnabled: true,
  });

  it('injects nothing for an unrelated question', () => {
    expect(selectInjection({ question: 'この画像のエラーコードは？', context: ctx })).toEqual([]);
    expect(injectionText({ question: '会議を録音して', context: ctx })).toBe('');
    expect(
      selectInjection({ question: 'この会議で何を聞くべき？', context: ctx }).length,
    ).toBeGreaterThan(0);
  });

  it('injects at most three priorities for a work question, and only the named project for a specific one', () => {
    const all = selectInjection({ question: '今日何を優先すべき？', context: ctx });
    expect(all.length).toBeLessThanOrEqual(3);
    expect(all[0]!.project).toBe('MOPITA連携');
    const one = selectInjection({ question: 'MOPITA の状況は？', context: ctx });
    expect(one.map((p) => p.project)).toEqual(['MOPITA連携']);
    const text = injectionText({ question: '今日何を優先すべき？', context: ctx });
    expect(text.startsWith('<work_context>')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(1_200);
    expect(text).not.toContain('社内報');
  });

  /**
   * CONTEXT_MINIMIZATION_GATE。
   *   work-related scheduling query → relevant project/task injected   PASS
   *   unrelated coding query        → work context injected            0
   *   email reply query             → target thread/project only       PASS
   *   meeting prep                  → participant + project + open items PASS
   * どの turn も selected / available を持つ。
   */
  it('minimizes: nothing for an unrelated coding question, and the stats say so', () => {
    for (const q of [
      'この Swift コード直して',
      'TypeScript で map と forEach の違いは？',
      '会議を録音して',
    ]) {
      const pack = selectContextPack({ question: q, context: ctx });
      expect(pack.intent, q).toBe('none');
      expect(pack.items, q).toEqual([]);
      expect(pack.text, q).toBe('');
      expect(pack.stats.selected_artifacts, q).toBe(0);
      expect(pack.stats.available_artifacts).toBeGreaterThan(0);
    }
  });

  it('minimizes: a scheduling question gets the relevant priorities, bounded', () => {
    const pack = selectContextPack({ question: '今日何を優先すべき？', context: ctx });
    expect(pack.intent).toBe('priorities');
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.items.length).toBeLessThanOrEqual(3);
    expect(pack.stats.selected_artifacts).toBe(pack.items.length);
    expect(pack.stats.selected_artifacts).toBeLessThanOrEqual(pack.stats.available_artifacts);
    expect(pack.stats.chars).toBe(pack.text.length);
  });

  it('keeps the concrete obligation and exact deadline in priority answers', () => {
    const p = ctx.priorities[0]!;
    const due = '2026-09-11T09:00:00.000Z';
    const pack = selectContextPack({
      question: '今週何がやばい？',
      context: {
        ...ctx,
        priorities: [{ ...p, due_at: due, lines: ['3 日後が期限', '担当者に未返信'] }],
        owed: [
          {
            id: 'owed:test',
            project: p.project,
            to: '担当者',
            what: '見積を提出する',
            due_at: due,
            sources: p.sources,
            confirmed: false,
          },
        ],
      },
    });
    expect(pack.text).toContain('見積を提出する');
    expect(pack.text).toContain(due);
    expect(pack.text).not.toContain('3 日後');
  });

  it('uses sourced previous meeting decisions only for meeting preparation', () => {
    const p = ctx.priorities[0]!;
    const brief = {
      event_id: 'event:test',
      title: '顧客定例',
      starts_at: NOW.toISOString(),
      project: p.project,
      previous: [{ text: 'Standard プランで提案する', sources: p.sources }],
      open_items: [],
      since_last_meeting: [],
      suggested_questions: [],
      provenance: p.sources,
      generated_at: NOW.toISOString(),
    };
    const prep = selectContextPack({
      question: '次の会議を準備して',
      context: ctx,
      meetingBrief: brief,
    });
    expect(prep.text).toContain('Standard プラン');
    expect(prep.text).toContain(p.sources[0]!.label);
    expect(prep.stats.selected_artifacts).toBeLessThanOrEqual(prep.stats.available_artifacts);
    expect(
      selectContextPack({ question: 'Swift コードを直して', context: ctx, meetingBrief: brief })
        .text,
    ).toBe('');
    expect(
      selectContextPack({
        question: '次の会議を準備して',
        context: { ...ctx, inference_enabled: false },
        meetingBrief: brief,
      }).text,
    ).toBe('');
  });

  it('minimizes: an email reply gets only the named counterpart, never the whole inbox', () => {
    const named = selectContextPack({ question: 'MTI に返信を書いて', context: ctx });
    expect(named.intent).toBe('email_reply');
    expect(named.items.map((i) => i.project)).toEqual(['MOPITA連携']);
    expect(named.text).not.toContain('○○社');
    expect(named.text).not.toContain('社内報');
    // 相手も案件も名指しされていない「返信して」には、何も添えない
    const vague = selectContextPack({ question: 'さっきのメールに返信して', context: ctx });
    expect(vague.intent).toBe('email_reply');
    expect(vague.items).toEqual([]);
    expect(vague.stats.selected_artifacts).toBe(0);
  });

  it('minimizes: meeting prep gets that project, its counterpart and open items', () => {
    const pack = selectContextPack({ question: 'MOPITA 定例の準備をしたい', context: ctx });
    expect(pack.intent).toBe('meeting_prep');
    expect(pack.items.map((i) => i.project)).toEqual(['MOPITA連携']);
    const lines = pack.items[0]!.lines.join('\n');
    expect(lines).toMatch(/MTI/);
    expect(pack.stats.selected_artifacts).toBeGreaterThanOrEqual(1);
    expect(pack.text).not.toContain('○○社');
  });

  /** ASTRA DAILY WORK GATE の 6 問。どれも意図が取れ、要るものだけが渡る。 */
  it('answers the six daily questions with the right kind of context', () => {
    const q = (text: string) => selectContextPack({ question: text, context: ctx });
    const today = q('今日何をすべき？');
    expect(today.intent).toBe('priorities');
    expect(today.items.length).toBeGreaterThan(0);

    const waiting = q('誰を待っている？');
    expect(waiting.intent).toBe('waiting');
    expect(waiting.items.map((i) => i.lines[0])).toEqual([
      expect.stringContaining('MTI からの返事待ち'),
    ]);

    const owed = q('私が返すものは？');
    expect(owed.intent).toBe('owed');
    expect(owed.items.map((i) => i.lines[0])).toEqual(
      expect.arrayContaining([expect.stringContaining('佐藤 に返す')]),
    );
    expect(owed.items.length).toBeLessThanOrEqual(3);

    const prep = q('次の会議を準備して');
    expect(prep.intent).toBe('meeting_prep');
    expect(prep.items.map((i) => i.project)).toEqual(['MOPITA連携']);

    const reply = q('これ返して');
    expect(reply.intent).toBe('email_reply');
    // 「これ」が何かは会話の指示語解決の仕事。ここでは名指しが無いので受信箱は添えない
    expect(reply.items).toEqual([]);

    const week = q('今週何がやばい？');
    expect(week.intent).toBe('priorities');
    expect(week.items.length).toBeGreaterThan(0);
    expect(week.stats.chars).toBeLessThanOrEqual(1_200);
  });

  it('never fabricates a deadline: no date in the text means no due', () => {
    const a = art({
      id: 'gmail:no-date',
      title: 'ご相談',
      body_excerpt: '先日の件について、お手すきの際にご確認ください。',
      people: [{ name: '田中', email: null, role: 'from' }],
    });
    expect(ruleSemantic(a, NOW).due).toBeNull();
    expect(extractDeadline(a.body_excerpt ?? '', NOW)).toBeNull();
  });

  it('injects nothing once the person turned inference off', () => {
    const profile = deriveProfile(
      fixture,
      { ...EMPTY_PERSONALIZATION, inference_enabled: false },
      NOW,
    );
    expect(selectInjection({ question: '今日何を優先すべき？', context: ctx, profile })).toEqual(
      [],
    );
  });
});

describe('personalization', () => {
  it('observes frequent entities, infers patterns, and never invents answer-style preferences', () => {
    const p = deriveProfile(fixture, EMPTY_PERSONALIZATION, NOW);
    expect(p.frequent_entities.find((t) => t.label === 'MOPITA連携')?.status).toBe('observed');
    expect(p.frequent_entities.every((t) => t.sources.length > 0)).toBe(true);
    expect(p.working_style).toEqual([]);
    expect(p.inference_enabled).toBe(true);
  });

  it('uses a corrected writing preference immediately instead of its stale default label', () => {
    const stored = applyUpdate(
      EMPTY_PERSONALIZATION,
      {
        traits: [
          {
            key: 'style.prefersConcise',
            status: 'confirmed',
            value: '詳しく、出所と一緒に説明する',
          },
        ],
      },
      NOW,
    );
    expect(deriveProfile(fixture, stored, NOW).working_style[0]?.label).toBe(
      '詳しく、出所と一緒に説明する',
    );
  });

  it('lets the person confirm a style and disable one inference in one update', () => {
    const stored = applyUpdate(
      EMPTY_PERSONALIZATION,
      {
        traits: [
          { key: 'style.prefersConcise', status: 'confirmed', value: 1 },
          { key: 'entity.project.p:mopita連携', enabled: false },
        ],
      },
      NOW,
    );
    const p = deriveProfile(fixture, stored, NOW);
    expect(p.working_style).toEqual([
      expect.objectContaining({
        key: 'style.prefersConcise',
        label: '短く要点から',
        status: 'confirmed',
      }),
    ]);
    expect(p.frequent_entities.find((t) => t.label === 'MOPITA連携')?.enabled).toBe(false);
    const off = applyUpdate(stored, { inference_enabled: false, traits: [] }, NOW);
    expect(deriveProfile(fixture, off, NOW).inference_enabled).toBe(false);
  });
});

describe('rule-based semantic stand-in', () => {
  it('classifies by surface cues only and with low confidence', () => {
    const s = ruleSemantic(
      art({
        id: 'r',
        title: 'ご確認のお願い',
        body_excerpt: '9/10 までにご返信ください',
        people: [MTI],
      }),
      NOW,
    );
    expect(s).toMatchObject({ category: 'request_to_me', extracted_by: 'rule', confidence: 0.4 });
    expect(s.due).toBe(iso('2026-09-10T18:00:00+09:00'));
    expect(
      ruleSemantic(art({ id: 'r2', title: '社内報', body_excerpt: 'お知らせです' }), NOW).category,
    ).toBe('info');
  });
});

describe('emails that arrive without a meaning', () => {
  it('are classified by the rule stand-in so they still show up as owed', () => {
    // 端末に LLM が無い人のメール。semantic は null で届く。
    const ctx = buildWorkContext({
      artifacts: [
        art({
          id: 'gmail:no-llm',
          title: 'MOPITA 見積の確認をお願いします',
          body_excerpt: '9/9 までにご確認いただけますか',
          people: [{ name: '田中', email: 'tanaka@example.com', role: 'from' }],
          thread_id: 'gmail:t-no-llm',
        }),
      ],
      corrections: [],
      now: NOW,
      inferenceEnabled: true,
    });
    expect(ctx.owed.map((o) => o.to)).toEqual(['田中']);
    expect(ctx.owed[0]!.sources[0]!.external_id).toBe('gmail:no-llm');
  });

  it('never overrides what the device LLM already decided', () => {
    const ctx = buildWorkContext({
      artifacts: [
        art({
          id: 'gmail:llm',
          title: '見積の確認をお願いします',
          people: [{ name: '田中', email: null, role: 'from' }],
          semantic: sem({ category: 'info', extracted_by: 'llm', confidence: 0.9 }),
        }),
      ],
      corrections: [],
      now: NOW,
      inferenceEnabled: true,
    });
    expect(ctx.owed).toEqual([]);
  });
});
