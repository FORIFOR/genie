import { describe, expect, it, vi } from 'vitest';
import { ComputerPlannerRuntime } from '../src/computer-planner.js';

const observation = {
  app: 'Safari',
  bundleId: 'com.apple.Safari',
  window: 'Example',
  focusedRole: 'AXButton',
  mouseX: 10,
  mouseY: 20,
  screens: 1,
  accessibilityTrusted: true,
};

describe('ComputerPlannerRuntime', () => {
  it('observes, acts, re-plans, then completes', async () => {
    const computer = {
      handles: vi.fn(() => true),
      run: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: observation })
        .mockResolvedValueOnce({ ok: true, result: { changed: true } })
        .mockResolvedValueOnce({ ok: true, result: { ...observation, window: 'Done' } }),
    };
    const model = {
      handles: vi.fn(() => true),
      run: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: { action: 'click', x: 100, y: 200, expectChange: true },
        })
        .mockResolvedValueOnce({ ok: true, result: { action: 'done', reason: '完了を確認' } }),
    };
    const runtime = new ComputerPlannerRuntime({ computer, model, maxActions: 4 });
    const result = await runtime.run({
      id: 'run-1',
      toolId: 'computer.run',
      args: { goal: '設定を開く' },
      approval: { approvalId: 'a' } as never,
    });

    expect(result.ok).toBe(true);
    expect(computer.run).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'computer.click',
        args: expect.objectContaining({ x: 100, y: 200 }),
      }),
      undefined,
    );
    expect(model.run).toHaveBeenCalledTimes(2);
  });

  it('re-plans once after verification failure', async () => {
    const computer = {
      handles: vi.fn(() => true),
      run: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: observation })
        .mockResolvedValueOnce({
          ok: false,
          error: { code: 'computer.verification_failed', message: 'no change' },
        })
        .mockResolvedValueOnce({ ok: true, result: observation }),
    };
    const model = {
      handles: vi.fn(() => true),
      run: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: { action: 'click', x: 10, y: 20 } })
        .mockResolvedValueOnce({ ok: true, result: { action: 'stop', reason: '別の方法が必要' } }),
    };
    const runtime = new ComputerPlannerRuntime({ computer, model, maxActions: 3 });
    const result = await runtime.run({
      id: 'run-2',
      toolId: 'computer.run',
      args: { goal: '対象を開く' },
      approval: { approvalId: 'a' } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('computer.planner_stopped');
    expect(model.run).toHaveBeenCalledTimes(2);
  });

  it('stops at the action limit', async () => {
    const computer = {
      handles: vi.fn(() => true),
      run: vi.fn(async (step: { toolId: string }) =>
        step.toolId === 'computer.observe'
          ? { ok: true, result: observation }
          : { ok: true, result: { changed: true } },
      ),
    };
    const model = {
      handles: vi.fn(() => true),
      run: vi.fn(async () => ({ ok: true, result: { action: 'click', x: 10, y: 20 } })),
    };
    const runtime = new ComputerPlannerRuntime({ computer, model, maxActions: 2 });
    const result = await runtime.run({
      id: 'run-3',
      toolId: 'computer.run',
      args: { goal: '終わらない作業' },
      approval: { approvalId: 'a' } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('computer.action_limit');
  });
});
