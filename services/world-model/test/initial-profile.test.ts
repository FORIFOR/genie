import { describe, expect, it } from 'vitest';
import { InitialProfile, InitialProfileAnalysis, type WorkArtifact } from '@genie/contracts';
import { initialSnapshot } from '../src/work/initial-profile.js';

const NOW = new Date('2026-09-09T12:00:00Z');
const mail = (
  id: string,
  direction: 'inbound' | 'outbound' = 'inbound',
  address = 'colleague@example.invalid',
  name = 'Colleague',
): WorkArtifact => ({
  id,
  source: 'gmail',
  kind: 'email',
  title: 'Project review',
  body_excerpt: null,
  direction,
  occurred_at: NOW.toISOString(),
  ends_at: null,
  due_at: null,
  thread_id: id,
  project_hint: null,
  responded: null,
  completed: null,
  semantic: null,
  origin: null,
  people: [
    { name, email: address, role: direction === 'inbound' ? 'from' : 'to' },
    {
      name: 'Mailbox owner',
      email: 'self@example.invalid',
      role: direction === 'inbound' ? 'to' : 'from',
    },
  ],
  provenance: {
    source: 'gmail',
    external_id: id,
    label: 'Project review',
    observed_at: NOW.toISOString(),
    url: null,
    excerpt: null,
  },
});
const analysis = (ids: string[] = ['one']): InitialProfileAnalysis => ({
  version: 2,
  status: 'complete',
  selected_count: ids.length,
  analyzed_count: ids.length,
  analyzed_ids: ids,
  excluded_ids: [],
  focus: [],
  priorities: [],
  open_items: [],
});
const event = (id: string, day: number, hour = 13): WorkArtifact => {
  const start = new Date(Date.UTC(2026, 8, day, hour - 9));
  return {
    ...mail(id),
    source: 'google_calendar',
    kind: 'calendar_event',
    occurred_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
  };
};

describe('evidence-based initial profile', () => {
  it('accepts one hundred grounded mail sources while retaining the legacy range', () => {
    for (const count of [24, 100]) {
      const ids = Array.from({ length: count }, (_, i) => `mail-${i}`);
      const result = InitialProfileAnalysis.parse({
        ...analysis(ids),
        focus: [{ text: '共同プロジェクトの見直し', source_ids: ids }],
      });
      expect(
        initialSnapshot(
          ids.map((id) => mail(id)),
          NOW,
          result,
        ).sections.focus,
      ).toEqual(['共同プロジェクトの見直し']);
    }
    const over = analysis(Array.from({ length: 101 }, (_, i) => `mail-${i}`));
    expect(InitialProfileAnalysis.safeParse(over).success).toBe(false);
  });
  it('keeps missing analysis empty even when subjects resemble urgent requests', () => {
    const snapshot = initialSnapshot(
      [
        { ...mail('one'), title: 'Please approve your special offer today?' },
        {
          ...mail('two'),
          title: 'Newsletter: weekly project update',
          project_hint: 'Invented project',
        },
        event('calendar', 8),
      ],
      NOW,
    );
    expect(snapshot.sections).toEqual({
      focus: [],
      priorities: [],
      people: [],
      work_pattern: [],
      open_items: 0,
    });
    expect(snapshot.profile.frequent_entities).toEqual([]);
    expect(snapshot.profile.work_patterns).toEqual([]);
  });

  it('uses analyzed claims rather than raw subjects and counts evidenced open items', () => {
    const local = {
      ...analysis(),
      focus: [{ text: 'Preparing the launch', source_ids: ['one'] }],
      priorities: [{ text: 'Review the agreed schedule', source_ids: ['one'] }],
      open_items: [{ text: 'Send the agreed response', source_ids: ['one'] }],
    };
    expect(initialSnapshot([mail('one')], NOW, local).sections).toMatchObject({
      focus: ['Preparing the launch'],
      priorities: ['Review the agreed schedule'],
      open_items: 1,
    });
    expect(
      initialSnapshot([mail('one'), mail('two')], NOW, {
        ...local,
        status: 'partial',
        selected_count: 2,
      }).sections.focus,
    ).toEqual(['Preparing the launch']);
  });

  it('accepts explicit unavailable analysis without fabricating work', () => {
    expect(
      initialSnapshot([mail('one')], NOW, {
        ...analysis([]),
        status: 'unavailable',
        selected_count: 1,
      }).sections.focus,
    ).toEqual([]);
  });

  it('accepts completed search with no eligible mail and rejects empty partial coverage', () => {
    const empty = analysis([]);
    expect(initialSnapshot([], NOW, empty).sections).toEqual({
      focus: [],
      priorities: [],
      people: [],
      work_pattern: [],
      open_items: 0,
    });
    expect(() => initialSnapshot([], NOW, { ...empty, status: 'partial' })).toThrow(
      'invalid_initial_profile_analysis',
    );
    expect(() =>
      initialSnapshot([], NOW, {
        ...empty,
        focus: [{ text: 'Unsupported claim', source_ids: ['absent'] }],
      }),
    ).toThrow('invalid_initial_profile_analysis');
  });

  it('does not accept calendar-sourced artifacts relabeled as email evidence', () => {
    expect(() =>
      initialSnapshot([{ ...mail('one'), source: 'google_calendar' }], NOW, analysis()),
    ).toThrow('invalid_initial_profile_analysis');
  });

  it('stores normalized bounded findings rather than untrimmed model text', () => {
    expect(
      initialSnapshot([mail('one')], NOW, {
        ...analysis(),
        focus: [{ text: '  Grounded summary  ', source_ids: ['one'] }],
      }).sections.focus,
    ).toEqual(['Grounded summary']);
  });

  it.each(['focus', 'priorities', 'open_items'] as const)(
    'rejects exact duplicate claims within %s after normalizing whitespace and source order',
    (group) => {
      const duplicate = {
        ...analysis(['one', 'two']),
        [group]: [
          { text: '  Send\n the response ', source_ids: ['one', 'two'] },
          { text: 'Send the   response', source_ids: ['two', 'one'] },
        ],
      };
      expect(() => initialSnapshot([mail('one'), mail('two')], NOW, duplicate)).toThrow(
        'invalid_initial_profile_analysis',
      );
    },
  );

  it('keeps separate tasks from one source and does not merge claims across groups', () => {
    const sameSourceTasks = [
      { text: 'Review the schedule', source_ids: ['one'] },
      { text: 'Send the response', source_ids: ['one'] },
    ];
    const snapshot = initialSnapshot([mail('one')], NOW, {
      ...analysis(),
      focus: [sameSourceTasks[0]!],
      priorities: [sameSourceTasks[0]!],
      open_items: sameSourceTasks,
    });
    expect(snapshot.sections.open_items).toBe(2);
    expect(snapshot.sections.focus).toEqual(['Review the schedule']);
    expect(snapshot.sections.priorities).toEqual(['Review the schedule']);
  });

  const invalid: [string, Partial<InitialProfileAnalysis>][] = [
    ['unknown analyzed source', { analyzed_ids: ['absent'] }],
    ['calendar analyzed source', { analyzed_ids: ['calendar'] }],
    [
      'duplicate analyzed source',
      { analyzed_ids: ['one', 'one'], analyzed_count: 2, selected_count: 2 },
    ],
    ['wrong analyzed count', { analyzed_count: 0 }],
    ['selection below analysis', { selected_count: 0 }],
    ['selection above actual mail snapshot', { selected_count: 3, status: 'partial' }],
    ['incomplete complete status', { selected_count: 2 }],
    ['complete partial status', { status: 'partial' }],
    ['unavailable analyzed mail', { status: 'unavailable' }],
    ['unknown exclusion', { excluded_ids: ['absent'] }],
    ['duplicate exclusion', { excluded_ids: ['one', 'one'] }],
    ['unknown claim source', { focus: [{ text: 'Claim', source_ids: ['absent'] }] }],
    ['unanalyzed claim source', { priorities: [{ text: 'Claim', source_ids: ['two'] }] }],
    ['duplicate claim source', { focus: [{ text: 'Claim', source_ids: ['one', 'one'] }] }],
    [
      'excluded claim source',
      { excluded_ids: ['one'], open_items: [{ text: 'Claim', source_ids: ['one'] }] },
    ],
    ['blank claim', { focus: [{ text: '  ', source_ids: ['one'] }] }],
  ];
  it.each(invalid)('rejects %s without exposing data', (_name, change) => {
    expect(() =>
      initialSnapshot([mail('one'), mail('two'), event('calendar', 8)], NOW, {
        ...analysis(),
        ...change,
      }),
    ).toThrow('invalid_initial_profile_analysis');
  });

  it('ranks real reciprocal contacts ahead of frequent outbound contacts and ignores owner', () => {
    const data = [
      mail('one'),
      mail('two', 'outbound'),
      ...Array.from({ length: 5 }, (_, i) =>
        mail(`sent-${i}`, 'outbound', 'another@example.invalid', 'Another'),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        mail(`bulk-${i}`, 'inbound', 'news@example.invalid', 'Newsletter'),
      ),
      mail('self', 'outbound', 'SELF@example.invalid', 'Mailbox owner'),
    ];
    const snapshot = initialSnapshot(data, NOW);
    expect(snapshot.sections.people).toEqual(['Colleague', 'Another']);
    expect(snapshot.profile.frequent_entities.map((item) => item.label)).toEqual([
      'Colleague',
      'Another',
    ]);
  });

  it('excludes automation, body-classified noise and duplicate message counts', () => {
    const data = [
      mail('one'),
      mail('two', 'outbound'),
      mail('auto-in', 'inbound', 'notifications@example.invalid', 'Service'),
      mail('auto-out', 'outbound', 'notifications@example.invalid', 'Service'),
      {
        ...mail('bulk-in', 'inbound', 'human@example.invalid', 'Mailing list'),
        title: 'Weekly newsletter',
      },
      {
        ...mail('bulk-out', 'outbound', 'human@example.invalid', 'Mailing list'),
        title: 'Weekly newsletter',
      },
    ];
    expect(
      initialSnapshot(data, NOW, { ...analysis(['one', 'two']), excluded_ids: ['two'] }).sections
        .people,
    ).toEqual([]);
    expect(
      initialSnapshot([mail('duplicate', 'outbound'), mail('duplicate', 'outbound')], NOW).sections
        .people,
    ).toEqual([]);
  });

  it('does not treat sparse calendars or free time as a work preference', () => {
    expect(initialSnapshot([event('one', 1, 12)], NOW).sections.work_pattern).toEqual([]);
    expect(
      initialSnapshot(
        Array.from({ length: 5 }, (_, i) => event(`same-day-${i}`, 1)),
        NOW,
      ).sections.work_pattern,
    ).toEqual([]);
    expect(
      initialSnapshot([event('one', 1), event('two', 2), event('three', 3), event('four', 4)], NOW)
        .profile.work_patterns,
    ).toEqual([]);
  });

  it('reports only sufficiently supported, past, timed calendar observations', () => {
    const events = [
      event('one', 1),
      event('two', 2),
      event('three', 3),
      event('four', 4),
      event('five', 5),
    ];
    const snapshot = initialSnapshot(
      [
        ...events,
        event('future', 10, 9),
        { ...event('all-day', 6, 0), ends_at: event('next-day', 7, 0).occurred_at },
      ],
      NOW,
    );
    expect(snapshot.sections.work_pattern).toEqual(['過去90日の予定は午後開始が多い（5/5件）']);
    expect(snapshot.profile.work_patterns[0]?.status).toBe('observed');
    expect(JSON.stringify(snapshot)).not.toContain('集中');
    expect(snapshot.profile.work_patterns[0]?.sources).toHaveLength(3);
  });

  it('retains compatibility with older profile responses lacking analysis', () => {
    const old = InitialProfile.parse({
      id: '01991588-0000-7000-8000-000000000001',
      provider: 'google',
      status: 'ready',
      started_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      outcomes: [],
      sections: null,
      profile: null,
    });
    expect(old.analysis).toBeNull();
  });
});
