import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { bind, compare, factsFrom, learnCorrections, loadRules, mentionsIn, merge, preview, render, saveRules } from '../src/workpreview/engine.js';
import { OFFICECLI, readUnits, setText } from '../src/workpreview/officecli.js';
import { WorkPreviewRuntime } from '../src/workpreview/runtime.js';
import { WorkPreviewResult } from '@genie/contracts';
import { realpath, writeFile } from 'node:fs/promises';

describe('binding numbers across a quote, a proposal and slides', () => {
  const book = [
    { path: '/Sheet1/A1', text: '品目' }, { path: '/Sheet1/B1', text: '数量' }, { path: '/Sheet1/D1', text: '金額' },
    { path: '/Sheet1/A2', text: '業務用端末' }, { path: '/Sheet1/B2', text: '100', value: '100' },
    { path: '/Sheet1/D2', text: '1200000', value: '1200000', formula: 'B2*C2' },
    { path: '/Sheet1/A4', text: '合計' }, { path: '/Sheet1/D4', text: '1300000', value: '1300000', formula: 'SUM(D2:D3)' },
  ];
  const facts = factsFrom('q.xlsx', book);

  it('names facts by their row and column headings', () => {
    expect(facts.map((f) => [f.label, f.kind])).toEqual([
      ['業務用端末の数量', 'quantity'], ['業務用端末の金額', 'money'], ['合計の金額', 'money'],
    ]);
  });

  it('binds 100台 to the quantity but not 100日間, and 130万円 to the total', () => {
    const units = [
      { path: 'p1', text: '本提案では業務用端末を100台導入します。' },
      { path: 'p2', text: '導入費用は合計1,300,000円（税抜）です。' },
      { path: 'p3', text: '納品後100日間の無償サポートを含みます。' },
      { path: 's1', text: '端末 100台 / 総額 130万円' },
    ];
    const { bindings } = bind(facts, units.flatMap((u) => mentionsIn('d', u)));
    expect(bindings.map((b) => `${b.mention.path}:${b.mention.raw}→${b.fact.label}`)).toEqual([
      'p1:100台→業務用端末の数量', 'p2:1,300,000円→合計の金額', 's1:100台→業務用端末の数量', 's1:130万円→合計の金額',
    ]);
  });

  it('writes the new value the way the document wrote it', () => {
    expect(render(1_540_000, 'comma')).toBe('1,540,000');
    expect(render(1_540_000, 'man')).toBe('154万');
    expect(render(1_545_000, 'man')).toBe('154.5万');
    expect(render(120, 'plain')).toBe('120');
  });
});

const haveCli = existsSync(OFFICECLI);

/** 見積り・提案書・説明の 3 ファイルを作る（端末 100 台 × 12,000 円 + 保守 100,000 円 = 1,300,000 円）。 */
async function makeCase(extraParagraphs: string[] = [], at?: string): Promise<{ dir: string; files: string[] }> {
  const dir = at ?? await mkdtemp(join(tmpdir(), 'genie-wp-'));
  await mkdir(dir, { recursive: true });
  const cli = (args: string[]) => execFileSync(OFFICECLI, args, { cwd: dir, stdio: 'pipe', env: { ...process.env, OFFICECLI_RESIDENT_FLUSH: 'each' } });
  cli(['create', 'q.xlsx']);
  cli(['batch', 'q.xlsx', '--commands', JSON.stringify([
    ...[['A1', '品目'], ['B1', '数量'], ['C1', '単価'], ['D1', '金額'], ['A2', '業務用端末'], ['B2', '100'], ['C2', '12000'],
        ['A3', '保守（年）'], ['B3', '1'], ['C3', '100000'], ['A4', '合計']]
      .map(([c, v]) => ({ command: 'set', path: `/Sheet1/${c}`, props: { value: v } })),
    ...[['D2', 'B2*C2'], ['D3', 'B3*C3'], ['D4', 'SUM(D2:D3)']]
      .map(([c, f]) => ({ command: 'set', path: `/Sheet1/${c}`, props: { formula: f } })),
  ])]);
  cli(['create', 'p.docx']);
  cli(['batch', 'p.docx', '--commands', JSON.stringify(['本提案では業務用端末を100台導入します。', '導入費用は合計1,300,000円（税抜）です。', '納品後100日間の無償サポートを含みます。', ...extraParagraphs]
    .map((text) => ({ command: 'add', parent: '/body', type: 'paragraph', props: { text } })))]);
  cli(['create', 's.pptx']);
  cli(['batch', 's.pptx', '--commands', JSON.stringify([{ command: 'add', parent: '/', type: 'slide', props: {} },
    ...['端末 100台 / 総額 130万円', 'サポート 100日'].map((text, i) => ({ command: 'add', parent: '/slide[1]', type: 'shape', props: { text, x: '1cm', y: `${2 + i * 3}cm`, width: '20cm', height: '2cm' } }))])]);
  return { dir, files: ['q.xlsx', 'p.docx', 's.pptx'].map((f) => join(dir, f)) };
}

const failures = (p: { checks: { name: string; ok: boolean; detail: string }[] }) => p.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

describe.skipIf(!haveCli)('A: previewing a change on real files (OfficeCLI)', () => {
  it('changes quantity 100→120 in all three files, recalculates, and touches nothing else', async () => {
    const { dir, files } = await makeCase();
    const originalDoc = await readFile(files[1]!);
    const result = await preview(files, { label: '業務用端末の数量', to: 120 }, join(dir, 'preview'));

    const texts = result.edits.map((e) => e.after);
    expect(texts).toContain('120');
    expect(texts).toContain('1540000');
    expect(texts).toContain('本提案では業務用端末を120台導入します。');
    expect(texts).toContain('導入費用は合計1,540,000円（税抜）です。');
    expect(texts).toContain('端末 120台 / 総額 154万円');
    expect(result.edits.some((e) => e.after.includes('100日'))).toBe(false);
    expect(failures(result)).toEqual([]);
    expect((await readFile(files[1]!)).equals(originalDoc), '原本は変えていない').toBe(true);
  }, 180_000);

  it('refuses to change a formula cell directly', async () => {
    const { dir, files } = await makeCase();
    await expect(preview(files, { cell: '/Sheet1/D4', to: 2_000_000 }, join(dir, 'x'))).rejects.toThrow(/式で計算/);
  }, 120_000);
});

describe.skipIf(!haveCli)('B: comparing variants and merging chosen parts', () => {
  it('lines up two variants, merges a consistent pick, and flags a mixed pick', async () => {
    const { dir, files } = await makeCase();
    const a = await preview(files, { label: '業務用端末の数量', to: 120 }, join(dir, 'a'));
    const b = await preview(files, { label: '業務用端末の数量', to: 150 }, join(dir, 'b'));

    const rows = compare([a, b]);
    const slide = rows.find((r) => r.file === 's.pptx')!;
    expect(slide.before).toBe('端末 100台 / 総額 130万円');
    expect(slide.options).toEqual(['端末 120台 / 総額 154万円', '端末 150台 / 総額 190万円']);

    // 見積りと説明は案 2、提案書も案 2 → すべて合う
    const good = await merge(files, [a, b], [{ variant: 1, file: 'q.xlsx' }, { variant: 1, file: 'p.docx' }, { variant: 1, file: 's.pptx' }], join(dir, 'm1'));
    expect(failures(good)).toEqual([]);
    expect(good.edits.map((e) => e.after)).toContain('1900000');

    // 見積りは案 2（150 台）、提案書は案 1（120 台）→ 整合の確認が落ち、どの文かを言う
    const mixed = await merge(files, [a, b], [{ variant: 1, file: 'q.xlsx' }, { variant: 0, file: 'p.docx' }, { variant: 1, file: 's.pptx' }], join(dir, 'm2'));
    const stale = mixed.checks.find((c) => c.name === '関係する箇所がすべて新しい値')!;
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain('120台');

    // 見積りだけ選ぶ → 文書が古いまま、と言う（勝手に直さない）
    const onlyBook = await merge(files, [a, b], [{ variant: 0, file: 'q.xlsx' }], join(dir, 'm3'));
    expect(onlyBook.checks.find((c) => c.name === '関係する箇所がすべて新しい値')!.ok).toBe(false);
    expect(onlyBook.checks.find((c) => c.name === '指定外を変えていない')!.ok).toBe(true);

    await expect(merge(files, [a, b], [{ variant: 2, file: 'q.xlsx' }], join(dir, 'm4'))).rejects.toThrow(/案3/);
  }, 300_000);
});

describe.skipIf(!haveCli)('C: corrections become checks', () => {
  it('learns "do not touch this sentence" and "write the total this way", then keeps them next time', async () => {
    // 「予備機 100台」は数量と同じ値だが、別の話。1 回目は直してしまう（人が戻す）
    const { dir, files } = await makeCase(['予備機として100台を別途保管します。']);
    const first = await preview(files, { label: '業務用端末の数量', to: 120 }, join(dir, 'first'));
    expect(first.edits.map((e) => e.after)).toContain('予備機として120台を別途保管します。');

    // 人の直し: 予備機の文を元に戻し、スライドの総額を円で書く
    const fixedDir = join(dir, 'fixed');
    const fixedFiles = await Promise.all(first.files.map(async (f) => { const to = join(fixedDir, basename(f)); await mkdir(fixedDir, { recursive: true }); await copyFile(f, to); return to; }));
    const reserve = first.edits.find((e) => e.after.startsWith('予備機'))!;
    await setText(join(fixedDir, 'p.docx'), reserve.path, reserve.before);
    const slide = first.edits.find((e) => e.file === 's.pptx')!;
    await setText(join(fixedDir, 's.pptx'), slide.path, '端末 120台 / 総額 1,540,000円');
    const learned = await learnCorrections(first, fixedFiles);
    expect(learned.unlearned).toEqual([]);
    expect(learned.rules.map((r) => [r.kind, r.file, r.text ?? r.style])).toEqual([
      ['keep', 'p.docx', '予備機として100台を別途保管します。'],
      ['style', 's.pptx', 'comma'],
    ]);
    const rulesFile = join(dir, 'rules.json');
    const rules = await saveRules(rulesFile, learned.rules);
    expect(await loadRules(rulesFile)).toEqual(rules);

    // 次の案（150 台）: 予備機の文はそのまま、スライドの総額は 1,900,000円
    const next = await preview(files, { label: '業務用端末の数量', to: 150 }, join(dir, 'next'), rules);
    expect(failures(next)).toEqual([]);
    expect(next.checks.some((c) => c.name === '以前の直しを守っている')).toBe(true);
    expect(next.edits.map((e) => e.after)).toContain('端末 150台 / 総額 1,900,000円');
    expect(next.edits.some((e) => e.after.startsWith('予備機'))).toBe(false);
  }, 300_000);

  it('reports corrections it cannot turn into a rule instead of dropping them', async () => {
    const { dir, files } = await makeCase();
    const first = await preview(files, { label: '業務用端末の数量', to: 120 }, join(dir, 'first'));
    const fixedDir = join(dir, 'fixed');
    await mkdir(fixedDir, { recursive: true });
    const fixedFiles = await Promise.all(first.files.map(async (f) => { const to = join(fixedDir, basename(f)); await copyFile(f, to); return to; }));
    const units = await readUnits(join(fixedDir, 'p.docx'));
    const support = units.find((u) => u.text.includes('100日間'))!;
    await setText(join(fixedDir, 'p.docx'), support.path, '納品後90日間の無償サポートを含みます。');
    const learned = await learnCorrections(first, fixedFiles);
    expect(learned.rules).toEqual([]);
    expect(learned.unlearned).toEqual(['p.docx:「納品後100日間の無償サポートを含みます。」→「納品後90日間の無償サポートを含みます。」']);
  }, 180_000);
});

describe.skipIf(!haveCli)('work.preview runner', () => {
  const step = (args: Record<string, unknown>) => ({ id: 's1', toolId: 'work.preview', args, approval: null });

  it('finds the latest case folder in the home, makes 案1 beside it, and reports checked facts', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'genie-home-')));
    await makeCase([], join(home, 'Documents', '古い案件'));
    await new Promise((r) => setTimeout(r, 50));
    const { dir } = await makeCase([], join(home, 'Desktop', 'A社', '端末更新'));
    await writeFile(join(home, 'Desktop', 'A社', 'memo.xlsx'), 'not a case');   // 文書の無いフォルダは案件ではない
    const runtime = new WorkPreviewRuntime({ home });
    expect(runtime.handles('work.preview')).toBe(true);

    const outcome = await runtime.run(step({ to: 120, subject: '端末' }));
    expect(outcome.ok, JSON.stringify(outcome.error)).toBe(true);
    const result = WorkPreviewResult.parse(outcome.result);
    expect(result.folder).toBe(dir);
    expect(result.previewDir).toBe(join(dir, 'Genie案', '案1_業務用端末の数量を120に'));
    expect(result.change).toEqual({ label: '業務用端末の数量', from: 100, to: 120 });
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.edits.map((e) => e.after)).toContain('端末 120台 / 総額 154万円');

    // 2 回目は 案2。案のフォルダは次の案件探しで案件に数えない
    const again = await runtime.run(step({ to: 150, subject: '端末' }));
    expect((await runtime.run(step({ to: 150 }))).error?.code, '数量が二つ（端末・保守）なら聞き返す').toBe('work.which');
    expect(WorkPreviewResult.parse(again.result).previewDir).toBe(join(dir, 'Genie案', '案2_業務用端末の数量を150に'));
  }, 300_000);

  it('refuses folders outside the home, unknown subjects, and the same value', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'genie-home-')));
    const { dir } = await makeCase([], join(home, 'Documents', '案件'));
    const runtime = new WorkPreviewRuntime({ home });
    expect((await runtime.run(step({ to: 120, folder: '/private/tmp' }))).error?.code).toBe('work.outside_home');
    expect((await runtime.run(step({ to: 120, folder: join(home, 'Library') }))).error?.code).toMatch(/work\.(outside_home|not_found)/);
    const which = await runtime.run(step({ to: 120, subject: 'プリンタ', folder: dir }));
    expect(which.error?.code).toBe('work.which');
    expect(which.error?.message).toContain('業務用端末の数量（100）');
    expect((await runtime.run(step({ to: 100, subject: '端末', folder: '~/Documents/案件' }))).error?.code).toBe('work.same');
    expect((await new WorkPreviewRuntime({ home: await mkdtemp(join(tmpdir(), 'genie-empty-')) }).run(step({ to: 1 }))).error?.code).toBe('work.no_case');
  }, 300_000);
});
