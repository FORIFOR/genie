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

  it('validates, executes and re-observes an approved click', async () => {
    const observations = [
      JSON.stringify({
        app: 'Safari',
        bundleId: 'com.apple.Safari',
        window: 'Before',
        focusedRole: 'AXButton',
        mouseX: 1,
        mouseY: 2,
        screens: 1,
        accessibilityTrusted: true,
      }),
      JSON.stringify({
        app: 'Safari',
        bundleId: 'com.apple.Safari',
        window: 'After',
        focusedRole: 'AXButton',
        mouseX: 10,
        mouseY: 21,
        screens: 1,
        accessibilityTrusted: true,
      }),
    ];
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({
      code: 0,
      stdout: args[0] === 'observe' ? observations.shift() ?? '{}' : '',
      stderr: '',
    }));
    const runtime = new ComputerRuntime({
      enabled: true,
      command: '/tmp/uxin',
      run,
    });
    const result = await runtime.run(step('computer.click', { x: 10.4, y: 20.6 }));
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenNthCalledWith(1, '/tmp/uxin', ['observe'], 10_000);
    expect(run).toHaveBeenNthCalledWith(2, '/tmp/uxin', ['click', '10', '21'], 10_000);
    expect(run).toHaveBeenNthCalledWith(3, '/tmp/uxin', ['observe'], 10_000);
    expect(result.result).toMatchObject({ changed: true });
  });

  it('fails verification when an expected UI change is not observed', async () => {
    const observation = JSON.stringify({
      app: 'Safari',
      bundleId: 'com.apple.Safari',
      window: 'Same',
      focusedRole: 'AXButton',
      mouseX: 10,
      mouseY: 20,
      screens: 1,
      accessibilityTrusted: true,
    });
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({
      code: 0,
      stdout: args[0] === 'observe' ? observation : '',
      stderr: '',
    }));
    const runtime = new ComputerRuntime({ enabled: true, run });
    const result = await runtime.run(step('computer.click', { x: 10, y: 20, expectChange: true }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('computer.verification_failed');
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
