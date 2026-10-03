import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeVisionDevice } from './computer-vision-device.js';
import type { SimulationCheckout } from './simulation-orders.js';

const exec = promisify(execFile);
export const SIMULATION_BUNDLE = 'org.genie.checkout.simulation';

type Device = Pick<NativeVisionDevice, 'claim' | 'begin' | 'apply' | 'close'>;
interface Dependencies {
  readonly platform?: string;
  readonly status?: (helper: string) => Promise<unknown>;
  readonly launch?: (executable: string, args: string[]) => ChildProcess;
  readonly device?: (helper: string) => Device;
  readonly idleMs?: number;
}
interface Session {
  readonly child: ChildProcess;
  readonly id: string;
  windowId?: number;
  error?: Error;
  idle?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}
const IDLE_MS = 300_000;

/** One owned process/window per host instance; normal native consent remains authoritative. */
export function nativeSimulationConfirmation(
  config: { helper: string; executable: string },
  dependencies: Dependencies = {},
) {
  if (!isAbsolute(config.helper) || !isAbsolute(config.executable))
    throw new Error('simulation_absolute_executables_required');
  let session: Session | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const alive = (s: Session) =>
    !s.error && !s.closing && s.child.exitCode === null && s.child.signalCode === null;
  const stop = (s: Session): Promise<void> => {
    if (s.closing) return s.closing;
    if (session === s) session = undefined;
    if (s.idle) clearTimeout(s.idle);
    s.closing = new Promise<void>((resolve) => {
      if (s.child.exitCode !== null || s.child.signalCode !== null || !s.child.pid) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        s.child.kill('SIGKILL');
        resolve();
      }, 2000);
      s.child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      s.child.stdin?.end();
      s.child.kill('SIGTERM');
    });
    return s.closing;
  };
  const send = (s: Session, message: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!alive(s) || !s.child.stdin?.writable) {
        reject(s.error ?? new Error('simulation_window_exited'));
        return;
      }
      s.child.stdin.write(JSON.stringify(message) + '\n', (error) =>
        error ? reject(error) : resolve(),
      );
    });
  const acquire = (): Session => {
    if (session && alive(session)) {
      if (session.idle) clearTimeout(session.idle);
      return session;
    }
    const id = randomUUID();
    const args = ['--session', id];
    const child = dependencies.launch
      ? dependencies.launch(config.executable, args)
      : spawn(config.executable, args, {
          stdio: ['pipe', 'ignore', 'pipe'],
          env: { HOME: process.env['HOME'] ?? '', PATH: '/usr/bin:/bin', LANG: 'ja_JP.UTF-8' },
        });
    const created: Session = { child, id };
    session = created;
    child.on('error', (error) => {
      created.error = error;
    });
    child.stdin?.on('error', (error) => {
      created.error = error;
    });
    child.stderr?.resume();
    // EOF also terminates the fixture if the host crashes; this handler covers orderly host exit.
    const onExit = () => {
      if (alive(created)) child.kill('SIGTERM');
    };
    process.once('exit', onExit);
    child.once('exit', () => {
      process.removeListener('exit', onExit);
      if (created.idle) clearTimeout(created.idle);
      if (session === created) session = undefined;
    });
    return created;
  };
  const execute = async (checkout: SimulationCheckout, signal: AbortSignal): Promise<void> => {
    if ((dependencies.platform ?? process.platform) !== 'darwin')
      throw new Error('simulation_native_macos_required');
    signal.throwIfAborted();
    if (!isAbsolute(checkout.directory) || !/^[a-f0-9]{64}$/.test(checkout.quoteHash))
      throw new Error('simulation_invalid_checkout');
    const status = (
      dependencies.status
        ? await dependencies.status(config.helper)
        : JSON.parse((await exec(config.helper, ['--status'], { timeout: 10_000, signal })).stdout)
    ) as { deliveryMode?: string; unattendedTest?: boolean; ready?: boolean };
    if (status.deliveryMode !== 'background' || status.unattendedTest !== false || !status.ready)
      throw new Error('simulation_production_helper_required');
    signal.throwIfAborted();
    const current = acquire();
    const commandId = randomUUID();
    const device = dependencies.device?.(config.helper) ?? new NativeVisionDevice(config.helper);
    const readyPath = join(checkout.directory, 'window.json');
    const abort = () => {
      void stop(current);
    };
    signal.addEventListener('abort', abort, { once: true });
    let succeeded = false;
    try {
      signal.throwIfAborted();
      await send(current, {
        op: 'load',
        sessionId: current.id,
        commandId,
        path: join(checkout.directory, 'checkout.json'),
      });
      let ready = false;
      for (let i = 0; i < 100; i++) {
        signal.throwIfAborted();
        if (!alive(current)) throw current.error ?? new Error('simulation_window_exited');
        try {
          const window = JSON.parse(await readFile(readyPath, 'utf8'));
          if (
            window.sessionId === current.id &&
            window.commandId === commandId &&
            window.pid === current.child.pid &&
            window.quoteHash === checkout.quoteHash &&
            window.ready === true &&
            window.visible === true &&
            Number.isSafeInteger(window.windowId) &&
            window.windowId > 0
          ) {
            if (current.windowId !== undefined && window.windowId !== current.windowId)
              throw new Error('simulation_window_changed');
            current.windowId = window.windowId;
            ready = true;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
            throw error;
        }
        await delay(100, undefined, { signal });
      }
      if (!ready) throw new Error('simulation_window_unavailable');
      await device.claim(`simulation-confirm:${checkout.quoteHash}`);
      const frame = await device.begin(
        'Genie 模擬注文 — このテスト画面だけを選択してください。実際の購入・課金はありません。',
        'local',
        signal,
        { pid: current.child.pid!, bundleId: SIMULATION_BUNDLE },
      );
      if (
        frame.pid !== current.child.pid ||
        frame.windowId !== current.windowId ||
        frame.bundleId !== SIMULATION_BUNDLE ||
        frame.deliveryMode !== 'background'
      )
        throw new Error('simulation_wrong_target');
      const title = `模擬注文を確定 ${checkout.quoteHash.slice(0, 12)}`;
      const matches =
        frame.elements?.filter((item) => item.role === 'AXButton' && item.name === title) ?? [];
      if (matches.length !== 1) throw new Error('simulation_confirm_target_missing');
      signal.throwIfAborted();
      if (Date.now() >= checkout.authorizationExpiresAt)
        throw new Error('simulation_authorization_expired');
      // The target is an owned simulator, its button is bound to an immutable quote,
      // and the outer transaction runtime verified the exact approval. This is a
      // local draft mutation, never a general exemption for real payment controls.
      await device.apply(
        frame,
        {
          action: 'click',
          frameId: frame.id,
          elementId: matches[0]!.id,
          expectation: '模擬注文の受付番号が表示される',
          confidence: 1,
          risk: 'draft',
        },
        signal,
        checkout.authorizationExpiresAt,
      );
      // AX acceptance can precede the target's event handler. Keep the owned app
      // alive until its atomically persisted receipt exists; do not click twice.
      let persisted = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        signal.throwIfAborted();
        try {
          const receipt = JSON.parse(
            await readFile(join(checkout.directory, 'receipt.json'), 'utf8'),
          );
          if (
            receipt.quoteHash !== checkout.quoteHash ||
            receipt.providerOrderId !== checkout.candidate.providerOrderId
          )
            throw new Error('simulation_receipt_mismatch');
          persisted = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await delay(100, undefined, { signal });
      }
      if (!persisted) throw new Error('simulation_result_unknown');
      // Keep the same target alive for the next explicitly authorized order.
      succeeded = true;
    } finally {
      try {
        await device.close();
        if (succeeded && !signal.aborted && alive(current)) {
          await send(current, { op: 'idle', sessionId: current.id, commandId });
          current.idle = setTimeout(() => {
            void stop(current);
          }, dependencies.idleMs ?? IDLE_MS);
          current.idle.unref();
        } else await stop(current);
      } catch (error) {
        await stop(current);
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
  };
  return (checkout: SimulationCheckout, signal: AbortSignal): Promise<void> => {
    // Serial ownership prevents one order from replacing another order's button.
    // A queued cancellation rejects promptly and never stops the active order.
    const job = tail.then(() => {
      signal.throwIfAborted();
      return execute(checkout, signal);
    });
    tail = job.catch(() => undefined);
    return new Promise((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener('abort', aborted);
        reject(signal.reason);
      };
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener('abort', aborted, { once: true });
      job.then(
        () => {
          signal.removeEventListener('abort', aborted);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
    });
  };
}
