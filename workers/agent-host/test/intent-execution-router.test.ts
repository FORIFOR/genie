import { describe, expect, it, vi } from 'vitest';
import { IntentExecutionRouter } from '../src/intent-execution-router.js';

const step = {
  id: 'intent-1',
  toolId: 'intent.execute',
  args: { goal: '予定を登録して' },
  approval: { approvalId: 'approval-1' } as never,
};

describe('IntentExecutionRouter', () => {
  it('prefers an available structured route and verifies its provider result', async () => {
    const structured = {
      handles: vi.fn((tool: string) => tool === 'calendar.create'),
      run: vi.fn(async () => ({ ok: true, result: { eventId: 'evt-1' } })),
    };
    const computer = { handles: vi.fn(() => true), run: vi.fn() };
    const model = {
      handles: vi.fn(() => true),
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: {
            kind: 'structured',
            toolId: 'calendar.create',
            args: { title: 'Review', start: '2026-09-20T10:00:00+09:00', end: '2026-09-20T11:00:00+09:00' },
          },
        })
        .mockResolvedValueOnce({ ok: true, result: { verified: true, reason: 'eventId returned' } }),
    };
    const router = new IntentExecutionRouter({ structured, computer, model });
    const result = await router.run(step);
    expect(result.ok).toBe(true);
    expect(structured.run).toHaveBeenCalledTimes(1);
    expect(computer.run).not.toHaveBeenCalled();
  });

  it('uses vision only when the router explicitly selects the computer route', async () => {
    const structured = { handles: vi.fn(() => false), run: vi.fn() };
    const computer = {
      handles: vi.fn((tool: string) => tool === 'computer.run'),
      run: vi.fn(async () => ({ ok: true, result: { completed: true } })),
    };
    const model = {
      handles: vi.fn(() => true),
      run: vi.fn(async () => ({
        ok: true,
        result: { kind: 'computer', successCriteria: '設定画面が表示されている' },
      })),
    };
    const router = new IntentExecutionRouter({ structured, computer, model });
    const result = await router.run({ ...step, args: { goal: 'アプリの設定画面を開いて' } });
    expect(result.ok).toBe(true);
    expect(computer.run).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'computer.run',
        args: expect.objectContaining({ successCriteria: '設定画面が表示されている' }),
      }),
      undefined,
    );
  });

  it('never silently falls back to pixels when a selected API route is unavailable', async () => {
    const structured = { handles: vi.fn(() => false), run: vi.fn() };
    const computer = { handles: vi.fn(() => true), run: vi.fn() };
    const model = {
      handles: vi.fn(() => true),
      run: vi.fn(async () => ({
        ok: true,
        result: { kind: 'structured', toolId: 'mail.send', args: {} },
      })),
    };
    const router = new IntentExecutionRouter({ structured, computer, model });
    const result = await router.run(step);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('intent.structured_unavailable');
    expect(computer.run).not.toHaveBeenCalled();
  });
});
