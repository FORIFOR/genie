/**
 * Research の step を task-service へ差し込む。
 *
 * task 側は「何をどの順でやるか」だけを持ち、中身は知らない（`StepExecutor`）。
 * ここが research 側の入口。
 */
import type { ResearchService } from './service.js';

interface TaskLike {
  readonly taskId: string;
  readonly tenantId: string;
  readonly input: Record<string, unknown>;
}

interface StepLike {
  readonly toolId: string;
  readonly args: Record<string, unknown>;
}

/** 失敗したら、この調査は進行中ではなくなる。 */
type Executor = {
  execute(input: TaskLike, step: StepLike): Promise<ResearchExecutorResult>;
  onFailure(input: TaskLike): Promise<void>;
};

export interface ResearchExecutorResult {
  result: unknown;
  detail?: string | null;
  artifact?: { title: string; markdown: string };
}

function questionOf(input: TaskLike, step: StepLike): string {
  const fromStep = step.args['question'];
  if (typeof fromStep === 'string' && fromStep.trim().length > 0) return fromStep.trim();
  const fromTask = input.input['question'] ?? input.input['message'];
  return typeof fromTask === 'string' ? fromTask.trim() : '';
}

/** tool id ごとの executor。task-service の `ActivityDeps.executors` へ渡す。 */
export function researchExecutors(research: ResearchService): Record<string, Executor> {
  // どの step で落ちても、この調査は「進行中」ではなくなる
  const onFailure = (input: TaskLike): Promise<void> =>
    research.markFailed(input.tenantId, input.taskId);

  return {
    'research.plan': {
      execute: (input, step) =>
        research.plan(input.tenantId, input.taskId, questionOf(input, step)),
      onFailure,
    },
    'research.search': {
      execute: (input) => research.search(input.tenantId, input.taskId),
      onFailure,
    },
    'research.deepen': {
      execute: (input) => research.deepen(input.tenantId, input.taskId),
      onFailure,
    },
    'research.verify': {
      execute: (input) => research.verify(input.tenantId, input.taskId),
      onFailure,
    },
    'research.report': {
      execute: (input) => research.report(input.tenantId, input.taskId),
      onFailure,
    },
  };
}
