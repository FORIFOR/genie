#!/usr/bin/env node
/** Local preview client; all execution and authorization stay in the existing task runtime. */
import { readFile, open, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_STATE, validateConfig, privateJSON, lockPort } from './local-preview/config.mjs';
import { desktopEmail } from './start-local-host.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Genie Computer Use（Mac / ローカルプレビュー）
  node scripts/computer-use.mjs check [--state-dir PATH]
  node scripts/computer-use.mjs start --goal "目的" --criteria "確認する結果" --run-file PATH
  node scripts/computer-use.mjs status --run-file PATH
  node scripts/computer-use.mjs approve --run-file PATH --approval-id ID
  node scripts/computer-use.mjs cancel --run-file PATH
  node scripts/computer-use.mjs recover --run-file PATH

先に start-local-preview.mjs --computer-use --model <画像対応モデル> を起動します。
check は撮影・入力・OS許可要求を行いません。start は受付のみで、承認を自動化しません。
status の approval ID を確認して approve すると、対象アプリの選択ダイアログが出ます。
同意後はその窓だけ最大12操作・5分。個別操作の確認はありません。
バックグラウンドAX操作のみ。対象を前面で使うと停止し、自動再開しません。
送信先はプレビューのローカルモデル。画面や入力内容を外部へ送りません。
run-file は新しい依頼ごとに別名を使い、削除しないでください。
応答喪失時は recover が保存した同一キー・入力で受付を照合します（新しい依頼は作りません）。
停止要求は cancel。既に行った入力は取り消しません。status で取消確定を確認してください。
`;

export function parseArgs(args) {
  const [command = 'help', ...rest] = args;
  if (
    !['help', '--help', 'check', 'start', 'status', 'approve', 'cancel', 'recover'].includes(
      command,
    )
  )
    throw new Error('Unknown command. Use --help.');
  const options = { command, stateDir: DEFAULT_STATE };
  const fields = {
    '--state-dir': 'stateDir',
    '--run-file': 'runFile',
    '--goal': 'goal',
    '--criteria': 'criteria',
    '--approval-id': 'approvalId',
  };
  for (let i = 0; i < rest.length; i++) {
    if (!fields[rest[i]] || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error('Invalid option. Use --help.');
    options[fields[rest[i]]] = rest[++i];
  }
  if (!['help', '--help', 'check'].includes(command) && !options.runFile)
    throw new Error('--run-file is required.');
  if (
    command === 'start' &&
    (!options.goal?.trim() ||
      options.goal.length > 2000 ||
      !options.criteria?.trim() ||
      options.criteria.length > 2000)
  )
    throw new Error('--goal and --criteria must contain 1–2000 characters.');
  if (command === 'approve' && !options.approvalId)
    throw new Error('Inspect status and supply --approval-id.');
  return options;
}

export function client(base, token, fetcher = fetch) {
  return async (path, method = 'GET', body, key) => {
    const response = await fetcher(base + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}; status で照会してください。自動再送はしません。`);
    return response.status === 204 ? null : response.json();
  };
}

export async function perform(command, record, request, approvalId) {
  if (
    record.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(record.key) ||
    record.request?.kind !== 'computer.run'
  )
    throw new Error('Invalid run file.');
  if (command === 'start' || command === 'recover') {
    if (record.taskId) return request(`/v1/tasks/${encodeURIComponent(record.taskId)}`);
    const task = await request('/v1/tasks', 'POST', record.request, record.key);
    if (typeof task.id !== 'string' || !task.id)
      throw new Error('受付結果未確認。run-file を保持して recover してください。');
    record.taskId = task.id;
    return task;
  }
  if (!record.taskId)
    throw new Error('受付結果未確認。保存済み run-file で recover してください。');
  const path = `/v1/tasks/${encodeURIComponent(record.taskId)}`;
  if (command === 'cancel') return request(path + '/cancel', 'POST', { reason: 'user_requested' });
  const task = await request(path);
  if (command === 'approve') {
    if (task.kind !== 'computer.run' || task.status !== 'WAITING_APPROVAL')
      throw new Error('この依頼は画面操作の承認待ちではありません。');
    const approvals = await request(path + '/approvals');
    if (!approvals.items?.some((a) => a.id === approvalId))
      throw new Error('承認IDが現在の依頼と一致しません。');
    await request(path + '/approve', 'POST', { approval_id: approvalId, decision: 'APPROVED' });
    return {
      task_id: record.taskId,
      status: 'APPROVAL_SENT',
      message: '対象アプリの選択を待っています。完了ではありません。',
    };
  }
  const approvals =
    task.status === 'WAITING_APPROVAL' ? await request(path + '/approvals') : { items: [] };
  return { task, approvals: approvals.items };
}

async function main(options) {
  if (['help', '--help'].includes(options.command)) {
    console.log(HELP);
    return;
  }
  const stateDir = await realpath(resolve(options.stateDir));
  const config = JSON.parse(await readFile(join(stateDir, 'runtime.json'), 'utf8'));
  validateConfig(config);
  const base = `http://127.0.0.1:${config.port}`;
  if (options.command === 'check') {
    const { stdout } = await promisify(execFile)(join(ROOT, '.build/computer/genie-computer-background'), [
      '--status',
    ]);
    const permissions = JSON.parse(stdout);
    const control = await client(
      `http://127.0.0.1:${lockPort(stateDir)}`,
      config.controlToken,
    )('/status');
    const ready =
      permissions.ready &&
      control.phase === 'ready' &&
      control.computerUse === true &&
      control.computerDelivery === 'background' &&
      permissions.deliveryMode === 'background' &&
      control.project === config.project;
    console.log(
      JSON.stringify(
        {
          ready,
          permissions,
          computerUse: control.computerUse === true,
          model: config.model,
          gateway: base,
          next: ready
            ? 'start で依頼を作成できます。'
            : '--computer-use で起動し、システム設定のプライバシーとセキュリティで、このhelperの起動元のアクセシビリティ・画面収録を確認してください。',
        },
        null,
        2,
      ),
    );
    if (!ready) process.exitCode = 1;
    return;
  }
  const file = resolve(options.runFile);
  let record;
  if (options.command === 'start') {
    record = {
      version: 1,
      project: config.project,
      key: randomUUID(),
      request: {
        kind: 'computer.run',
        input: { goal: options.goal, successCriteria: options.criteria },
      },
      taskId: null,
    };
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else record = JSON.parse(await readFile(file, 'utf8'));
  if (record.project !== config.project)
    throw new Error('run-file と保存先が一致しません。元の --state-dir を指定してください。');
  const credentials = await client(base)('/v1/auth/dev/token', 'POST', {
    email: desktopEmail(config.identity),
    display_name: 'Genie Computer Use',
  });
  if (!credentials.access_token) throw new Error('Local authentication unavailable.');
  const result = await perform(
    options.command,
    record,
    client(base, credentials.access_token),
    options.approvalId,
  );
  await privateJSON(file, record);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
