/**
 * `surface: 'local'` の step を、手元の端末へ回す。正本 §4.4・§16.1。
 *
 * cloud の worker から見ると、これは普通の executor に見える。
 * 中でやっているのは「置いて、待つ」だけで、**実行は端末**。
 *
 * 待ち方に気をつける点が 2 つある:
 *
 *   - **端末が居ないうちは置かない。**先に置くと、何時間も後に
 *     端末が戻ってきた瞬間、誰も待っていない送信が走る
 *   - **待ちきれなくても失敗にしない。**`HostOffline` として投げ、
 *     workflow 側で `PAUSED_HOST_OFFLINE` に落とす（§4.4）
 */
import { HostOfflineError, isHostOfflineError } from '@genie/contracts';
import type { ApprovalProof, HostBridge, HostStepRequest } from './bridge.js';

/**
 * 端末が居ない / 戻らない。**失敗ではない。待てば進む。**
 *
 * 型そのものは契約側にある。cloud の worker と workflow が
 * 同じものを見分けられないと、端末が落ちただけの仕事が FAILED になる。
 */
export { HostOfflineError as HostOffline } from '@genie/contracts';

/** 端末が「できなかった」と答えた。**これは失敗。** */
export class HostStepFailed extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    readonly result?: unknown,
  ) {
    super(message);
    this.name = 'HostStepFailed';
    this.code = code;
  }
}

/**
 * 仕事が止められ、端末はまだ取っていなかった。**何も走っていない。**
 *
 * 失敗とも端末の不在とも混ぜない。失敗にすると止めた仕事が FAILED で残り、
 * 不在にすると戻るのを待ち始める。
 */
export class HostStepCancelled extends Error {
  static readonly TYPE = 'HostStepCancelled';
  constructor() {
    super('停止したため、端末へ渡す前に取り下げました。');
    this.name = 'HostStepCancelled';
  }
}

interface TaskLike {
  readonly taskId: string;
  readonly tenantId: string;
  readonly userId: string;
}

interface StepLike {
  readonly index: number;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  /** 同じ step で何度も頼むときの区別。connector は使わない。 */
  readonly requestKey?: string;
}

export interface HostStepExecutorDeps {
  readonly bridge: HostBridge;
  /**
   * その step の承認の跡を引く。
   *
   * **端末にも確かめさせるため**に持たせる。承認を取る経路が
   * cloud の 1 本だけだと、いつか誰かが端末側に近道を作る。
   * 引けなければ null で、端末は承認の要る操作を実行しない。
   */
  readonly approvalFor?: (input: {
    tenantId: string;
    taskId: string;
    stepIndex: number;
    /**
     * どの操作への承認か。
     *
     * `approvals` は tool 名を持たない（契約が持たせていない — §9.3）。
     * だから**呼ぶ側が step から渡す。**渡さずに承認だけ引くと、
     * 別の step の承認で送信できてしまう。
     */
    toolId: string;
    args: Record<string, unknown>;
  }) => Promise<ApprovalProof | null>;
  /** 端末の返事を待つ上限。 */
  readonly waitMs?: number;
  /** 見に行く間隔。 */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 進んでいることを伝える先。Temporal の heartbeat を渡す。 */
  readonly onWaiting?: (elapsedMs: number) => void;
}

const DEFAULT_WAIT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 1_000;

export class HostStepExecutor {
  readonly #deps: HostStepExecutorDeps;

  constructor(deps: HostStepExecutorDeps) {
    this.#deps = deps;
  }

  async execute(
    input: TaskLike,
    step: StepLike,
  ): Promise<{ result: unknown; detail?: string | null }> {
    const { bridge } = this.#deps;

    if (!(await bridge.hasOnlineHost(input.tenantId, input.userId))) {
      throw new HostOfflineError('この操作は端末で行います。端末が応答していません。');
    }

    const approval =
      (await this.#deps.approvalFor?.({
        tenantId: input.tenantId,
        taskId: input.taskId,
        stepIndex: step.index,
        toolId: step.toolId,
        args: step.args,
      })) ?? null;

    const request = await bridge.request({
      tenantId: input.tenantId,
      taskId: input.taskId,
      stepIndex: step.index,
      toolId: step.toolId,
      args: step.args,
      approval,
      ...(step.requestKey === undefined ? {} : { requestKey: step.requestKey }),
    });

    const settled = await this.#waitFor(input, request);

    if (settled.status === 'FAILED') {
      const error = settled.error ?? {
        code: 'host.step_failed',
        message: '端末で実行できませんでした。',
      };
      throw new HostStepFailed(error.code, error.message, settled.result);
    }
    // §6.1: どの tool で動いたかは出さない。どこで動いたかだけ言う。
    return { result: settled.result, detail: '端末で実行しました' };
  }

  async #waitFor(input: TaskLike, request: HostStepRequest): Promise<HostStepRequest> {
    const waitMs = this.#deps.waitMs ?? DEFAULT_WAIT_MS;
    const pollMs = this.#deps.pollMs ?? DEFAULT_POLL_MS;
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    for (let elapsed = 0; elapsed < waitMs; elapsed += pollMs) {
      const current = await this.#deps.bridge.get(input.tenantId, request.id);
      if (!current) {
        // 期限切れで消えた。端末が取りに来なかっただけ。
        throw new HostOfflineError('端末がこの操作を受け取りませんでした。');
      }
      if (current.status === 'DONE' || current.status === 'FAILED') return current;
      // 止められた仕事の依頼は、もう誰も取りに来ない。上限まで待たない。
      if (
        current.status === 'PENDING' &&
        (await this.#deps.bridge.withdrawUnclaimed(input.tenantId, request.id))
      ) {
        throw new HostStepCancelled();
      }

      this.#deps.onWaiting?.(elapsed);
      await sleep(pollMs);
    }

    /*
     * 待ちきれなかった。**取り消さない。**
     *
     * 端末は既に走らせているかもしれない。ここで消すと、
     * 送信済みのメールを「送っていない」ことにして、
     * 待ち直したときに二度送る。
     */
    throw new HostOfflineError('端末からの応答を待ちきれませんでした。');
  }
}

/**
 * Temporal の失敗種別へ写すための判定。
 *
 * **失敗と混ぜない。**`HostOffline` だけを「待てば進む」と見る。
 * 受け渡しの競合（`common.conflict`）は別の話で、
 * ここに混ぜると、二重実行の兆候が「端末が居ない」に化ける。
 */
export function isHostOffline(error: unknown): boolean {
  return isHostOfflineError(error);
}
