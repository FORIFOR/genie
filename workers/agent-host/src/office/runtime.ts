/**
 * `office.edit`: 手元の Word / Excel を、頼まれたとおりに直した**別名のコピー**を作る。
 *
 * 守ること:
 *   - **原本は書き換えない。**同じフォルダに「（Genie編集）」を付けた新しいファイルを作る。
 *     同名があれば番号を足す。既存のファイルは上書きしない
 *   - 読めるのはホームの下の .docx / .xlsx だけ（~/Library は除く）
 *   - モデルには本文を**データとして**渡す。文書の中の指示には従わせない
 *   - 案のうち形の合わないものは書かず、書かなかったと返す
 *   - 書いた後に読み直し、壊れていないことを確かめてから「できた」と言う
 */
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { OfficeEditArgs, type OfficeChange, type OfficeEditResult } from '@genie/contracts';
import type { HostStep, StepOutcome } from '../connector-steps.js';
import { applyDocxEdits, readParagraphs, type DocxEdit } from './docx.js';
import {
  forceRecalculation,
  isCellRef,
  readCells,
  setCell,
  sharedStringsOf,
  sheetsOf,
  type XlsxEdit,
} from './xlsx.js';
import { excerpt } from './xml.js';
import { entryData, readZip, replacedEntry, writeZip, type ZipEntry } from './zip.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EDITS = 200;
const OUTLINE_CHARS = 40_000;

export type OfficeAsk = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export interface OfficeEditDeps {
  /** 変更の案を出すモデル（端末の言語モデル）。 */
  readonly ask: OfficeAsk;
  readonly home?: string;
}

class OfficeEditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class OfficeEditRuntime {
  readonly #deps: OfficeEditDeps;
  constructor(deps: OfficeEditDeps) {
    this.#deps = deps;
  }

  handles(toolId: string): boolean {
    return toolId === 'office.edit';
  }

  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    try {
      const parsed = OfficeEditArgs.safeParse(step.args);
      if (!parsed.success)
        throw new OfficeEditError(
          'office.invalid_args',
          '編集するファイルと内容を確認できませんでした。',
        );
      return { ok: true, result: await this.#edit(parsed.data, signal) };
    } catch (error) {
      if (error instanceof OfficeEditError)
        return { ok: false, error: { code: error.code, message: error.message } };
      return {
        ok: false,
        error: {
          code: 'office.unreadable',
          message: 'ファイルを Word / Excel 文書として読めませんでした。原本は変えていません。',
        },
      };
    }
  }

  async #edit(args: OfficeEditArgs, signal?: AbortSignal): Promise<OfficeEditResult> {
    const source = await this.#locate(args.path);
    const format = extname(source).toLowerCase() === '.docx' ? 'docx' : 'xlsx';
    const entries = readZip(await readFile(source));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const text = (name: string): string | null => {
      const entry = byName.get(name);
      return entry ? entryData(entry).toString('utf8') : null;
    };

    signal?.throwIfAborted();
    if (format === 'docx') {
      const documentXml = text('word/document.xml');
      if (documentXml === null)
        throw new OfficeEditError(
          'office.unreadable',
          'Word 文書の本文が見つかりません。原本は変えていません。',
        );
      const paragraphs = readParagraphs(documentXml);
      const outline = limitOutline(
        paragraphs.map(
          (p) =>
            `[${p.index}]${p.editable ? '' : ' (図・入れ子を含むため書き換え不可)'} ${p.text.trim() ? excerpt(p.text, 300) : '(空行)'}`,
        ),
      );
      const reply = await this.#propose({ format, instruction: args.instruction, outline }, signal);
      const { edits, skipped } = docxEditsOf(reply);
      const result = applyDocxEdits(documentXml, edits);
      const changes = result.applied.map((edit): OfficeChange => {
        const before = paragraphs[edit.index]?.text ?? '';
        if (edit.op === 'replace')
          return {
            where: `段落 ${edit.index + 1}`,
            before: excerpt(before),
            after: excerpt(edit.text),
          };
        if (edit.op === 'delete')
          return { where: `段落 ${edit.index + 1}`, before: excerpt(before), after: '（削除）' };
        return { where: `段落 ${edit.index + 1} の後`, before: '', after: excerpt(edit.text) };
      });
      const output =
        changes.length > 0
          ? await this.#write(source, entries, new Map([['word/document.xml', result.xml]]), format)
          : null;
      return {
        format,
        source,
        output,
        summary: summaryOf(reply),
        changes,
        skipped: [...skipped, ...result.skipped],
      };
    }

    const workbookXml = text('xl/workbook.xml');
    const relsXml = text('xl/_rels/workbook.xml.rels');
    if (workbookXml === null || relsXml === null)
      throw new OfficeEditError(
        'office.unreadable',
        'Excel ブックの構成が見つかりません。原本は変えていません。',
      );
    const sheets = sheetsOf(workbookXml, relsXml);
    const shared = sharedStringsOf(text('xl/sharedStrings.xml'));
    const sheetXml = new Map(sheets.map((sheet) => [sheet.name, text(sheet.part)]));
    const outline = limitOutline(
      sheets
        .slice(0, 20)
        .flatMap((sheet) => [
          `## シート "${sheet.name}"`,
          ...readCells(sheetXml.get(sheet.name) ?? '', shared, 1500).map(
            (cell) => `${cell.ref}: ${excerpt(cell.display, 120)}`,
          ),
        ]),
    );
    const reply = await this.#propose({ format, instruction: args.instruction, outline }, signal);
    const { edits, skipped } = xlsxEditsOf(reply, new Set(sheets.map((sheet) => sheet.name)));
    const changes: OfficeChange[] = [];
    const touched = new Map<string, string>();
    for (const edit of edits) {
      const sheet = sheets.find((candidate) => candidate.name === edit.sheet)!;
      const current = touched.get(sheet.part) ?? sheetXml.get(sheet.name);
      if (current == null) {
        skipped.push(`シート "${edit.sheet}" を読めませんでした`);
        continue;
      }
      const beforeCell = readCells(current, shared).find((cell) => cell.ref === edit.cell);
      const next = setCell(current, edit.cell, edit.value);
      touched.set(sheet.part, next.xml);
      changes.push({
        where: `${edit.sheet}!${edit.cell}`,
        before: excerpt(beforeCell?.display ?? ''),
        after: edit.value === null ? '（空）' : excerpt(String(edit.value)),
      });
    }
    let output: string | null = null;
    if (changes.length > 0) {
      touched.set('xl/workbook.xml', forceRecalculation(workbookXml));
      output = await this.#write(source, entries, touched, format);
    }
    return { format, source, output, summary: summaryOf(reply), changes, skipped };
  }

  async #propose(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#deps.ask(args, signal);
    } catch (error) {
      const reason =
        error instanceof Error && error.message ? `（${excerpt(error.message, 200)}）` : '';
      throw new OfficeEditError(
        'office.model_failed',
        `変更の案を作れませんでした${reason}。原本は変えていません。`,
      );
    }
  }

  /** 読んでよいファイルか。ホームの下・Library の外・普通のファイル・大きさ。 */
  async #locate(path: string): Promise<string> {
    const home = this.#deps.home ?? homedir();
    const expanded = path.startsWith('~/') ? join(home, path.slice(2)) : resolve(path);
    let real: string;
    try {
      real = await realpath(expanded);
    } catch {
      throw new OfficeEditError(
        'office.not_found',
        'ファイルが見つかりません。場所を確認してください。',
      );
    }
    const realHome = await realpath(home);
    if (!real.startsWith(`${realHome}/`) || real.startsWith(`${realHome}/Library/`))
      throw new OfficeEditError(
        'office.outside_home',
        'ホームフォルダの中の書類だけを編集できます（ライブラリは除く）。',
      );
    const ext = extname(real).toLowerCase();
    if (ext !== '.docx' && ext !== '.xlsx')
      throw new OfficeEditError(
        'office.unsupported',
        'Word（.docx）か Excel（.xlsx）のファイルを指定してください。',
      );
    const info = await lstat(real);
    if (!info.isFile()) throw new OfficeEditError('office.not_found', 'ファイルが見つかりません。');
    if (info.size > MAX_FILE_BYTES)
      throw new OfficeEditError('office.too_large', 'ファイルが大きすぎます（25MB まで）。');
    return real;
  }

  /** 別名で書き、読み直して確かめる。確かめられなければ消して、失敗と言う。 */
  async #write(
    source: string,
    entries: readonly ZipEntry[],
    replacements: ReadonlyMap<string, string>,
    format: 'docx' | 'xlsx',
  ): Promise<string> {
    const updated = entries
      // 計算順の記録は式を変えると古くなる。外して、開いたときに作り直させる。
      .filter((entry) => !(format === 'xlsx' && entry.name === 'xl/calcChain.xml'))
      .map((entry) => {
        let next = replacements.get(entry.name);
        if (format === 'xlsx' && entry.name === '[Content_Types].xml')
          next = entryData(entry)
            .toString('utf8')
            .replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, '');
        if (format === 'xlsx' && entry.name === 'xl/_rels/workbook.xml.rels')
          next = entryData(entry)
            .toString('utf8')
            .replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/, '');
        return next === undefined ? entry : replacedEntry(entry, Buffer.from(next, 'utf8'));
      });
    const bytes = writeZip(updated);

    const ext = extname(source);
    const stem = basename(source, ext);
    for (let n = 1; n < 100; n++) {
      const output = join(dirname(source), `${stem}（Genie編集${n === 1 ? '' : ` ${n}`}）${ext}`);
      let handle;
      try {
        handle = await open(
          output,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw new OfficeEditError(
          'office.write_failed',
          '編集したコピーを保存できませんでした。原本は変えていません。',
        );
      }
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      try {
        verifyWritten(await readFile(output), format);
      } catch {
        await unlink(output).catch(() => undefined);
        throw new OfficeEditError(
          'office.write_failed',
          '編集したコピーを確かめられなかったので消しました。原本は変えていません。',
        );
      }
      return output;
    }
    throw new OfficeEditError(
      'office.write_failed',
      '同じ名前のコピーが多すぎます。不要なコピーを整理してください。',
    );
  }
}

function verifyWritten(bytes: Buffer, format: 'docx' | 'xlsx'): void {
  const entries = readZip(bytes);
  for (const entry of entries) entryData(entry);
  const find = (name: string): string =>
    entryData(entries.find((entry) => entry.name === name)!).toString('utf8');
  if (format === 'docx') readParagraphs(find('word/document.xml'));
  else sheetsOf(find('xl/workbook.xml'), find('xl/_rels/workbook.xml.rels'));
}

function limitOutline(lines: readonly string[]): string {
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > OUTLINE_CHARS) return `${out}(以降は長いため省略)\n`;
    out += `${line}\n`;
  }
  return out;
}

function summaryOf(reply: unknown): string {
  const summary = (reply as { summary?: unknown } | null)?.summary;
  return typeof summary === 'string' ? excerpt(summary, 1000) : '';
}

function editsOf(reply: unknown): unknown[] {
  const edits = (reply as { edits?: unknown } | null)?.edits;
  return Array.isArray(edits) ? edits.slice(0, MAX_EDITS + 1) : [];
}

export function docxEditsOf(reply: unknown): { edits: DocxEdit[]; skipped: string[] } {
  const edits: DocxEdit[] = [];
  const skipped: string[] = [];
  const raw = editsOf(reply);
  if (raw.length > MAX_EDITS) skipped.push(`変更が多すぎるため、${MAX_EDITS} 件までにしました`);
  for (const item of raw.slice(0, MAX_EDITS)) {
    const edit = item as Record<string, unknown>;
    const index = edit['index'];
    const text = edit['text'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      skipped.push('段落の番号が読めない変更を書いていません');
      continue;
    }
    if (edit['op'] === 'delete') edits.push({ op: 'delete', index });
    else if (
      (edit['op'] === 'replace' || edit['op'] === 'insert_after') &&
      typeof text === 'string' &&
      text.length <= 20_000
    )
      edits.push({ op: edit['op'], index, text });
    else skipped.push(`段落 ${index} への形の合わない変更を書いていません`);
  }
  return { edits, skipped };
}

export function xlsxEditsOf(
  reply: unknown,
  sheets: ReadonlySet<string>,
): { edits: XlsxEdit[]; skipped: string[] } {
  const edits: XlsxEdit[] = [];
  const skipped: string[] = [];
  const raw = editsOf(reply);
  if (raw.length > MAX_EDITS) skipped.push(`変更が多すぎるため、${MAX_EDITS} 件までにしました`);
  for (const item of raw.slice(0, MAX_EDITS)) {
    const edit = item as Record<string, unknown>;
    const sheet = edit['sheet'];
    const cell = typeof edit['cell'] === 'string' ? edit['cell'].toUpperCase() : '';
    const value = edit['value'];
    if (edit['op'] !== 'set' || typeof sheet !== 'string' || !sheets.has(sheet)) {
      skipped.push(
        `シートの分からない変更を書いていません${typeof sheet === 'string' ? `（${excerpt(sheet, 40)}）` : ''}`,
      );
      continue;
    }
    if (!isCellRef(cell)) {
      skipped.push(
        `セル番地の読めない変更を書いていません（${excerpt(String(edit['cell']), 20)}）`,
      );
      continue;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 32_767)
    )
      edits.push({ op: 'set', sheet, cell, value });
    else skipped.push(`${sheet}!${cell} の値の形が合わないため書いていません`);
  }
  return { edits, skipped };
}
