/**
 * Excel（xlsx）のセルを読み、セル単位で値や式を書く。
 *
 * **書くのは頼まれたセルだけ。**セルの書式（s）は残す。式を変えたら、開いたときに
 * 計算し直すよう印を付け、古い計算順の記録（calcChain）は外す（残すと Excel が修復を求める）。
 */
import { decodeXml, encodeXml } from './xml.js';

export interface XlsxSheet {
  readonly name: string;
  /** zip の中の部品名（例: xl/worksheets/sheet1.xml）。 */
  readonly part: string;
}

export interface XlsxCell {
  readonly ref: string;
  /** 人が見る値（共有文字列は文字に、式は = から）。 */
  readonly display: string;
}

export type XlsxValue = string | number | boolean | null;
export interface XlsxEdit {
  readonly op: 'set';
  readonly sheet: string;
  readonly cell: string;
  /** 文字・数値・真偽。`=` で始まる文字は式。null は空にする。 */
  readonly value: XlsxValue;
}

const CELL_REF = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

export function sheetsOf(workbookXml: string, relsXml: string): XlsxSheet[] {
  const targets = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
    if (id && target) targets.set(id, target);
  }
  const sheets: XlsxSheet[] = [];
  for (const sheet of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(sheet[0])?.[1];
    const id = /\br:id="([^"]+)"/.exec(sheet[0])?.[1];
    const target = id ? targets.get(id) : undefined;
    if (name === undefined || !target) continue;
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    sheets.push({ name: decodeXml(name), part });
  }
  return sheets;
}

export function sharedStringsOf(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    [...item[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join(''),
  );
}

export function readCells(sheetXml: string, shared: readonly string[], limit = 4000): XlsxCell[] {
  const cells: XlsxCell[] = [];
  for (const cell of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = cell[1] ?? '';
    const body = cell[2] ?? '';
    const ref = /\br="([A-Z]+[0-9]+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
    const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1];
    const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    let display = '';
    if (formula !== undefined) display = `=${decodeXml(formula)}`;
    else if (type === 's' && value !== undefined) display = shared[Number(value)] ?? '';
    else if (type === 'inlineStr')
      display = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((t) => decodeXml(t[1]!))
        .join('');
    else if (type === 'b') display = value === '1' ? 'TRUE' : 'FALSE';
    else if (value !== undefined) display = decodeXml(value);
    if (display === '') continue;
    cells.push({ ref, display });
    if (cells.length >= limit) break;
  }
  return cells;
}

export function columnNumber(letters: string): number {
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
}

export function isCellRef(ref: string): boolean {
  const match = CELL_REF.exec(ref);
  return !!match && columnNumber(match[1]!) <= 16384 && Number(match[2]) <= 1048576;
}

function cellXml(ref: string, style: string, value: XlsxValue): string {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === '') return `<c r="${ref}"${s}/>`;
  if (typeof value === 'number') return `<c r="${ref}"${s}><v>${String(value)}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value.startsWith('=') && value.length > 1)
    return `<c r="${ref}"${s}><f>${encodeXml(value.slice(1))}</f></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${encodeXml(value)}</t></is></c>`;
}

/** 1 つのシートに、セルの変更を当てる。 */
export function setCell(
  sheetXml: string,
  ref: string,
  value: XlsxValue,
): { xml: string; before: string } {
  const match = CELL_REF.exec(ref);
  if (!match) throw new Error(`bad cell ${ref}`);
  const rowNumber = Number(match[2]);
  const column = columnNumber(match[1]!);

  let xml = sheetXml.replace(/<sheetData\s*\/>/, '<sheetData></sheetData>');
  const dataOpen = /<sheetData\b[^>]*>/.exec(xml);
  const dataClose = xml.indexOf('</sheetData>');
  if (!dataOpen || dataClose < 0) throw new Error('sheet has no sheetData');
  const dataStart = dataOpen.index + dataOpen[0].length;

  // 行を探す。無ければ番号の順に差し込む。
  const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  rowPattern.lastIndex = dataStart;
  let insertRowAt = dataClose;
  let row: RegExpExecArray | null = null;
  for (
    let found = rowPattern.exec(xml);
    found && found.index < dataClose;
    found = rowPattern.exec(xml)
  ) {
    const r = Number(/\br="([0-9]+)"/.exec(found[1] ?? '')?.[1]);
    if (r === rowNumber) {
      row = found;
      break;
    }
    if (r > rowNumber) {
      insertRowAt = found.index;
      break;
    }
  }
  if (!row) {
    const fresh = `<row r="${rowNumber}">${cellXml(ref, '', value)}</row>`;
    return { xml: xml.slice(0, insertRowAt) + fresh + xml.slice(insertRowAt), before: '' };
  }

  const rowOpen = /^<row\b[^>]*?>/.exec(row[0].replace(/\/>$/, '>'))![0];
  const inner = row[2] ?? '';
  let before = '';
  let replaced = false;
  let out = '';
  let cursor = 0;
  for (const cell of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const cellRef = /\br="([A-Z]+)[0-9]+"/.exec(cell[1] ?? '')?.[1];
    const cellColumn = cellRef ? columnNumber(cellRef) : 0;
    if (!replaced && cellColumn === column) {
      const style = /\bs="([0-9]+)"/.exec(cell[1] ?? '')?.[1] ?? '';
      before = cell[0];
      out += inner.slice(cursor, cell.index) + cellXml(ref, style, value);
      cursor = cell.index! + cell[0].length;
      replaced = true;
    } else if (!replaced && cellColumn > column) {
      out += inner.slice(cursor, cell.index) + cellXml(ref, '', value);
      cursor = cell.index!;
      replaced = true;
    }
  }
  out += inner.slice(cursor);
  if (!replaced) out += cellXml(ref, '', value);
  const newRow = `${rowOpen}${out}</row>`;
  return { xml: xml.slice(0, row.index) + newRow + xml.slice(row.index + row[0].length), before };
}

/** 開いたときに計算し直させる。式を書いた後の古い計算結果を信じさせない。 */
export function forceRecalculation(workbookXml: string): string {
  if (/<calcPr\b[^>]*fullCalcOnLoad=/.test(workbookXml))
    return workbookXml.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"');
  if (/<calcPr\b/.test(workbookXml))
    return workbookXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  // 要素の順序は決まっている。calcPr より後ろに来る要素の手前に差し込む。
  const after =
    /<(?:oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>/.exec(
      workbookXml,
    );
  if (!after) throw new Error('workbook.xml has no end');
  return `${workbookXml.slice(0, after.index)}<calcPr fullCalcOnLoad="1"/>${workbookXml.slice(after.index)}`;
}
