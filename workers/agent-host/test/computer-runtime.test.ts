import { describe, expect, it, vi } from 'vitest';
import { ComputerRuntime } from '../src/computer-runtime.js';

const step = (
  toolId: string,
  args: Record<string, unknown> = {},
  approval: object | null = {},
) => ({
  id: 'step-1',
  toolId,
  args,
  approval: approval as never,
});

describe('ComputerRuntime', () => {
  it('is disabled by default', () => {
    expect(new ComputerRuntime().handles('computer.click')).toBe(false);
  });

  it('requires approval before mutating the computer', async () => {
    const run = vi.fn();
    const runtime = new ComputerRuntime({ enabled: true, run });
    const result = await runtime.run(step('computer.click', { x: 10, y: 20 }, null));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('approval.required');
    expect(run).not.toHaveBeenCalled();
  });

  it('validates and forwards an approved click', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const runtime = new ComputerRuntime({
      enabled: true,
      command: '/tmp/uxin',
      run,
    });
    const result = await runtime.run(step('computer.click', { x: 10.4, y: 20.6 }));
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith('/tmp/uxin', ['click', '10', '21'], 10_000);
  });

  it('rejects unknown key modifiers', async () => {
    const run = vi.fn();
    const runtime = new ComputerRuntime({ enabled: true, run });
    const result = await runtime.run(
      step('computer.key', { keycode: 36, modifiers: ['ctrl'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('computer.invalid_action');
    expect(run).not.toHaveBeenCalled();
  });
});
