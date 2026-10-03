#!/usr/bin/env node
/** Uses the normal task/approval API. Starting never implies approval or successful ordering. */
import { readFile, open, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TransactionIntent, simulationOrderIntent } from '../packages/contracts/dist/index.js';
import { client } from './computer-use.mjs';
import { DEFAULT_STATE, validateConfig, privateJSON } from './local-preview/config.mjs';
import { desktopEmail } from './start-local-host.mjs';

const HELP = `Genie 注文プレビュー（実際の購入・課金なし）
  node scripts/transaction-use.mjs demo --run-file PATH [--demo-kind pizza|burger|stock]
  node scripts/transaction-use.mjs start --intent-file PATH --run-file PATH
  node scripts/transaction-use.mjs status --run-file PATH
  node scripts/transaction-use.mjs approve --run-file PATH --approval-id ID
  node scripts/transaction-use.mjs cancel --run-file PATH
  node scripts/transaction-use.mjs recover --run-file PATH
  node scripts/transaction-use.mjs reconcile --source-run-file PATH --run-file NEW_PATH

全コマンドで --state-dir PATH を指定できます。
先に build-checkout-simulation.sh と start-local-preview.mjs --computer-use --transaction-simulation。
demo/start は依頼の受付のみ。Genieアプリまたはstatusで明細を読んでからapproveします。
確定前の対象選択では「Genie 模擬注文 — 課金なし」だけを選んでください。
応答喪失時はrecover（受付照会）/reconcile（注文履歴照会）。demoを再実行しないでください。
同じ注文のorderKeyとrun-fileは保持してください。新しい注文の依頼とは区別されます。
`;

export function demoIntent(kind = 'pizza', orderKey = randomUUID()) {
  return simulationOrderIntent(kind, orderKey);
}

export async function performTransaction(command, record, request, approvalId) {
  if (
    record.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(record.key) ||
    !['transaction.order', 'transaction.reconcile'].includes(record.request?.kind)
  )
    throw new Error('Invalid transaction run file.');
  if (['start', 'demo', 'recover', 'reconcile'].includes(command)) {
    if (record.taskId) return request(`/v1/tasks/${encodeURIComponent(record.taskId)}`);
    const task = await request('/v1/tasks', 'POST', record.request, record.key);
    if (typeof task.id !== 'string' || !task.id)
      throw new Error('受付未確認。run-fileを保持してください。');
    record.taskId = task.id;
    return task;
  }
  if (!record.taskId) throw new Error('受付未確認。新規注文せずrecoverしてください。');
  const path = `/v1/tasks/${encodeURIComponent(record.taskId)}`;
  if (command === 'cancel') return request(path + '/cancel', 'POST', { reason: 'user_requested' });
  const task = await request(path);
  if (command === 'approve') {
    if (task.kind !== 'transaction.order' || task.status !== 'WAITING_APPROVAL')
      throw new Error('この注文は承認待ちではありません。');
    const approvals = await request(path + '/approvals');
    if (!approvalId || !approvals.items?.some((item) => item.id === approvalId))
      throw new Error('現在の明細をstatusで確認してapproval-idを指定してください。');
    await request(path + '/approve', 'POST', { approval_id: approvalId, decision: 'APPROVED' });
    return {
      task_id: record.taskId,
      status: 'APPROVAL_SENT',
      message: '承認を送信しました。注文完了ではありません。',
    };
  }
  const approvals =
    task.status === 'WAITING_APPROVAL' ? await request(path + '/approvals') : { items: [] };
  return { task, approvals: approvals.items };
}

async function main(args) {
  const [command = 'help', ...rest] = args;
  if (['help', '--help'].includes(command)) {
    console.log(HELP);
    return;
  }
  if (!['demo', 'start', 'status', 'approve', 'cancel', 'recover', 'reconcile'].includes(command))
    throw new Error('Unknown command. Use --help.');
  const options = { 'state-dir': DEFAULT_STATE };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    if (
      ![
        'state-dir',
        'run-file',
        'intent-file',
        'approval-id',
        'source-run-file',
        'demo-kind',
      ].includes(key) ||
      !rest[i + 1]
    )
      throw new Error('Invalid option.');
    options[key] = rest[i + 1];
  }
  if (!options['run-file']) throw new Error('--run-file is required.');
  const state = await realpath(resolve(options['state-dir']));
  const config = JSON.parse(await readFile(join(state, 'runtime.json'), 'utf8'));
  validateConfig(config);
  const file = resolve(options['run-file']);
  let record;
  if (['demo', 'start', 'reconcile'].includes(command)) {
    let request;
    if (command === 'reconcile') {
      if (!options['source-run-file']) throw new Error('--source-run-file is required.');
      const source = JSON.parse(await readFile(resolve(options['source-run-file']), 'utf8'));
      if (source.project !== config.project || source.request?.kind !== 'transaction.order')
        throw new Error('Source run belongs to a different preview or is not an order.');
      const { provider, mode, account, orderKey } = TransactionIntent.parse(
        source.request.input.intent,
      );
      request = { kind: 'transaction.reconcile', input: { provider, mode, account, orderKey } };
    } else {
      if (command === 'start' && !options['intent-file'])
        throw new Error('--intent-file is required.');
      const intent =
        command === 'demo'
          ? demoIntent(options['demo-kind'])
          : TransactionIntent.parse(
              JSON.parse(await readFile(resolve(options['intent-file']), 'utf8')),
            );
      request = {
        kind: 'transaction.order',
        input: { intent },
        title: intent.mode === 'simulation' ? '模擬注文（課金なし）' : '注文',
      };
    }
    record = { version: 1, project: config.project, key: randomUUID(), request, taskId: null };
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else record = JSON.parse(await readFile(file, 'utf8'));
  if (record.project !== config.project) throw new Error('元のstate-dirを指定してください。');
  const base = `http://127.0.0.1:${config.port}`;
  const credentials = await client(base)('/v1/auth/dev/token', 'POST', {
    email: desktopEmail(config.identity),
    display_name: 'Genie 注文プレビュー',
  });
  if (!credentials.access_token) throw new Error('Local authentication unavailable.');
  const result = await performTransaction(
    command,
    record,
    client(base, credentials.access_token),
    options['approval-id'],
  );
  await privateJSON(file, record);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
