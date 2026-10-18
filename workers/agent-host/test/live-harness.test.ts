/**
 * WORK_CONTEXT_LIVE_GATE の無人 harness の、live 無しで確かめられる部分。
 *
 *   - harness 用のファイルストアは 0600 で、login keychain を触らない
 *   - fixture は相対の日付で、nonce が件名に入る
 *   - 期待値の判定は機械で読める（通る形 / 通らない形の両方）
 */
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkContext } from '@genie/contracts';
import { FileSecretStore, keychainFor } from '../src/keychain.js';
import type { MeetingBrief } from '@genie/contracts';
import {
  checkBrief,
  checkHome,
  checkReply,
  liveFixture,
  syntheticMeetingArtifacts,
} from '../src/live-fixture.js';

describe('file secret store (harness only)', () => {
  it('round-trips values in a 0600 file and is chosen only when asked for', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astra-secrets-'));
    const file = path.join(dir, 'secrets.json');
    const store = new FileSecretStore(file);
    expect(await store.get('a')).toBeNull();
    await store.set('a', 'v1');
    expect(await store.get('a')).toBe('v1');
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    await store.delete('a');
    expect(await store.get('a')).toBeNull();

    expect(keychainFor('darwin', 'me', { ASTRA_SECRET_STORE_FILE: file })).toBeInstanceOf(
      FileSecretStore,
    );
    expect(keychainFor('darwin', 'me', {})).not.toBeInstanceOf(FileSecretStore);
  });
});

describe('live fixture and expectations', () => {
  const now = new Date('2026-09-07T03:00:00.000Z');
  const f = liveFixture(now, 'WC1234');

  it('tags everything with the nonce and uses relative dates', () => {
    expect(f.project).toBe('ACME-WC1234');
    expect(f.mailA.subject).toContain('WC1234');
    expect(f.mailA.body).toContain('コード WC1234');
    expect(f.mailB.subject).toContain('WC1234');
    expect(f.meeting2.subject).toContain('WC1234');
    expect(new Date(f.deadlineIso).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(f.meeting1.startedAt).getTime()).toBeLessThan(now.getTime());
    expect(new Date(f.meeting2.startIso).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(f.meeting2.startIso).getTime() - now.getTime()).toBeLessThan(24 * 60 * 60_000);
  });

  it('builds meeting 1 outcomes with the same stable ids the real finalize would', () => {
    const arts = syntheticMeetingArtifacts(f, now.toISOString());
    expect(arts.map((a) => a.id)).toEqual([
      'meeting:live-WC1234',
      'meeting:live-WC1234:decision:seg-1',
      'meeting:live-WC1234:action:seg-2',
    ]);
    expect(arts[2]!.due_at).toBe(f.deadlineIso);
    expect(arts[2]!.origin?.speaker).toBe('自分');
    expect(syntheticMeetingArtifacts(f, now.toISOString()).map((a) => a.id)).toEqual(
      arts.map((a) => a.id),
    );
  });

  it('checks Home, reply and the next brief without judgement, naming what is missing', () => {
    const src = {
      source: 'gmail' as const,
      external_id: 'm1',
      label: f.mailA.subject,
      observed_at: now.toISOString(),
      url: null,
      excerpt: f.mailA.body.slice(0, 200),
    };
    const good: WorkContext = {
      generated_at: now.toISOString(),
      inference_enabled: true,
      priorities: [
        {
          id: 'project:x',
          project: f.project,
          title: '見積を返す',
          score: 0.71,
          due_at: f.deadlineIso,
          waiting_on: null,
          lines: ['ACME からの返信待ち'],
          counts: { gmail: 2 },
          factors: [],
          sources: [src],
          confirmed: false,
        },
      ],
      waiting_on: [],
      owed: [],
      week: { meeting_hours: 1, deadlines: 1, unanswered: 2, waiting: 0 },
      sources: { gmail: 2 } as WorkContext['sources'],
    };
    expect(checkHome(good, f, now).every((r) => r.ok)).toBe(true);
    expect(
      checkHome({ ...good, priorities: [] }, f, now)
        .filter((r) => !r.ok)
        .map((r) => r.row),
    ).toEqual(['project nonce found', 'deadline found', 'pressure HIGH', 'provenance']);

    const reply = checkReply(
      {
        target: { subject: f.mailA.subject, thread_id: 't' },
        context: `案件: ${f.project}`,
        draft: 'ありがとうございます',
        sinkHit: true,
      },
      f,
    );
    expect(reply.every((r) => r.ok)).toBe(true);
    const leaked = checkReply(
      {
        target: { subject: f.mailA.subject, thread_id: 't' },
        context: `案件: ${f.project} MOPITA`,
        draft: 'x',
        sinkHit: false,
      },
      f,
    );
    expect(leaked.filter((r) => !r.ok).map((r) => r.row)).toEqual([
      'no other-project context',
      'test sink receives nonce',
    ]);

    const brief: MeetingBrief = {
      event_id: 'ev',
      title: f.meeting2.subject,
      starts_at: f.meeting2.startIso,
      project: f.project,
      previous: [
        { text: `決定: ${f.meeting1.decision}`, sources: [src] },
        { text: `やること: ${f.meeting1.action}`, sources: [src] },
      ],
      since_last_meeting: [{ text: '1 件のメールが届いています', sources: [src] }],
      open_items: [],
      suggested_questions: [{ question: 'q', reason: 'r', sources: [src], extracted_by: 'rule' }],
      provenance: [src],
      generated_at: now.toISOString(),
    };
    expect(checkBrief(brief, f).every((r) => r.ok)).toBe(true);
    expect(checkBrief(null, f)[0]!.ok).toBe(false);
  });
});
