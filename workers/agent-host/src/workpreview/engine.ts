/**
 * 仕事プレビュー: 見積り（Excel）・提案書（Word）・説明（PowerPoint）を一つの案件として扱い、
 * 条件の変更を**コピーの上で**試し、関係する箇所だけを直し、整合と「指定外を変えていない」ことを確かめる。
 *
 *   A. 試す     … preview: Excel の数を変え、式で再計算された値を、文書の中の同じ数へ同じ書き方で写す
 *   B. 選ぶ     … compare / merge: 複数の案を並べ、選んだ部分だけを原本のコピーへ取り込み、もう一度確かめる
 *   C. 覚える   … learnCorrections: 人が直した箇所を規則（直さない文・書き方）にし、次の案から確かめる
 *
 * 結ぶ規則: Excel の見出しつきの数（「業務用端末の数量」「合計の金額」）と、単位の合う文中の数だけを結ぶ
 * （数量 ↔ 台・個…、金額 ↔ 円・万円）。「100日間」は数量ではない。同じ値の事実が二つあれば結ばず「確認が要る」へ。
 * 原本は変えない。
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readUnits, screenshot, setCell, setText, validate, type Unit } from './officecli.js';

export type FactKind = 'quantity' | 'money' | 'other';
export type Style = 'plain' | 'comma' | 'man';

export interface Fact {
  /** ファイル名（案件の中で一意） */
  readonly file: string;
  readonly path: string;
  /** 「業務用端末の数量」「合計の金額」 */
  readonly label: string;
  readonly kind: FactKind;
  readonly value: number;
  readonly formula?: string;
}

export interface Mention {
  readonly file: string;
  readonly path: string;
  /** 単位の中での位置（文字） */
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly value: number;
  readonly unit: string;
  readonly style: Style;
}

export interface Binding {
  readonly mention: Mention;
  readonly fact: Fact;
}

export interface Edit {
  readonly file: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  /** 文書に書いた数（どの事実を、どの書き方で）。直しから学ぶときに使う */
  readonly wrote?: { readonly fact: string; readonly unit: string; readonly value: number; readonly style: Style }[];
}

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** 人の直しから覚えた規則。keep: この文は数が合っても変えない。style: この事実はこの書き方で書く。 */
export interface Rule {
  readonly id: string;
  readonly kind: 'keep' | 'style';
  readonly file: string;
  readonly text?: string;
  readonly fact?: string;
  readonly unit?: string;
  readonly style?: Style;
  /** どの直しから覚えたか（人に見せる） */
  readonly from: string;
}

export interface Preview {
  readonly dir: string;
  readonly files: string[];
  readonly edits: Edit[];
  readonly checks: Check[];
  /** 数は合うが、どの事実か決められなかった箇所（直していない） */
  readonly needsReview: Mention[];
  readonly screenshots: string[];
  readonly bindings: Binding[];
}

export const passed = (p: Pick<Preview, 'checks'>): boolean => p.checks.every((c) => c.ok);

const QUANTITY_HEADERS = /数量|台数|個数|件数|人数|本数/u;
const MONEY_HEADERS = /金額|単価|合計|価格|費用|料金|総額|小計/u;
const COUNTERS = /^(台|個|件|名|本|人|セット|式|ライセンス|枚)$/u;
const MENTION = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(万)?(円|台|個|件|名|本|人|日間|日|ヶ月|か月|年|%|セット|式|ライセンス|枚)?/gu;
const key = (file: string, path: string) => `${file}\u0000${path}`;

/** Excel の見出しつきの数を「事実」として読む（1 行目が列の見出し、A 列が行の見出し）。 */
export function factsFrom(file: string, units: Unit[]): Fact[] {
  const at = new Map(units.map((u) => [u.path, u]));
  const facts: Fact[] = [];
  for (const u of units) {
    const m = /^\/([^/]+)\/([A-Z]+)(\d+)$/.exec(u.path);
    if (!m) continue;
    const [, sheet, col, rowText] = m;
    const row = Number(rowText);
    if (row < 2 || col === 'A') continue;
    const raw = (u.value ?? u.text).trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value)) continue;
    const header = at.get(`/${sheet}/${col}1`)?.text ?? '';
    const rowLabel = at.get(`/${sheet}/A${row}`)?.text ?? '';
    const kind: FactKind = QUANTITY_HEADERS.test(header) ? 'quantity' : MONEY_HEADERS.test(header) || /合計|総額/u.test(rowLabel) ? 'money' : 'other';
    facts.push({ file, path: u.path, label: `${rowLabel}の${header}`, kind, value, ...(u.formula ? { formula: u.formula } : {}) });
  }
  return facts;
}

/** 文の中の数（単位つき）を拾う。 */
export function mentionsIn(file: string, unit: Pick<Unit, 'path' | 'text'>): Mention[] {
  const out: Mention[] = [];
  for (const m of unit.text.matchAll(MENTION)) {
    const [raw, digits, man, suffix] = m;
    const base = Number(digits!.replace(/,/g, ''));
    out.push({
      file, path: unit.path, start: m.index!, end: m.index! + raw!.length, raw: raw!,
      value: man ? base * 10_000 : base, unit: suffix ?? '',
      style: man ? 'man' : digits!.includes(',') ? 'comma' : 'plain',
    });
  }
  return out;
}

function compatible(fact: Fact, mention: Mention): boolean {
  if (fact.kind === 'quantity') return COUNTERS.test(mention.unit);
  if (fact.kind === 'money') return mention.unit === '円';
  return false;
}

/** 文の中の数を事実に結ぶ。同じ値・同じ種類の事実が二つ以上あるときは結ばない（あいまい）。 */
export function bind(facts: Fact[], mentions: Mention[]): { bindings: Binding[]; ambiguous: Mention[] } {
  const bindings: Binding[] = [];
  const ambiguous: Mention[] = [];
  for (const mention of mentions) {
    const candidates = facts.filter((f) => f.value === mention.value && compatible(f, mention));
    if (candidates.length === 1) bindings.push({ mention, fact: candidates[0]! });
    else if (candidates.length > 1) ambiguous.push(mention);
  }
  return { bindings, ambiguous };
}

/** 元の書き方のまま、新しい値を書く（1,540,000 / 154万 / 120）。 */
export function render(value: number, style: Style): string {
  if (style === 'man') {
    const man = value / 10_000;
    return `${Number.isInteger(man) ? man : man.toFixed(1)}万`;
  }
  return style === 'comma' ? value.toLocaleString('en-US') : String(value);
}

export interface Change {
  /** 変える Excel のセル（例: /Sheet1/B2）。label でも指定できる（「業務用端末の数量」）。 */
  readonly cell?: string;
  readonly label?: string;
  readonly to: number;
}

// ---------------------------------------------------------------- 共通の手順

type Snapshot = Map<string, Unit[]>;

async function copyInto(files: string[], dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const names = files.map((f) => basename(f));
  if (new Set(names).size !== names.length) throw new Error('同じ名前のファイルが二つあります');
  const copies: string[] = [];
  for (const f of files) {
    const copy = join(dir, basename(f));
    await copyFile(f, copy);
    copies.push(copy);
  }
  return copies;
}

async function readAll(files: string[]): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  for (const f of files) snap.set(basename(f), await readUnits(f));
  return snap;
}

function workbookOf(files: string[]): string {
  const books = files.filter((f) => f.endsWith('.xlsx'));
  if (books.length !== 1) throw new Error(books.length ? '見積り（.xlsx）は一つにしてください' : '見積り（.xlsx）がありません');
  return books[0]!;
}

function styleRule(rules: Rule[], b: Binding): Style | undefined {
  return rules.find((r) => r.kind === 'style' && r.file === b.mention.file && r.fact === b.fact.label && r.unit === b.mention.unit)?.style;
}

interface Plan { bindings: Binding[]; ambiguous: Mention[]; kept: Set<string> }

function analyse(before: Snapshot, facts: Fact[], rules: Rule[]): Plan {
  const kept = new Set<string>();
  const mentions: Mention[] = [];
  for (const [file, units] of before) {
    if (file.endsWith('.xlsx')) continue;
    for (const u of units) {
      if (rules.some((r) => r.kind === 'keep' && r.file === file && r.text === u.text)) { kept.add(key(file, u.path)); continue; }
      mentions.push(...mentionsIn(file, u));
    }
  }
  return { ...bind(facts, mentions), kept };
}

function cellEdits(book: string, before: Fact[], after: Map<string, Fact>, requested: string | null, skip = new Set<string>()): Edit[] {
  const edits: Edit[] = [];
  for (const f of before) {
    const now = after.get(f.path);
    if (!now || now.value === f.value || skip.has(key(book, f.path))) continue;
    edits.push({ file: book, path: f.path, before: String(f.value), after: String(now.value),
                 reason: f.path === requested ? '依頼された変更' : f.formula ? `式（${f.formula}）の再計算` : '選んだ案の値' });
  }
  return edits;
}

async function factsOf(workbook: string): Promise<Map<string, Fact>> {
  return new Map(factsFrom(basename(workbook), await readUnits(workbook)).map((f) => [f.path, f]));
}

/** 結ばれた箇所を、新しい値で、同じ書き方（または覚えた書き方）に書き直す。 */
async function writeMentions(dir: string, before: Snapshot, bindings: Binding[], after: Map<string, Fact>, rules: Rule[]): Promise<Edit[]> {
  const byUnit = new Map<string, Binding[]>();
  for (const b of bindings) {
    const now = after.get(b.fact.path);
    if (!now || (now.value === b.fact.value && !styleRule(rules, b))) continue;
    const k = key(b.mention.file, b.mention.path);
    byUnit.set(k, [...(byUnit.get(k) ?? []), b]);
  }
  const edits: Edit[] = [];
  for (const [k, list] of byUnit) {
    const [file, path] = k.split('\u0000') as [string, string];
    const original = before.get(file)!.find((u) => u.path === path)!.text;
    let text = original;
    const wrote: NonNullable<Edit['wrote']> = [];
    for (const b of [...list].sort((a, c) => c.mention.start - a.mention.start)) {
      const value = after.get(b.fact.path)!.value;
      const style = styleRule(rules, b) ?? b.mention.style;
      text = text.slice(0, b.mention.start) + render(value, style) + b.mention.unit + text.slice(b.mention.end);
      wrote.unshift({ fact: b.fact.label, unit: b.mention.unit, value, style });
    }
    if (text === original) continue;
    await setText(join(dir, file), path, text);
    edits.push({ file, path, before: original, after: text, reason: `${[...new Set(list.map((b) => b.fact.label))].join('・')} に合わせた`, wrote });
  }
  return edits;
}

/** 確かめる: 関係する箇所が新しい値か・指定外を変えていないか・覚えた直しを守っているか・形式・描画。 */
async function verify(files: string[], before: Snapshot, plan: Plan, after: Map<string, Fact>, edits: Edit[], rules: Rule[]) {
  const checks: Check[] = [];
  const now = await readAll(files);
  const unitOf = (file: string, path: string) => now.get(file)?.find((u) => u.path === path);

  const stale: string[] = [];
  for (const b of plan.bindings) {
    const value = after.get(b.fact.path)?.value;
    const unit = unitOf(b.mention.file, b.mention.path);
    if (value === undefined || !unit || !mentionsIn(b.mention.file, unit).some((m) => m.value === value && m.unit === b.mention.unit))
      stale.push(`${b.mention.file} の「${unit?.text ?? b.mention.raw}」（${b.fact.label} は ${value}）`);
  }
  checks.push({ name: '関係する箇所がすべて新しい値', ok: stale.length === 0, detail: stale.length ? `合っていない: ${stale.join('、')}` : `${plan.bindings.length} 箇所` });

  const allowed = new Set(edits.map((e) => key(e.file, e.path)));
  const touched: string[] = [];
  for (const [file, units] of before) {
    const was = new Map(units.map((u) => [u.path, u.text]));
    const is = new Map((now.get(file) ?? []).map((u) => [u.path, u.text]));
    for (const path of new Set([...was.keys(), ...is.keys()]))
      if (was.get(path) !== is.get(path) && !allowed.has(key(file, path))) touched.push(`${file} ${path}`);
  }
  checks.push({ name: '指定外を変えていない', ok: touched.length === 0, detail: touched.length ? touched.join(', ') : `変えたのは ${edits.length} 箇所だけ` });

  if (rules.length) {
    const broken: string[] = [];
    for (const k of plan.kept) {
      const [file, path] = k.split('\u0000') as [string, string];
      const was = before.get(file)!.find((u) => u.path === path)!.text;
      if (unitOf(file, path)?.text !== was) broken.push(`「${was}」を変えた`);
    }
    for (const b of plan.bindings) {
      const style = styleRule(rules, b);
      const value = after.get(b.fact.path)?.value;
      const unit = unitOf(b.mention.file, b.mention.path);
      if (style && unit && !mentionsIn(b.mention.file, unit).some((m) => m.value === value && m.unit === b.mention.unit && m.style === style))
        broken.push(`${b.mention.file} の ${b.fact.label} の書き方`);
    }
    checks.push({ name: '以前の直しを守っている', ok: broken.length === 0, detail: broken.length ? broken.join('、') : `${rules.length} 件の規則` });
  }

  const screenshots: string[] = [];
  for (const f of files) {
    const v = await validate(f);
    checks.push({ name: `${basename(f)} の形式`, ok: v.ok, detail: v.detail });
    const png = `${f}.png`;
    const drawn = await screenshot(f, png);
    if (drawn) screenshots.push(png);
    checks.push({ name: `${basename(f)} を描画できる`, ok: drawn, detail: drawn ? png : '描画に失敗' });
  }
  return { checks, screenshots };
}

// ---------------------------------------------------------------- A. 試す

/** 案件のファイル（見積り・提案書・説明）で、変更をコピーの上で試す。原本は変えない。 */
export async function preview(files: string[], change: Change, dir: string, rules: Rule[] = []): Promise<Preview> {
  const copies = await copyInto(files, dir);
  const workbook = workbookOf(copies);
  const book = basename(workbook);
  const before = await readAll(copies);
  const factsBefore = factsFrom(book, before.get(book)!);
  const target = factsBefore.find((f) => (change.cell ? f.path === change.cell : f.label === change.label));
  if (!target) throw new Error(`変える数が見つかりません（${change.cell ?? change.label}）`);
  if (target.formula) throw new Error(`${target.label} は式で計算されるセルです。元の数を変えてください`);

  const plan = analyse(before, factsBefore, rules);
  await setCell(workbook, target.path, String(change.to));
  const after = await factsOf(workbook);
  const edits = cellEdits(book, factsBefore, after, target.path);
  edits.push(...await writeMentions(dir, before, plan.bindings, after, rules));
  const { checks, screenshots } = await verify(copies, before, plan, after, edits, rules);
  return { dir, files: copies, edits, checks, needsReview: plan.ambiguous, screenshots, bindings: plan.bindings };
}

// ---------------------------------------------------------------- B. 選ぶ

export interface ComparisonRow {
  readonly file: string;
  readonly path: string;
  readonly before: string;
  /** 案ごとの後の文（その案で変えていなければ null） */
  readonly options: (string | null)[];
}

/** 案を並べる: 少なくとも一つの案で変わった単位ごとに、元の文と各案の文。 */
export function compare(variants: Preview[]): ComparisonRow[] {
  const rows = new Map<string, { file: string; path: string; before: string; options: (string | null)[] }>();
  variants.forEach((v, i) => {
    for (const e of v.edits) {
      const k = key(e.file, e.path);
      const row = rows.get(k) ?? { file: e.file, path: e.path, before: e.before, options: variants.map(() => null) };
      row.options[i] = e.after;
      rows.set(k, row);
    }
  });
  return [...rows.values()];
}

export interface Choice {
  /** 何番目の案（0 から） */
  readonly variant: number;
  readonly file: string;
  /** 省くとそのファイルの変更すべて */
  readonly path?: string;
}

/**
 * 選んだ部分だけを原本のコピーへ取り込み、もう一度すべて確かめる。
 * 見積りの数と文書の数を別々の案から選ぶと、整合の確認が落ちる（それを人に見せるのが目的）。
 */
export async function merge(originals: string[], variants: Preview[], choices: Choice[], dir: string, rules: Rule[] = []): Promise<Preview> {
  const copies = await copyInto(originals, dir);
  const workbook = workbookOf(copies);
  const book = basename(workbook);
  const before = await readAll(copies);
  const factsBefore = factsFrom(book, before.get(book)!);
  const plan = analyse(before, factsBefore, rules);

  const edits: Edit[] = [];
  const chosen = new Set<string>();
  for (const choice of choices) {
    const v = variants[choice.variant];
    if (!v) throw new Error(`案${choice.variant + 1} はありません`);
    const picked = v.edits.filter((e) => e.file === choice.file && (!choice.path || e.path === choice.path));
    if (!picked.length) throw new Error(`案${choice.variant + 1} の ${choice.file}${choice.path ? ` ${choice.path}` : ''} には変更がありません`);
    for (const e of picked) {
      if (chosen.has(key(e.file, e.path))) throw new Error(`${e.file} ${e.path} を二つの案から選んでいます`);
      chosen.add(key(e.file, e.path));
      if (e.file === book) {
        if (factsBefore.find((f) => f.path === e.path)?.formula) continue;   // 式のセルは再計算に任せる
        await setCell(workbook, e.path, e.after);
      } else {
        await setText(join(dir, e.file), e.path, e.after);
      }
      edits.push({ ...e, reason: `案${choice.variant + 1}から: ${e.reason}` });
    }
  }
  const after = await factsOf(workbook);
  edits.push(...cellEdits(book, factsBefore, after, null, new Set(edits.filter((e) => e.file === book && !factsBefore.find((f) => f.path === e.path)?.formula).map((e) => key(e.file, e.path)))));
  // 式のセルを選んだ記録は、再計算の記録と重ねない
  const unique = [...new Map(edits.map((e) => [key(e.file, e.path), e])).values()];
  const { checks, screenshots } = await verify(copies, before, plan, after, unique, rules);
  return { dir, files: copies, edits: unique, checks, needsReview: plan.ambiguous, screenshots, bindings: plan.bindings };
}

// ---------------------------------------------------------------- C. 覚える

const ruleId = (r: Omit<Rule, 'id' | 'from'>) => createHash('sha1').update(JSON.stringify([r.kind, r.file, r.text, r.fact, r.unit])).digest('hex').slice(0, 12);

/**
 * 案（preview / merge の結果）と、人がそれを直したファイルを比べ、次から確かめる規則にする。
 * - 変えた文を元に戻した → keep（その文は数が合っても変えない）
 * - 書いた数の書き方を変えた（1,540,000円 → 154万円）→ style
 * それ以外の直しは規則にできないので unlearned で返す（黙って捨てない）。
 */
export async function learnCorrections(p: Preview, corrected: string[]): Promise<{ rules: Rule[]; unlearned: string[] }> {
  const generated = await readAll(p.files);
  const fixed = await readAll(corrected);
  const rules: Rule[] = [];
  const unlearned: string[] = [];
  for (const [file, units] of fixed) {
    const ours = new Map((generated.get(file) ?? []).map((u) => [u.path, u.text]));
    for (const u of units) {
      const was = ours.get(u.path);
      if (was === u.text) continue;
      const edit = p.edits.find((e) => e.file === file && e.path === u.path);
      const note = `${file}:「${was ?? ''}」→「${u.text}」`;
      if (edit && !file.endsWith('.xlsx') && u.text === edit.before) {
        const r = { kind: 'keep' as const, file, text: edit.before };
        rules.push({ ...r, id: ruleId(r), from: note });
        continue;
      }
      let learned = false;
      for (const w of edit?.wrote ?? []) {
        const theirs = mentionsIn(file, u).find((m) => m.value === w.value && m.unit === w.unit);
        if (theirs && theirs.style !== w.style) {
          const r = { kind: 'style' as const, file, fact: w.fact, unit: w.unit, style: theirs.style };
          rules.push({ ...r, id: ruleId(r), from: note });
          learned = true;
        }
      }
      if (!learned) unlearned.push(note);
    }
  }
  return { rules, unlearned };
}

export async function loadRules(file: string): Promise<Rule[]> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Rule[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** 規則を足す。同じ事実の書き方は新しい直しで置き換える。 */
export async function saveRules(file: string, added: Rule[]): Promise<Rule[]> {
  const all = new Map((await loadRules(file)).map((r) => [r.id, r]));
  for (const r of added) all.set(r.id, r);
  const rules = [...all.values()];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(rules, null, 2), { mode: 0o600 });
  return rules;
}
