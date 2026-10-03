import { createHash } from 'node:crypto';
import {
  VisionFailure,
  assertScope,
  decisionOf,
  frameOf,
  requireApproval,
  verdictOf,
  splitCriteria,
  targetPreviewOf,
  scrollReadbackOf,
  type ScrollReadback,
  type Verdict,
  type VisionFrame,
  type GroundedAction,
  type TargetPreview,
} from './computer-vision-policy.js';

// Structural types keep the loop independent of providers, native UI, and the cloud.
export interface VisionStep {
  id: string;
  toolId: string;
  args: Record<string, unknown>;
  approval: unknown;
}
export interface VisionOutcome {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
export interface VisionModel {
  run(
    step: Omit<VisionStep, 'approval'> & { approval: null },
    signal?: AbortSignal,
  ): Promise<VisionOutcome>;
}
export interface VisionDevice {
  /** Must atomically refuse a previously started request, including after a host restart. */
  claim(requestId: string): Promise<void>;
  /**
   * 止まった理由を、その依頼の記録の隣に残す。任意。
   * 失敗した走行では監査が呼び出し側に返らないので、**どこで止まったのかが残らなかった。**
   * 残すのは符号と監査行（操作の種類・画像の指紋）だけで、画面も入力文字も持たない。
   */
  stopped?(requestId: string, code: string, audit: unknown[]): Promise<void>;
  /** Local consent precedes capture/egress. The selected window becomes the immutable scope. */
  begin(goal: string, recipient: string, signal: AbortSignal): Promise<VisionFrame>;
  capture(scope: VisionFrame, signal: AbortSignal): Promise<VisionFrame>;
  /*
   * 人が割り込んだあと、**AI 側だけ**を再開してよいかを訊く。人には何もしない。
   * 人の手が止まっていなければ `human_active` を投げ、呼び出し側は待つ。
   * 再開できたときは実行世代が 1 つ進んでいて、それ以前の写真と、その上で
   * 決まったまま配送していない操作は、helper 側で失効している。
   * 実装しない装置では、割り込みはこれまでどおりその場で停止になる。
   */
  resume?(scope: VisionFrame, signal: AbortSignal): Promise<void>;
  /** Read-only native grounding. Required before any text write; never focuses or dispatches input. */
  previewTarget?(
    frame: VisionFrame,
    action: GroundedAction,
    signal: AbortSignal,
    expiresAt: number,
  ): Promise<TargetPreview>;
  /** Freshness, window and local per-action approval are rechecked natively before input. */
  apply(
    frame: VisionFrame,
    action: GroundedAction,
    signal: AbortSignal,
    expiresAt: number,
  ): Promise<{ route?: string; effect?: string; scroll?: ScrollReadback } | void>;
  close(): Promise<void>;
}
export interface VisionConfig {
  enabled: boolean;
  model: VisionModel;
  selectModel: () => Promise<string | null>;
  allowExternalPixels: boolean;
  device: () => VisionDevice;
  maxActions?: number;
  timeoutMs?: number;
  now?: () => number;
  /**
   * 端末の外のモデルを使うときの歯止め。端末の中のモデル（`local`）には掛からない。
   * 渡さないときは歯止め無しではなく、**端末の外を使わない**設定でのみ成り立つ。
   */
  budget?: CloudBudget;
}
/** `CloudModelBudget` が満たす形。差し替えられるよう、実体ではなく形で受ける。 */
export interface CloudBudget {
  beginTask(): void;
  authorize(): void;
  record(costUsd?: number): void;
  exhausted(): void;
}
interface AuditRow {
  sequence: number;
  event: string;
  before: string;
  after?: string;
  verified?: boolean;
  /**
   * 何をもって確かめたか。`target` は操作した対象そのものの読み直し、`model` は画像の判断、
   * `uncertain` はモデルが判断を控えたこと（成否の主張ではない）。
   */
  evidence?: 'target' | 'model' | 'uncertain';
  /** 配送の途中で止まった可能性。未配送と決めつけて再実行しない。 */
  delivery?: 'unknown';
  /** 書き込む対象と内容が依頼に合うかを、配送前に別のモデル呼び出しで確認した。 */
  targetVerified?: boolean;
  route?: string;
  scroll?: ScrollReadback;
  /** どの要素に送ったか。木の位置を表す id で、画面の文言は含まない。 */
  elementId?: string;
  /** まだ満たされていない完了条件の番号。番号だけで、条件の文も画面の文言も含まない。 */
  unmet?: number[];
}
const TOOLS = { plan: 'llm.plan_computer_action', verify: 'llm.verify_computer_action' };

/** No metadata-only fallback. Neither model `done` nor a changed pointer proves success. */
export class ComputerVisionRuntime {
  #busy = false;
  readonly #max: number;
  readonly #timeout: number;
  readonly #now: () => number;
  constructor(readonly config: VisionConfig) {
    this.#max = config.maxActions ?? 12;
    this.#timeout = config.timeoutMs ?? 300_000;
    this.#now = config.now ?? Date.now;
    if (
      !Number.isInteger(this.#max) ||
      this.#max < 1 ||
      this.#max > 12 ||
      !Number.isInteger(this.#timeout) ||
      this.#timeout < 1000 ||
      this.#timeout > 600_000
    )
      throw new VisionFailure('invalid_limits');
  }
  handles(toolId: string): boolean {
    return toolId === 'computer.run';
  }

  async run(step: VisionStep, parent?: AbortSignal): Promise<VisionOutcome> {
    if (!this.handles(step.toolId) || !this.config.enabled) return failure('disabled');
    if (this.#busy) return failure('busy');
    this.#busy = true;
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new VisionFailure('timeout')), this.#timeout);
    const audit: AuditRow[] = [];
    let device: VisionDevice | undefined;
    try {
      check(signal);
      requireApproval(step.approval, 'computer.run', this.#now());
      const goal = step.args['goal'];
      const criteria = step.args['successCriteria'] ?? goal;
      if (
        typeof goal !== 'string' ||
        !goal.trim() ||
        goal.length > 2000 ||
        typeof criteria !== 'string' ||
        !criteria.trim() ||
        criteria.length > 2000
      )
        throw new VisionFailure('invalid_goal');
      const kind = await wait(this.config.selectModel(), signal);
      // A CLI with broad Read permissions is not automatically granted screenshot access.
      if (!kind || !['local', 'openai_api', 'anthropic_api', 'gemini_api', 'codex'].includes(kind))
        throw new VisionFailure('vision_model_unavailable');
      if (kind !== 'local' && !this.config.allowExternalPixels)
        throw new VisionFailure('egress_consent_required');
      /*
       * 画面を端末の外へ出すのに、歯止めが無いまま進まない。
       * 端末の中のモデルは対象外——料金も枠も無いので数える意味がない。
       */
      if (kind !== 'local' && !this.config.budget) throw new VisionFailure('budget_required');
      const cloud = kind === 'local' ? undefined : this.config.budget;
      cloud?.beginTask();
      device = this.config.device();
      await wait(device.claim(step.id), signal);
      const initial = frameOf(await wait(device.begin(goal, kind, signal), signal), this.#now());
      /*
       * 持ち時間は**人が選び終えてから**計る。選択ダイアログを見つけるのに 4 分かかれば、
       * 自動で動ける時間が 1 分しか残らない——待たせたのはこちらなのに。
       * 上限そのもの（既定 5 分）は変えない。
       */
      timer.refresh();
      let current = initial;
      let count = 0;
      let replans = 0;
      let calls = 0;
      let lastAttempt = '';
      /// 写真が古くなったせいで捨てた決定の数。遅さと不運を見分けるために数える。
      let staleDecisions = 0;
      /*
       * 依頼を**確かめられる単位に分けて持つ。**分けるのはこちらの決定論的な処理で、
       * モデルには渡した条件を書き換えさせない。満たされた条件は落ちていき、
       * 残ったものが次の計画へ「まだこれが足りない」として戻る。
       */
      const criteriaList = splitCriteria(criteria);
      let unmet = criteriaList.map((_, index) => index);
      /*
       * 直近の確認がなぜ足りないと言ったか。**次の計画へ戻す。**
       * これを戻していなかったのが、複数工程が終わらない直接の原因だった——
       * planner は同じ画面を見て同じ `done` を繰り返し、verifier は同じ理由で
       * 断り続けていた（2026-09-20 実測、3 回とも同一の応答）。
       * 画面から読んだ文字なので、指示ではなくデータとして渡す。
       */
      let feedback = '';
      /// 人の割り込みで一時停止した回数。待つのは人の手が止まるまで。
      let pauses = 0;
      const model = async (
        toolId: string,
        frames: VisionFrame[],
        args: Record<string, unknown>,
        preview?: TargetPreview,
      ) => {
        check(signal);
        requireApproval(step.approval, 'computer.run', this.#now());
        if (++calls > 30) throw new VisionFailure('model_call_limit');
        /*
         * 端末の外へ掛けるなら、**掛ける前に**使ってよいかを確かめる。
         * 上限に触れたらそこで止める。安い提供元へ移ったり、有料へ上げたりはしない。
         */
        if (cloud) {
          try {
            cloud.authorize();
          } catch (error) {
            throw new VisionFailure(
              error instanceof Error && 'code' in error ? String(error.code) : 'budget_refused',
            );
          }
        }
        // Only references cross into the LLM runner. Pixel reading uses existing VisualContext rules.
        const result = await wait(
          this.config.model.run(
            {
              id: `${step.id}:vision:${calls}`,
              toolId,
              approval: null,
              args: {
                ...args,
                goal,
                successCriteria: criteria,
                vision_model_kind: kind,
                images: preview
                  ? [{ id: preview.id, kind: 'screenshot', label: 'PROPOSED_TARGET_PREVIEW' }]
                  : frames.map((f, i) => ({
                      id: f.id,
                      kind: 'screenshot',
                      label: frames.length === 2 ? (i === 0 ? 'BEFORE' : 'AFTER') : 'CURRENT',
                    })),
                frames: frames.map((f) => ({ id: f.id, width: f.width, height: f.height })),
                // 操作できる候補。位置は渡さない——選ばれた後に helper が取り直す。
                candidates: frames.at(-1)?.elements ?? [],
                observation: frames.at(-1),
                history: audit.slice(-4),
              },
            },
            signal,
          ),
          signal,
        );
        if (!result.ok) {
          // 使い切ったと言われたら、その月はもう掛けない。次の走行は掛ける前に止まる。
          if (result.error?.code === 'llm.quota_exhausted') {
            cloud?.exhausted();
            throw new VisionFailure('free_quota_exhausted');
          }
          throw new VisionFailure(result.error?.code ?? 'model_failed');
        }
        // 数えるのは**返ってきた 1 回**。送って落ちた分も提供元は数えるので、ここでも数える。
        cloud?.record();
        return result.result;
      };
      /*
       * 人が対象を触ったとき。**人は止めない。こちら側だけを止めて、手が空くのを待つ。**
       *
       * 待っている間、helper は何も送らない。人の手が止まったら helper が実行世代を
       * 1 つ進めて再開を許し、割り込みの前に撮った写真と、その上で決まったまま
       * まだ配送していない操作は、そこで全部失効する（古い世代は送る前に断られる）。
       * 再開できる装置が無ければ、これまでどおりその場で停止する。
       */
      const pauseForHuman = async (code: string) => {
        if (!device!.resume || ++pauses > 3) throw new VisionFailure(code);
        for (let attempt = 0; attempt < 20; attempt++) {
          check(signal);
          await sleep(1000, signal);
          try {
            await wait(device!.resume(initial, signal), signal);
            return;
          } catch (error) {
            // まだ人の番。急かさずにもう一度待つ。それ以外の断りは持ち上げる。
            if (!(error instanceof VisionFailure) || error.code !== 'human_active') throw error;
          }
        }
        throw new VisionFailure(code);
      };
      const capture = async (): Promise<VisionFrame> => {
        for (;;) {
          check(signal);
          try {
            const fresh = frameOf(
              await wait(device!.capture(initial, signal), signal),
              this.#now(),
            );
            assertScope(fresh, initial);
            return fresh;
          } catch (error) {
            if (error instanceof VisionFailure && error.code === 'human_takeover') {
              await pauseForHuman(error.code);
              continue;
            }
            throw error;
          }
        }
      };
      /*
       * 形が通らない返答は**何も実行しない**。そのうえで訊き直す。
       * 小さいモデルは `type` の `text` を落としたり、画像の外の座標を返したりする。
       * 以前はそれで実行そのものが終わっていた——危険だからではなく、形が悪いだけで。
       * 訊き直す回数はモデル呼び出しの上限（30）に数えられ、無限には回らない。
       * 直せない返答（stop・危険側）はこれまでどおり止める。
       */
      /*
       * 送る前に断られたもののうち、**別のやり方なら届きうる**もの。
       * どれも入力が出る前に決まる（経路は送る前に選ぶ）ので、二重実行にならない。
       */
      const UNSENT_REFUSALS = new Set([
        'background_field_not_empty',
        'background_no_text_delivery',
        'background_no_press_action',
        'background_target_unresolved',
        'background_element_ambiguous',
        'target_changed',
        /*
         * 「その相手にその操作はできない」「その文字は打てない」も、送る前の断り。
         * **守るための線ではなく、狙いが合っていないだけ**なので選び直させる。
         * 伏せ字の欄（policy_secure_field）だけは別で、ここには入れない——
         * あれは狙いの誤りではなく、してはいけないことなので、その場で人に返す。
         */
        'policy_action_not_allowed',
        'policy_text_rejected',
        // Return を検索欄の外で押そうとした。検索ボタンを押すなど、別の手を選ばせる。
        'policy_return_not_search',
        // 鍵を受け取る窓が違う。押せばその窓に移るので、押してから打ち直させる。
        'background_key_window_not_focused',
      ]);
      // Only these native failures establish that dispatch never started. Every
      // other apply failure (including helper loss or cancellation) is ambiguous.
      // The native adapter must map failures after dispatch to a different code.
      const UNSENT_FAILURES = new Set([
        ...UNSENT_REFUSALS,
        'human_takeover',
        'stale_generation',
        'stale_frame',
        'policy_secure_field',
        'user_cancelled',
        'session_stopped',
        'consent_expired',
        'consent_target_mismatch',
        'approval_expired',
        'invalid_request',
        'invalid_scope',
        'invalid_cache',
        'background_receipt_missing',
        'background_file_exists',
        'background_monitor_unavailable',
        'background_disabled',
        'background_key_route_unavailable',
        'background_spi_unavailable',
        'background_event_unavailable',
        'background_window_ambiguous',
        'background_tree_limit',
        'background_target_offscreen',
        'background_scroll_unsupported',
        'background_scroll_boundary',
        'background_link_unsupported',
      ]);
      let refused = '';
      const SHAPE_FAILURES = new Set([
        'invalid_response',
        'invalid_plan',
        'invalid_frame',
        'invalid_target',
        'invalid_text',
        'invalid_key',
        'invalid_scroll',
        'ungrounded_action',
        'invalid_verdict',
        // 古い写真の番号を書き写しただけ。**形の間違いなので訊き直す。**
        // 指示の側では最初から「最新でない frameId」として説明していたのに、
        // 実際に出る符号が別名だったため、訊き直されずに走行が終わっていた。
        'stale_plan',
      ]);
      const plan = async () => {
        let last: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          const reply = await model(TOOLS.plan, [current], {
            turn: count,
            maxActions: this.#max,
            // まだ満たされていない条件と、確認がそう言った理由。
            // 何が足りないかを渡さずに訊き直すと、同じ `done` がそのまま返る。
            criteriaList,
            unmet,
            ...(feedback ? { verifierEvidence: feedback } : {}),
            // 直前に断られたなら、その符号を返す。理由を知らせずに訊き直すと同じ答えが返る。
            ...(attempt > 0 && last ? { rejected: last } : refused ? { rejected: refused } : {}),
          });
          refused = '';
          try {
            return decisionOf(reply, current);
          } catch (error) {
            const code = error instanceof VisionFailure ? error.code : '';
            if (!SHAPE_FAILURES.has(code)) throw error;
            last = code;
          }
        }
        throw new VisionFailure('invalid_plan');
      };
      /*
       * 確認も、形が通らなければ訊き直す。判断そのもの（satisfied / not_satisfied /
       * uncertain）は訊き直さない——同じ絵に同じ問いを繰り返して答えを変えさせないため。
       */
      const verify = async (
        frames: VisionFrame[],
        args: Record<string, unknown>,
        countedCriteria = 0,
      ): Promise<Verdict> => {
        let last: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          const reply = await model(TOOLS.verify, frames, {
            ...args,
            ...(attempt > 0 && last ? { rejected: last } : {}),
          });
          try {
            return verdictOf(reply, frames.at(-1)!, countedCriteria);
          } catch (error) {
            const code = error instanceof VisionFailure ? error.code : '';
            if (!SHAPE_FAILURES.has(code)) throw error;
            last = code;
          }
        }
        throw new VisionFailure('invalid_verdict');
      };
      const reframeIfStale = async (): Promise<boolean> => {
        if (this.#now() - current.capturedAt <= 60_000) return false;
        staleDecisions += 1;
        if (++replans > 2)
          throw new VisionFailure(staleDecisions > 2 ? 'model_too_slow' : 'stale_frame');
        current = await capture();
        return true;
      };
      while (true) {
        check(signal);
        let proposed = await plan();
        if (proposed.action === 'stop') throw new VisionFailure('planner_stopped');
        if (proposed.action === 'done') {
          const latest = await capture();
          const verdict = await verify(
            [latest],
            { phase: 'goal', criteriaList },
            criteriaList.length,
          );
          const verified = verdict.outcome;
          /*
           * 満たされた条件は落とす。**戻すことはしない**——一度見えた結果が
           * 次の写真で見えなくなったら、それは満たされていないという意味なので、
           * 確認のたびに未達成の集合を丸ごと置き換える。
           */
          const before = unmet.length;
          unmet = verified === 'satisfied' ? [] : verdict.unmet;
          feedback = verdict.evidence;
          audit.push({
            sequence: count,
            event: 'goal_verification',
            before: latest.sha256,
            verified: verified === 'satisfied',
            ...(verified === 'uncertain' ? { evidence: 'uncertain' as const } : {}),
            ...(unmet.length ? { unmet } : {}),
          });
          // 満たした条件が増えたなら前へ進んでいる。作り直しの持ち分を戻す。
          if (unmet.length < before) replans = 0;
          if (verified === 'satisfied')
            return {
              ok: true,
              result: {
                completed: true,
                verification: 'visual',
                actions: count,
                modelCalls: calls,
                audit,
              },
            };
          // 「分からない」で一度で終わらせない。やり直しの持ち分は `not_satisfied` と同じ。
          if (++replans > 2)
            throw new VisionFailure(
              verified === 'uncertain' ? 'verification_uncertain' : 'goal_not_verified',
            );
          current = latest;
          continue;
        }
        if (count >= this.#max) throw new VisionFailure('action_limit');
        // No stale model result may mutate the desktop after cancellation or approval expiry.
        check(signal);
        requireApproval(step.approval, 'computer.run', this.#now());
        if (await reframeIfStale()) continue;
        const verifiesTarget = ['type', 'type_keys', 'scroll'].includes(proposed.action);
        if (verifiesTarget) {
          if (!device.previewTarget) throw new VisionFailure('target_preview_unavailable');
          let preview: TargetPreview;
          try {
            preview = targetPreviewOf(
              await wait(
                device.previewTarget(
                  current,
                  proposed,
                  signal,
                  Date.parse((step.approval as { expiresAt: string }).expiresAt),
                ),
                signal,
              ),
              current,
              proposed,
            );
          } catch (error) {
            // Preview is explicitly read-only, so interruption can safely reframe.
            if (
              error instanceof VisionFailure &&
              ['human_takeover', 'stale_generation'].includes(error.code)
            ) {
              await pauseForHuman(error.code);
              current = await capture();
              continue;
            }
            if (error instanceof VisionFailure && error.code === 'stale_frame' && ++replans <= 2) {
              current = await capture();
              continue;
            }
            throw error;
          }
          // The helper resolved a single actual field. Both verifier and input use
          // that same identity, never the model's potentially misleading pixel box.
          const { target: _target, ...named } = proposed;
          proposed = { ...named, elementId: preview.elementId };
          /*
           * 書ける欄であることと、依頼された欄であることは違う。配送前に、元の依頼と
           * この対象・文字の組み合わせを別の呼び出しで確かめる。planner の期待や
           * 自信は渡さない。拒否・曖昧・不正な返答を別の欄への書き込みに言い換えない。
           * これはモデルによる追加確認で、native 側の承認・保護欄・世代検査の代わりではない。
           */
          const targetVerdict = verdictOf(
            await model(
              TOOLS.verify,
              [current],
              {
                phase: 'target',
                proposedInput: {
                  action: proposed.action,
                  elementId: proposed.elementId,
                  text: proposed.text,
                  ...(proposed.textMode ? { textMode: proposed.textMode } : {}),
                  ...(proposed.direction ? { direction: proposed.direction } : {}),
                },
                targetPreview: preview,
              },
              preview,
            ),
            current,
          );
          if (targetVerdict.outcome !== 'satisfied') throw new VisionFailure('target_not_verified');
          // 確認を待っている間の取消・承認切れ・写真の古さも、配送する前に検査する。
          check(signal);
          requireApproval(step.approval, 'computer.run', this.#now());
        }
        /*
         * 決まったときには写真が古い、という場合。撮り直して考え直す。
         * ただし**毎回そうなるなら、それは一度きりの不運ではない。**
         * モデルが鮮度の窓（60 秒）より遅いというだけのことなので、
         * 同じことを繰り返さずに、そう言って止める。
         * 実測（qwen3.5:9b / 1200x966）: 109 秒・94 秒・74 秒。
         * 一度も送れないまま 4 分半を使い、`stale_frame` とだけ言って終わっていた。
         */
        if (await reframeIfStale()) continue;
        const signature = createHash('sha256')
          .update(
            JSON.stringify({
              frame: current.sha256,
              action: proposed.action,
              target: proposed.target,
              // 要素で指した操作は座標を持たない。id を入れないと、**別の要素が同じ操作に見える。**
              elementId: proposed.elementId,
              text: proposed.text,
              textMode: proposed.textMode,
              direction: proposed.direction,
              key: proposed.key,
            }),
          )
          .digest('hex');
        if (signature === lastAttempt) throw new VisionFailure('repeated_action');
        lastAttempt = signature;
        let applied: { route?: string; effect?: string; scroll?: ScrollReadback } | void;
        try {
          applied = await wait(
            device.apply(
              current,
              proposed,
              signal,
              Date.parse((step.approval as { expiresAt: string }).expiresAt),
            ),
            signal,
          );
          if (proposed.action === 'scroll') {
            if (applied?.effect !== 'confirmed')
              throw new VisionFailure('input_effect_unconfirmed');
            applied.scroll = scrollReadbackOf(applied.scroll, proposed);
          }
        } catch (error) {
          if (!(error instanceof VisionFailure) || !UNSENT_FAILURES.has(error.code)) {
            audit.push({
              sequence: count + 1,
              event: proposed.action,
              before: current.sha256,
              verified: false,
              evidence: 'uncertain',
              delivery: 'unknown',
              ...(verifiesTarget ? { targetVerified: true } : {}),
              ...(proposed.elementId ? { elementId: proposed.elementId } : {}),
            });
            throw error;
          }
          /*
           * 人が割り込んだ、あるいは割り込みで実行世代が進んでいた。
           * **どちらも入力が出る前の断りで、画面には何も起きていない。**
           * 待って、撮り直して、その新しい画面の上で考え直す。
           * 作り直しの持ち分は減らさない——言い間違えたのではなく、順番を譲っただけ。
           */
          if (
            error instanceof VisionFailure &&
            (error.code === 'human_takeover' || error.code === 'stale_generation')
          ) {
            await pauseForHuman(error.code);
            current = await capture();
            continue;
          }
          // Only a definite pre-input stale-frame refusal can retry without ambiguity.
          if (error instanceof VisionFailure && error.code === 'stale_frame' && ++replans <= 2) {
            current = await capture();
            continue;
          }
          /*
           * 経路が無い、という断り。**送る前に決まるので、何も起きていない。**
           * どの道で届けるかは helper が対象を見て決めるので、モデルには分からない
           * （例: 中身のある欄に `type` は書けない。物理キーで打つなら押してから `type_keys`）。
           * 符号を返して立て直させる。回数は作り直しの持ち分に数える。
           * **断りの理由が「してはいけない」の側（policy_・同意・割り込み）は、ここに入れない。**
           */
          if (error instanceof VisionFailure && UNSENT_REFUSALS.has(error.code) && ++replans <= 2) {
            refused = error.code;
            current = await capture();
            continue;
          }
          throw error;
        }
        count++;
        // 配送の記録を先に残す。次の撮影・検証が失敗しても、送った入力は消えない。
        const sent: AuditRow = {
          sequence: count,
          event: proposed.action,
          before: current.sha256,
          verified: false,
          evidence: 'uncertain',
          ...(verifiesTarget ? { targetVerified: true } : {}),
          ...(applied?.route ? { route: applied.route } : {}),
          ...(applied?.scroll ? { scroll: applied.scroll } : {}),
          ...(proposed.elementId ? { elementId: proposed.elementId } : {}),
        };
        audit.push(sent);
        const after = await capture();
        /*
         * helper が対象を読み直して変化を確かめられたなら、**そちらを信じる。**
         * 画像を見せて「変わりましたか」と訊き直すより確かで、呼び出しも 1 回減る。
         * 実測では、絵が別の絵に入れ替わっただけの変化を小さいモデルが読み取れず、
         * 操作は成功しているのに `verification_uncertain` で止まっていた。
         * 目的そのものの確認（phase: goal）は省かない。
         */
        const confirmedByTarget = applied?.effect === 'confirmed';
        const verdict: Verdict = confirmedByTarget
          ? { outcome: 'satisfied', evidence: '', unmet: [] }
          : await verify([current, after], {
              phase: 'action',
              expectation: proposed.expectation,
              action: proposed.action,
            });
        const verified = verdict.outcome;
        // 効果が確かめられなかったときだけ、その理由を次の計画へ戻す。
        feedback = verified === 'satisfied' ? '' : verdict.evidence;
        Object.assign(sent, {
          after: after.sha256,
          verified: verified === 'satisfied',
          evidence: confirmedByTarget ? 'target' : verified === 'uncertain' ? 'uncertain' : 'model',
        });
        if (verified !== 'satisfied' && ++replans > 2)
          throw new VisionFailure(
            verified === 'uncertain' ? 'verification_uncertain' : 'action_not_verified',
          );
        /*
         * 効果の確かめられた操作は**前進**。作り直しの持ち分を戻す。
         * 戻さないと、工程の多い依頼は序盤の 3 回の言い直しで持ち分を使い切り、
         * あとがどれだけうまく進んでも最初のつまずきで終わってしまう。
         * 無限には回らない——操作数（既定 12）とモデル呼び出し（30）が別に上限を持つ。
         */
        if (verified === 'satisfied') replans = 0;
        current = after;
      }
    } catch (error) {
      const code = signal.aborted
        ? controller.signal.aborted
          ? 'timeout'
          : 'cancelled'
        : error instanceof VisionFailure
          ? error.code
          : 'failed';
      await device?.stopped?.(step.id, code, audit).catch(() => undefined);
      /*
       * 止まった時点で**もう送ってしまった入力**があるなら、それを先に言う。
       *
       * 実測 2026-09-22: 伏せ字の欄を頼まれた走行が、その欄は守ったまま同じ文字を
       * 別の見える欄へ書き、そのあと停止した。止まったことは伝わるのに、
       * **画面に何かを残したことは伝わらなかった**——利用者は確認しに行けない。
       * 取り消せるとは言わない。送った数と、確認が要ることだけを言う。
       */
      const delivered = audit.filter(
        (row) => row.event !== 'goal_verification' && !row.delivery,
      ).length;
      const unknown = audit.filter((row) => row.delivery === 'unknown').length;
      const stopped = failure(code);
      const disclosure = [
        ...(delivered > 0
          ? [
              `すでに${delivered}件の入力を画面へ送っています（取り消していません）。画面の状態を確認してください。`,
            ]
          : []),
        ...(unknown > 0
          ? [
              `${unknown}件の入力は配送中に停止した可能性があります。一部が届いている場合があるため、再送せずに画面の状態を確認してください。`,
            ]
          : []),
      ].join(' ');
      return {
        ...stopped,
        ...(disclosure && stopped.error
          ? {
              error: {
                ...stopped.error,
                message: `${stopped.error.message} ${disclosure}`,
              },
            }
          : {}),
        result: { completed: false, audit },
      };
    } finally {
      clearTimeout(timer);
      // The production helper is killed on AbortSignal; it cannot keep typing after stop.
      controller.abort();
      if (device) await device.close().catch(() => undefined);
      this.#busy = false;
    }
  }
}

function failure(code: string): VisionOutcome {
  // 止まった理由ごとの言い方。どれも「完了していない」ことを先に言う。
  const messages: Record<string, string> = {
    human_takeover:
      '対象アプリを利用者が操作したため停止しました。手が空くのを待ちましたが、操作は続いています。入力は送っていません。',
    background_unsupported:
      'この操作はバックグラウンドでは未対応です。前面操作へ切り替えず停止しました。',
    background_target_offscreen:
      '操作する場所が接続中の画面に表示されていないため、入力せずに停止しました。対象の窓を画面内へ移してから再実行してください。',
    background_link_unsupported:
      'このリンクは対象ページ内の確実なバックグラウンド移動として確認できないため、クリックせず停止しました。',
    background_scroll_unsupported:
      'この領域のスクロール位置を安全に読み取れないため、スクロールせず停止しました。',
    background_scroll_boundary: '指定方向の端まで達しているため、スクロールせず停止しました。',
    background_text_unsupported:
      'この入力欄はバックグラウンド入力に対応していないか、既に文字があります。上書きせず停止しました。',
    background_interference:
      '前面アプリまたはクリップボードの変化を検出し、停止しました。直前の操作結果を確認してください。',
    background_result_unknown:
      'バックグラウンド操作の結果を確認できませんでした。二重実行を防ぐため再送していません。',
    background_monitor_unavailable:
      '利用者の操作を検出する監視を確認できないため、画面操作を停止しました。',
    verification_uncertain:
      '操作の結果を画面から確かめきれませんでした。完了扱いにせず停止しました。',
    target_not_verified:
      '書き込む対象と内容が依頼に合うことを確認できなかったため、この入力を送らずに停止しました。',
    target_preview_unavailable:
      '入力先を示す画像を作成できないため、この入力を送らずに停止しました。画面操作ヘルパーを更新してください。',
    invalid_target_preview:
      '入力先の画像と元の画面の一致を確認できなかったため、この入力を送らずに停止しました。',
    input_effect_unconfirmed:
      '操作の配送結果が未確認のため停止しました。二重入力を防ぐため、自動では再実行しません。',
    verification_blocked:
      '確認の途中で先へ進めない画面を検出し、停止しました。画面の状態を確認してください。',
    policy_return_not_search:
      'Return キーは検索欄とアドレス欄でだけ押します。フォームの送信には使いません。',
    commit_boundary:
      '注文・購入・支払いを確定するボタンは、画面操作では押しません。金額と内容を確認してから確定する、注文の手順で依頼してください。',
    goal_not_verified: '目的が満たされたことを画面から確認できませんでした。完了していません。',
    free_quota_exhausted:
      '選んだクラウドモデルの無料で使える分を使い切りました。自動では有料に切り替えません。',
    billed_project_not_free:
      'この API キーは課金対象のプロジェクトのものです。無料として実行しません。設定で有料を有効にしてください。',
    task_call_limit: 'この依頼に決めた呼び出し回数の上限に達したため停止しました。',
    month_call_limit: '今月に決めた呼び出し回数の上限に達したため停止しました。',
    task_cost_limit: 'この依頼に決めた費用の上限に達したため停止しました。',
    month_cost_limit: '今月に決めた費用の上限に達したため停止しました。',
    budget_required:
      'クラウドのモデルを使うには、費用の歯止め（無料枠のみ／上限）の設定が必要です。',
    model_too_slow:
      '選んだモデルの応答が画面の更新に追いつかないため、操作を1つも送らずに停止しました。より速いモデルを選んでください。',
    background_key_window_not_focused:
      '選んだ窓が文字入力を受け取る状態ではないため、どこにも送らずに停止しました。',
    background_keys_not_literal:
      '打った内容が、入力方式（かな変換など）によって別の文字に変わりました。対象アプリを英数入力にしてからお試しください。完了扱いにしていません。',
    action_not_verified: '操作の効果を画面から確認できませんでした。以降の操作は行っていません。',
    stale_generation:
      '利用者の操作が入ったため、それ以前の画面にもとづく操作を破棄しました。送信はしていません。',
    human_active: '対象アプリを利用者が操作中のため、再開していません。',
    /*
     * 以前はこの符号が一覧に無く、既定の「権限・対象画面・モデル設定を確認」に
     * 落ちていた。実測では状態ディレクトリの置き場所が原因だったのに、
     * **原因の見当がつかない文面が出ていた。**
     */
    invalid_cache:
      '画面の一時保存先が安全に使えません（symlink を含む、所有者が違う、権限が緩いなど）。操作は行っていません。保存先の設定を確認してください。',
    replay_blocked:
      'この依頼は既に開始されています。二重実行を防ぐため再実行しません。新しい依頼を作ってください。',
    helper_unavailable: '画面操作ヘルパーから応答を確認できなかったため停止しました。',
  };
  return {
    ok: false,
    error: {
      code: `computer.vision.${code}`,
      message:
        messages[code] ??
        '画面操作を停止しました。完了は確認されていません。権限・対象画面・モデル設定を確認してください。',
    },
  };
}
/** 待つ。取り消しはその場で効く——人を待っている間も止められる。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new VisionFailure('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new VisionFailure('cancelled');
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new VisionFailure('cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
    if (signal.aborted) abort();
  });
}
