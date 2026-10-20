/**
 * 接続の状態を Mac アプリへ渡すファイル。**値は置かない**（接続の指紋と時刻だけ）。
 *
 * host は `security` でしかキーチェーンに書けず、アプリの項目へ書くとアプリが読めなくなる
 * （2026-10-16〜19）。だから「提供者が更新を断った」はキーチェーンではなく、ここで伝える。
 * アプリは自分の接続の指紋と比べ、同じときだけ「期限切れ」と出す。つなぎ直せば指紋が変わる。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONNECTOR_STATUS_PATH = join(
  homedir(),
  'Library/Application Support/Genie/connector-status.json',
);

export interface ConnectorStatusEntry {
  readonly fingerprint: string;
  readonly rejected_at: string;
}

export async function recordRenewalRejected(
  pluginId: string,
  connectorId: string,
  fingerprint: string,
  { path = CONNECTOR_STATUS_PATH, now = () => new Date() } = {},
): Promise<void> {
  let current: Record<string, ConnectorStatusEntry> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      current = parsed as Record<string, ConnectorStatusEntry>;
  } catch {
    /* 無い・壊れている。作り直す */
  }
  current[`${pluginId}/${connectorId}`] = { fingerprint, rejected_at: now().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
  await rename(temporary, path);
}
