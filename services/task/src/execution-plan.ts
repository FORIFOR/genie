import type { TaskPlan, TaskStep, ApprovalCard } from './plan.js';

export function planExecution(input: Record<string, unknown>): TaskPlan {
  const goal = input['goal'];
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 8000)
    throw new Error('Execution needs a bounded goal');
  return {
    steps: [
      {
        index: 0,
        toolId: 'execution.prepare',
        risk: 'READ',
        surface: 'local',
        message: '実行できる方法と確認内容を準備しています',
        args: { goal },
      },
      {
        index: 1,
        toolId: 'execution.apply',
        risk: 'EXTERNAL_COMMIT',
        surface: 'local',
        requiresConfirmation: true,
        message: '確認した内容を実行し、結果を確かめます',
        args: {},
      },
    ],
    artifact: { type: 'OTHER', title: goal, mimeType: 'text/markdown' },
  };
}
const row = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export function withPreparedExecution(step: TaskStep, results: readonly unknown[]): TaskStep {
  if (step.toolId !== 'execution.apply') return step;
  const prepared = row(results[0]);
  if (
    !prepared ||
    prepared['version'] !== 1 ||
    typeof prepared['id'] !== 'string' ||
    !['ready', 'needs_input', 'unavailable'].includes(String(prepared['status']))
  )
    throw new Error('Missing prepared execution');
  if (prepared['status'] !== 'ready')
    return {
      ...step,
      toolId: 'execution.report',
      risk: 'READ',
      requiresConfirmation: false,
      message: '必要な条件や接続を確認しています',
      args: { prepared },
    };
  if (
    !row(prepared['intent']) ||
    !row(prepared['capability']) ||
    !Array.isArray(prepared['details']) ||
    prepared['details'].length < 2 ||
    prepared['details'].length > 10 ||
    !prepared['details'].every(
      (d) => typeof row(d)?.['label'] === 'string' && typeof row(d)?.['value'] === 'string',
    )
  )
    throw new Error('Invalid execution preview');
  return { ...step, args: { prepared } };
}
export function executionApprovalCard(step: TaskStep): ApprovalCard | null {
  if (step.toolId !== 'execution.apply') return null;
  const prepared = row(step.args['prepared']);
  if (!prepared || !Array.isArray(prepared['details']))
    throw new Error('Execution must be prepared before approval');
  return {
    summary: '次の内容だけを実行します。結果を確認できない場合は自動でやり直しません。',
    details: prepared['details'] as { label: string; value: string }[],
    impact: {
      primary_action_label: 'この内容で実行する',
      affected_count: 1,
      scope: 'external',
      reversible: false,
      recovery_note:
        'アプリによっては入力時点で外部へ保存されます。停止しても既に実行した変更は取り消せません。',
    },
  };
}
