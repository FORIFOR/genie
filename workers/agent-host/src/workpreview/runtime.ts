/**
 * `work.preview`: 「端末を120台にしたら、提案書とスライドも合わせた案を作って」。
 *
 * 守ること:
 *   - 扱うのはホームの下（ライブラリを除く）の案件フォルダだけ。原本は変えず、隣の「Genie案」に案を置く
 *   - どの数を変えるか決められないときは、勝手に選ばず、見積りにある数を挙げて聞き返す
 *   - 結果は確かめた事実だけ（どこを何から何へ・確認の合否・直していない文）
 */
import { existsSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkPreviewArgs, type WorkPreviewResult } from '@genie/contracts';
import type { HostStep, StepOutcome } from '../connector-steps.js';
import { factsFrom, loadRules, preview, type Fact } from './engine.js';
import { OFFICECLI, readUnits } from './officecli.js';

export interface WorkPreviewDeps {
  readonly home?: string;
}

const fail = (code: string, message: string): StepOutcome => ({ ok: false, error: { code: `work.${code}`, message } });
const OUTPUT = 'Genie案';
const SEARCH_ROOTS = ['Documents', 'Desktop', 'Downloads'];
const isDoc = (name: string) => /\.(?:xlsx|docx|pptx)$/iu.test(name) && !name.startsWith('~$') && !name.startsWith('.');

/** 案件フォルダの中の書類（直下だけ）。見積りが一つ、文書が一つ以上あるときだけ案件とみなす。 */
async function caseFiles(folder: string): Promise<string[] | null> {
  let names: string[];
  try { names = (await readdir(folder)).filter(isDoc); } catch { return null; }
  const books = names.filter((n) => n.toLowerCase().endsWith('.xlsx'));
  if (books.length !== 1 || names.length < 2) return null;
  return names.sort().map((n) => join(folder, n));
}

export class WorkPreviewRuntime {
  readonly #home: string;
  constructor(deps: WorkPreviewDeps = {}) {
    this.#home = deps.home ?? homedir();
  }

  handles(toolId: string): boolean {
    return toolId === 'work.preview';
  }

  async run(step: HostStep): Promise<StepOutcome> {
    const parsed = WorkPreviewArgs.safeParse(step.args);
    if (!parsed.success) return fail('invalid_args', '変える数を確認できませんでした。');
    if (!existsSync(OFFICECLI)) return fail('no_tool', '書類を読む道具（OfficeCLI）が入っていません。');
    const { to, subject } = parsed.data;

    const home = await realpath(this.#home);
    let folder: string;
    if (parsed.data.folder) {
      const expanded = parsed.data.folder.startsWith('~/') ? join(home, parsed.data.folder.slice(2)) : resolve(parsed.data.folder);
      try { folder = await realpath(expanded); } catch { return fail('not_found', 'その案件フォルダが見つかりません。'); }
      if (!folder.startsWith(`${home}/`) || folder.startsWith(`${home}/Library/`))
        return fail('outside_home', 'ホームフォルダの中の案件だけを扱えます（ライブラリは除く）。');
      if (!(await lstat(folder)).isDirectory()) return fail('not_found', '案件フォルダを指定してください。');
    } else {
      const found = await this.#latestCase(home);
      if (!found) return fail('no_case', '見積り（Excel）と提案書やスライドが一緒に入ったフォルダが、書類・デスクトップ・ダウンロードに見つかりません。');
      folder = found;
    }
    const files = await caseFiles(folder);
    if (!files) return fail('no_case', 'このフォルダには、見積り（Excel 一つ）と提案書かスライドがそろっていません。');

    const book = files.find((f) => f.toLowerCase().endsWith('.xlsx'))!;
    let facts: Fact[];
    try {
      facts = factsFrom(book.split('/').at(-1)!, await readUnits(book)).filter((f) => !f.formula && f.kind !== 'other');
    } catch (error) {
      return fail('unreadable', `見積りを読めませんでした（${String(error).slice(0, 120)}）。`);
    }
    const target = pick(facts, subject);
    if (!target)
      return fail('which', `どの数を変えるか決められませんでした。見積りにあるのは: ${facts.map((f) => `${f.label}（${f.value}）`).join('、') || 'なし'}。`);
    if (target.value === to) return fail('same', `${target.label} はもう ${to} です。`);

    const out = join(folder, OUTPUT);
    const rulesFile = join(out, '覚えた直し.json');
    const rules = await loadRules(rulesFile);
    const n = (await readdir(out).catch(() => [] as string[])).filter((d) => d.startsWith('案')).length + 1;
    const dir = join(out, `案${n}_${target.label}を${to}に`.replace(/[/:]/g, '・'));
    try {
      const p = await preview(files, { cell: target.path, to }, dir, rules);
      const result: WorkPreviewResult = {
        folder, previewDir: dir,
        change: { label: target.label, from: target.value, to },
        edits: p.edits.map((e) => ({ file: e.file, where: e.path, before: e.before, after: e.after, reason: e.reason })),
        checks: p.checks,
        needsReview: p.needsReview.map((m) => `${m.file}: ${m.raw}`),
        rules: rules.length,
        screenshots: p.screenshots,
      };
      return { ok: true, result };
    } catch (error) {
      return fail('failed', `案を作れませんでした（${String(error instanceof Error ? error.message : error).slice(0, 160)}）。原本は変えていません。`);
    }
  }

  /** 書類・デスクトップ・ダウンロード（2 段まで）から、書類をいちばん最近変えた案件フォルダ。 */
  async #latestCase(home: string): Promise<string | null> {
    let best: { folder: string; at: number } | null = null;
    const visit = async (dir: string, depth: number) => {
      const files = await caseFiles(dir);
      if (files) {
        const at = Math.max(...(await Promise.all(files.map(async (f) => (await stat(f)).mtimeMs))));
        if (!best || at > best.at) best = { folder: dir, at };
      }
      if (depth === 0) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries.slice(0, 200))
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== OUTPUT && !e.name.endsWith('.app')) await visit(join(dir, e.name), depth - 1);
    };
    for (const root of SEARCH_ROOTS) await visit(join(home, root), 2);
    return (best as { folder: string } | null)?.folder ?? null;
  }
}

/** 言われた「端末」に合う見積りの数。言われなければ、数量が一つだけのときそれ。 */
function pick(facts: Fact[], subject?: string): Fact | null {
  if (subject) {
    const hits = facts.filter((f) => f.label.includes(subject));
    const quantity = hits.filter((f) => f.kind === 'quantity');
    if (quantity.length === 1) return quantity[0]!;
    if (hits.length === 1) return hits[0]!;
    return null;
  }
  const quantities = facts.filter((f) => f.kind === 'quantity');
  return quantities.length === 1 ? quantities[0]! : null;
}
