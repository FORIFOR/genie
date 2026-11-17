/**
 * General Assistant の step。正本 §2.2・§29。
 *
 * 何をする話か決まらないときの受け皿。chat lane がここへ来る。
 *
 * この executor が無かった間、`general.answer` と `general.compose` は
 * **宣言だけで実装が無く**、走らせると空の成功を返していた。
 * MVP に必須の agent が、黙って何もしない状態だった。
 *
 * ここが持つ性質は 2 つ:
 *   - **根拠を集めない仕事だと分かるように書く。**調査とは別のもの
 *   - **書くのは下書きまで。**送るのは人の操作
 */
import type { LanguageModel, VisualAttachment } from './providers.js';

interface TaskLike {
  readonly taskId: string;
  readonly tenantId: string;
  readonly input: Record<string, unknown>;
}

interface StepLike {
  readonly toolId: string;
  readonly args: Record<string, unknown>;
}

export interface GeneralExecutorResult {
  result: unknown;
  detail?: string | null;
  artifact?: { title: string; markdown: string };
}

type Executor = { execute(input: TaskLike, step: StepLike): Promise<GeneralExecutorResult> };

/** step か task か、どちらかに入っている値を読む。 */
function value(input: TaskLike, step: StepLike, key: string): string | null {
  const fromStep = step.args[key];
  if (typeof fromStep === 'string' && fromStep.trim().length > 0) return fromStep;
  const fromTask = input.input[key];
  return typeof fromTask === 'string' && fromTask.trim().length > 0 ? fromTask : null;
}

/**
 * 問いに添えられた端末内の画像。step か task のどちらかに入っている。
 *
 * 形が違うものは**捨てる**。id はそのまま端末のファイル名になるので、
 * パス区切りを含むものを通さない。
 */
function attachmentsOf(input: TaskLike, step: StepLike): VisualAttachment[] {
  const raw = Array.isArray(step.args['attachments'])
    ? step.args['attachments']
    : Array.isArray(input.input['attachments'])
      ? input.input['attachments']
      : [];
  return raw.flatMap((item): VisualAttachment[] => {
    const row = item as Record<string, unknown> | null;
    const id = row?.['id'];
    const kind = row?.['kind'];
    const label = row?.['label'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return [];
    if (kind !== 'screenshot' && kind !== 'clipboard_image') return [];
    if (typeof label !== 'string' || label.trim().length === 0) return [];
    return [{ id, kind, label }];
  });
}

/** 直前の会話（turn.ts の historyOf が作ったもの）。形の違う行は捨てる。 */
function historyOf(input: TaskLike, step: StepLike): { role: 'user' | 'genie'; text: string }[] {
  const raw = Array.isArray(step.args['history'])
    ? step.args['history']
    : Array.isArray(input.input['history'])
      ? input.input['history']
      : [];
  return raw
    .flatMap((item) => {
      const row = item as Record<string, unknown> | null;
      const role = row?.['role'];
      const text = row?.['text'];
      if ((role !== 'user' && role !== 'genie') || typeof text !== 'string' || !text.trim())
        return [];
      return [{ role, text: text.slice(0, 300) } as { role: 'user' | 'genie'; text: string }];
    })
    .slice(-6);
}

/** 題名。長い依頼をそのまま題にしない。 */
function titleOf(text: string): string {
  const firstLine = text.split('\n')[0]!.trim();
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 39)}…`;
}

export function generalExecutors(model: LanguageModel): Record<string, Executor> {
  return {
    'general.answer': {
      async execute(input, step) {
        const question = value(input, step, 'question') ?? value(input, step, 'message');
        if (!question) {
          // 何を聞かれたのか分からないまま、それらしい答えを作らない
          throw new Error('there is nothing to answer');
        }
        const context = value(input, step, 'context') ?? undefined;
        const attachments = attachmentsOf(input, step);
        // 添付が無ければ、これまで通りの形で呼ぶ（cloud 実装は第 3 引数を知らなくてよい）。
        const history = historyOf(input, step);
        const answer =
          history.length > 0
            ? await model.answer(question, context, attachments, history)
            : attachments.length > 0
              ? await model.answer(question, context, attachments)
              : await model.answer(question, context);

        return {
          result: { answered: true },
          detail: null,
          artifact: { title: titleOf(question), markdown: answer },
        };
      },
    },

    'general.compose': {
      async execute(input, step) {
        const instruction = value(input, step, 'instruction') ?? value(input, step, 'message');
        if (!instruction) throw new Error('there is nothing to write');

        const context = value(input, step, 'context') ?? undefined;
        const attachments = attachmentsOf(input, step);
        const text =
          attachments.length > 0
            ? await model.compose(instruction, context, attachments)
            : await model.compose(instruction, context);

        return {
          result: { composed: true, draft: true, sent: false },
          detail: null,
          artifact: {
            title: titleOf(instruction),
            // Draft/send state is metadata, not copy that contaminates exported work.
            markdown: text,
          },
        };
      },
    },
  };
}
