/**
 * OfficeCLI（iOfficeAI/OfficeCLI, Apache-2.0）を呼ぶ薄い層。Office を入れずに .xlsx / .docx / .pptx を
 * 読み・書き・検査・描画する。保存済みファイルだけを扱う（開いている Office の未保存の内容には触れない）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const OFFICECLI = process.env['GENIE_OFFICECLI'] ?? '/opt/homebrew/bin/officecli';

export interface Unit {
  /** ファイル内の固定の住所（例: /Sheet1/B2, /body/p[@paraId=...], /slide[1]/shape[@id=...]） */
  readonly path: string;
  readonly text: string;
  /** Excel のセルだけ: 式（あれば）と計算後の値 */
  readonly formula?: string;
  readonly value?: string;
}

async function run(args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec(OFFICECLI, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, OFFICECLI_RESIDENT_FLUSH: 'each' } });
  return stdout;
}

async function json<T>(args: string[]): Promise<T> {
  const out = await run([...args, '--json']);
  const parsed = JSON.parse(out) as { success: boolean; data: T; error?: unknown };
  if (!parsed.success) throw new Error(`officecli ${args[0]} failed: ${JSON.stringify(parsed.error ?? parsed.data).slice(0, 200)}`);
  return parsed.data;
}

interface QueryResult {
  results: { path: string; text?: string; format?: { formula?: string; computedValue?: string; cachedValue?: string } }[];
}

/** ファイルを、変更の単位（セル・段落・図形）の並びとして読む。 */
export async function readUnits(file: string): Promise<Unit[]> {
  if (file.endsWith('.xlsx')) {
    const data = await json<QueryResult>(['query', file, 'cell']);
    return data.results
      .map((r) => ({
        path: r.path,
        text: r.format?.computedValue ?? r.text ?? '',
        ...(r.format?.formula ? { formula: r.format.formula } : {}),
        value: r.format?.computedValue ?? r.format?.cachedValue ?? r.text ?? '',
      }))
      .filter((u) => u.text !== '');
  }
  const selector = file.endsWith('.docx') ? 'paragraph' : 'shape';
  const data = await json<QueryResult>(['query', file, selector]);
  return data.results.map((r) => ({ path: r.path, text: r.text ?? '' })).filter((u) => u.text !== '');
}

export async function setText(file: string, path: string, text: string): Promise<void> {
  await json(['set', file, path, '--prop', `text=${text}`]);
}

export async function setCell(file: string, path: string, value: string): Promise<void> {
  await json(['set', file, path, '--prop', `value=${value}`]);
}

export async function validate(file: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const out = await run(['validate', file]);
    return { ok: /Validation passed/.test(out), detail: out.trim().slice(0, 300) };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 300) };
  }
}

/** 1 ページ目（Excel は表、PowerPoint は 1 枚目）を PNG にする。描画できたかの確認と、比較の画面用。 */
export async function screenshot(file: string, out: string): Promise<boolean> {
  try {
    await run(['view', file, 'screenshot', '-o', out], 120_000);
    return true;
  } catch {
    return false;
  }
}
