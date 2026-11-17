import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  EventEnvelope,
  PHASE0_EVENT_TYPES,
  decodeEvent,
  isContiguous,
  toSseFrame,
} from '../src/events.js';
import { uuidv7 } from '../src/uuid.js';

const base = (type: string, payload: unknown, sequence = 1) => ({
  event_id: uuidv7(),
  type,
  timestamp: new Date().toISOString(),
  tenant_id: uuidv7(),
  stream_kind: 'task',
  stream_id: uuidv7(),
  sequence,
  payload,
});

describe('event envelope', () => {
  it('parses a task.progress event', () => {
    const raw = base('task.progress', {
      phase: 'thinking',
      step_index: 0,
      step_count: 3,
      message: '調べています',
    });
    const parsed = EventEnvelope.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it('carries the detail an unbounded task needs to feel alive', () => {
    // UI/UX §6.1「12 sources」/ §6.2「段数が決まらない処理は %を出さない」
    const raw = base('task.progress', {
      phase: 'researching',
      step_index: 1,
      step_count: null,
      message: '公式資料と最新ニュースを照合中',
      detail: '12 sources',
      elapsed_ms: 8400,
      retrying: false,
    });
    const parsed = EventEnvelope.parse(raw);
    expect(parsed.type).toBe('task.progress');
    if (parsed.type === 'task.progress') {
      expect(parsed.payload.detail).toBe('12 sources');
      expect(parsed.payload.step_count).toBeNull();
    }
  });

  it('defaults the optional progress fields so old emitters keep working', () => {
    const parsed = EventEnvelope.parse(
      base('task.progress', { phase: 'thinking', step_index: 0, step_count: 1, message: 'x' }),
    );
    if (parsed.type === 'task.progress') {
      expect(parsed.payload.detail).toBeNull();
      expect(parsed.payload.retrying).toBe(false);
    }
  });

  it('gives the approval event the label the primary button needs', () => {
    const raw = base('task.waiting_approval', {
      approval_id: uuidv7(),
      risk: 'EXTERNAL_COMMIT',
      summary: '3人にメールを送信します',
      primary_action_label: '3件送信する',
      expires_at: new Date().toISOString(),
    });
    expect(EventEnvelope.safeParse(raw).success).toBe(true);
  });

  it('discriminates payloads by type', () => {
    // task.completed の payload を task.progress に付けたら落ちる
    const bad = base('task.progress', { result_artifact_id: null, duration_ms: 1 });
    expect(EventEnvelope.safeParse(bad).success).toBe(false);
  });

  it('requires a positive sequence', () => {
    const bad = base('task.cancelled', { reason: 'x' }, 0);
    expect(EventEnvelope.safeParse(bad).success).toBe(false);
  });

  it('carries the stream identity needed for resume (deviation D-03)', () => {
    const raw = base('task.cancelled', { reason: 'user_requested' });
    const parsed = EventEnvelope.parse(raw);
    expect(parsed.stream_kind).toBe('task');
    expect(parsed.stream_id).toBeTruthy();
    expect(parsed.tenant_id).toBeTruthy();
  });

  it('declares task.cancelled (deviation D-03b)', () => {
    expect(EVENT_TYPES).toContain('task.cancelled');
  });

  it('keeps unconfirmed order evidence through cancellation SSE encoding and decoding', () => {
    const transaction_result = {
      mode: 'simulation',
      provider: 'fixture',
      account: 'fixture-account',
      orderKey: 'order-1',
      quoteHash: 'a'.repeat(64),
      status: 'unknown',
    };
    const payload = {
      reason: 'user_requested',
      message: 'Genie stopped; order outcome unconfirmed.',
      error: {
        code: 'task.step_failed',
        message: 'Unknown',
        step_index: 1,
        retryable: false,
        transaction_result,
      },
    };
    const parsed = EventEnvelope.parse(base('task.cancelled', payload));
    const frame = toSseFrame(parsed);
    const data = frame
      .split('\n')
      .find((line) => line.startsWith('data: '))!
      .slice(6);
    expect(decodeEvent(JSON.parse(data)).event.payload).toMatchObject(payload);
    expect(
      EventEnvelope.parse(base('task.cancelled', { reason: 'ordinary stop' })).payload,
    ).toEqual({ reason: 'ordinary stop' });
  });

  it('marks exactly the Phase 0 emitters', () => {
    for (const t of PHASE0_EVENT_TYPES) expect(EVENT_TYPES).toContain(t);
    expect(PHASE0_EVENT_TYPES).not.toContain('conversation.delta');
  });

  it('defines every future event type as receivable now', () => {
    for (const t of ['meeting.transcript.final', 'research.evidence_added', 'conversation.delta']) {
      expect(EVENT_TYPES).toContain(t);
    }
  });
});

describe('unknown events', () => {
  it('keeps the sequence instead of dropping the event', () => {
    const raw = base('future.thing.v9', { anything: true }, 42);
    const decoded = decodeEvent(raw);
    expect(decoded.known).toBe(false);
    expect(decoded.event.sequence).toBe(42);
  });

  it('still rejects a structurally broken envelope', () => {
    expect(() => decodeEvent({ type: 'nope' })).toThrow();
  });
});

describe('sse framing', () => {
  it('puts the sequence in the id field', () => {
    const parsed = EventEnvelope.parse(base('task.cancelled', { reason: 'x' }, 7));
    const frame = toSseFrame(parsed);
    expect(frame.startsWith('id: 7\nevent: task.cancelled\ndata: {')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('detects gaps', () => {
    expect(isContiguous(5, 5)).toBe(true);
    expect(isContiguous(5, 6)).toBe(false);
    expect(isContiguous(5, 4)).toBe(false);
  });
});
