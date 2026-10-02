import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHECKOUT_SERVICES, CheckoutOpenArgs, type CheckoutHandoffResult } from '@genie/contracts';
import type { HostStep, StepOutcome } from './connector-steps.js';

const exec = promisify(execFile);
export interface CheckoutOpener {
  request(service: keyof typeof CHECKOUT_SERVICES, signal?: AbortSignal): Promise<void>;
}

/** macOS open -g does not request foreground activation. Exit zero proves only OS acceptance. */
export function nativeCheckoutOpener(
  platform: string = process.platform,
  run: typeof exec = exec,
): CheckoutOpener {
  return {
    async request(service, signal) {
      if (platform !== 'darwin') throw new Error('unsupported_platform');
      const args = CheckoutOpenArgs.parse({ service });
      signal?.throwIfAborted();
      await run('/usr/bin/open', ['-g', '-u', CHECKOUT_SERVICES[args.service].url], {
        ...(signal ? { signal } : {}),
        timeout: 10_000,
        maxBuffer: 4096,
      });
    },
  };
}

/** Public navigation only; never delegates to computer.run or TransactionRuntime. */
export class CheckoutAssistanceRuntime {
  constructor(readonly opener: CheckoutOpener = nativeCheckoutOpener()) {}
  handles(toolId: string): boolean {
    return toolId === 'checkout.open';
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    const parsed = CheckoutOpenArgs.safeParse(step.args);
    if (!this.handles(step.toolId) || !parsed.success)
      return {
        ok: false,
        error: {
          code: 'checkout.invalid_args',
          message: 'この注文先の引き継ぎには対応していません。注文は送っていません。',
        },
      };
    const result: CheckoutHandoffResult = {
      service: parsed.data.service,
      capability: 'official_site_handoff',
      navigation: 'request_unconfirmed',
      prepared: false,
      orderStatus: 'not_submitted',
      authentication: 'not_checked',
      cart: 'not_checked',
      receipt: 'not_checked',
      automatedCheckout: 'unsupported',
    };
    try {
      signal?.throwIfAborted();
      await this.opener.request(parsed.data.service, signal);
      signal?.throwIfAborted();
      return { ok: true, result: { ...result, navigation: 'requested' } };
    } catch {
      return {
        ok: false,
        result,
        error: {
          code: 'checkout.open_unconfirmed',
          message:
            '公式サイトを開く依頼を確認できませんでした。注文は送っていません。ブラウザで公式サイトを開いてください。',
        },
      };
    }
  }
}
