import { describe, expect, it } from 'vitest';
import {
  EXECUTION_ROUTES,
  ExecutionRoute,
  LedgerConstraint,
  LedgerEvidence,
  LedgerSubtask,
  SUBTASK_STATUSES,
  SubtaskStatus,
  TaskLedger,
  VERIFICATION_TYPES,
  VerificationCriteria,
  VerificationType,
} from '../src/task-ledger.js';
import { uuidv7 } from '../src/uuid.js';

describe('TaskLedger contract', () => {
  it('defines 5 execution routes ordered by preference (fast/structured to fallback vision)', () => {
    expect(EXECUTION_ROUTES).toEqual([
      'tier1_api_mcp',
      'tier2_web_dom',
      'tier3_cli_fs',
      'tier4_macos_ax',
      'tier5_vision',
    ]);
    for (const r of EXECUTION_ROUTES) {
      expect(ExecutionRoute.parse(r)).toBe(r);
    }
  });

  it('validates subtask statuses and verification types', () => {
    for (const s of SUBTASK_STATUSES) {
      expect(SubtaskStatus.parse(s)).toBe(s);
    }
    for (const v of VERIFICATION_TYPES) {
      expect(VerificationType.parse(v)).toBe(v);
    }
  });

  it('parses LedgerConstraint with defaults', () => {
    const c = LedgerConstraint.parse({
      key: 'invitee',
      value: 'Tanaka',
    });
    expect(c.required).toBe(true);
    expect(c.key).toBe('invitee');
    expect(c.value).toBe('Tanaka');
  });

  it('parses LedgerEvidence correctly', () => {
    const ev = LedgerEvidence.parse({
      id: 'ev-1',
      type: 'url',
      uri: 'https://x.com/search?q=AI',
      description: 'Twitter search result page',
      captured_at: new Date().toISOString(),
    });
    expect(ev.type).toBe('url');
  });

  it('parses LedgerSubtask with default pending status and macOS AX route', () => {
    const subtask = LedgerSubtask.parse({
      id: 'sub-1',
      title: 'Open Calendar app and check Friday availability',
    });
    expect(subtask.status).toBe('pending');
    expect(subtask.route).toBe('tier4_macos_ax');
    expect(subtask.evidence_refs).toEqual([]);
    expect(subtask.started_at).toBeNull();
    expect(subtask.completed_at).toBeNull();
  });

  it('parses VerificationCriteria', () => {
    const crit = VerificationCriteria.parse({
      id: 'crit-1',
      type: 'file_exists',
      target: { path: '/tmp/report.pdf', min_bytes: 100 },
    });
    expect(crit.satisfied).toBe(false);
    expect(crit.evidence_ref).toBeNull();
  });

  it('validates full TaskLedger schema and rejects invalid task ids', () => {
    const taskId = uuidv7();
    const ledger = TaskLedger.parse({
      task_id: taskId,
      goal: '田中さんとの金曜15時のミーティングをカレンダーに入れて確認メールを下書きする',
      current_state: 'Calendar event checked',
      constraints: [
        { key: 'day', value: 'Friday' },
        { key: 'time', value: '15:00' },
      ],
      subtasks: [
        {
          id: 'step-1',
          title: 'カレンダー確認',
          status: 'completed',
          route: 'tier4_macos_ax',
        },
        {
          id: 'step-2',
          title: '予定作成',
          status: 'running',
          route: 'tier1_api_mcp',
        },
      ],
      evidence: [
        {
          id: 'ev-1',
          type: 'text',
          uri: 'internal://calendar/slot-1500',
          description: 'Friday 15:00 is available',
          captured_at: new Date().toISOString(),
        },
      ],
      criteria: [
        {
          id: 'crit-1',
          type: 'ax_element_state',
          target: { app: 'Calendar', event_title: '田中さんミーティング' },
        },
      ],
      is_verified: false,
      updated_at: new Date().toISOString(),
    });

    expect(ledger.task_id).toBe(taskId);
    expect(ledger.subtasks).toHaveLength(2);
    expect(ledger.constraints).toHaveLength(2);
    expect(ledger.is_verified).toBe(false);

    // Reject non-UUID
    expect(() =>
      TaskLedger.parse({
        ...ledger,
        task_id: 'invalid-id',
      }),
    ).toThrow();
  });
});
