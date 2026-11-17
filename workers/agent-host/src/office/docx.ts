/**
 * Word（docx）の本文を段落の並びとして読み、段落単位で書き換える。
 *
 * **段落の外の形（表・図・セクション・ヘッダ）には触らない。**書き換えた段落は、
 * 段落の書式（w:pPr）と最初の文字の書式（w:rPr）を引き継いだ 1 つの run にする。
 * 段落の中に図や入れ子の段落（テキストボックス）がある段落は、読むだけで書き換えない。
 */
import { decodeXml, encodeXml } from './xml.js';

export interface DocxParagraph {
  readonly index: number;
  readonly text: string;
  /** 書き換えてよいか。図・入れ子・フィールドを含む段落は false。 */
  readonly editable: boolean;
  readonly start: number;
  readonly end: number;
  readonly xml: string;
}

export type DocxEdit =
  | { readonly op: 'replace'; readonly index: number; readonly text: string }
  | { readonly op: 'insert_after'; readonly index: number; readonly text: string }
  | { readonly op: 'delete'; readonly index: number };

const PARAGRAPH = /<w:p\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:p>)/g;
const TEXT_TOKEN =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\s*\/>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;
const NOT_EDITABLE =
  /<w:(?:drawing|pict|object|fldChar|fldSimple|txbxContent|sdt|ins|del|moveFrom|moveTo)\b|<mc:AlternateContent\b/;

export function docxBodyRange(xml: string): { start: number; end: number } {
  const open = xml.search(/<w:body\b[^>]*>/);
  const close = xml.lastIndexOf('</w:body>');
  if (open < 0 || close < 0) throw new Error('document.xml has no body');
  return { start: xml.indexOf('>', open) + 1, end: close };
}

export function readParagraphs(xml: string): DocxParagraph[] {
  const body = docxBodyRange(xml);
  const out: DocxParagraph[] = [];
  PARAGRAPH.lastIndex = body.start;
  for (
    let match = PARAGRAPH.exec(xml);
    match && match.index < body.end;
    match = PARAGRAPH.exec(xml)
  ) {
    const whole = match[0];
    const inner = whole.slice(whole.indexOf('>') + 1);
    // 入れ子の段落（テキストボックスなど）は、正規表現の取り方では形を保てない。
    const nested = /<w:p\b/.test(inner);
    out.push({
      index: out.length,
      text: paragraphText(whole),
      editable: !nested && !NOT_EDITABLE.test(whole),
      start: match.index,
      end: match.index + whole.length,
      xml: whole,
    });
  }
  return out;
}

export function paragraphText(xml: string): string {
  let text = '';
  for (const token of xml.matchAll(TEXT_TOKEN)) {
    if (token[1] !== undefined) text += decodeXml(token[1]);
    else if (token[0].startsWith('<w:tab')) text += '\t';
    else if (token[0].startsWith('<w:br') || token[0].startsWith('<w:cr')) text += '\n';
  }
  return text;
}

/** 段落を作り直す。段落の書式と、最初の run の文字の書式を引き継ぐ。 */
export function rebuildParagraph(template: string, text: string, fresh = false): string {
  const head = /^<w:p\b[^>]*?\/?>/.exec(template)?.[0] ?? '<w:p>';
  // 新しく足す段落に、元の段落の識別子を写さない（同じ id が 2 つになる）。
  const open = (fresh ? head.replace(/\s+w14:(?:paraId|textId)="[^"]*"/g, '') : head).replace(
    /\/>$/,
    '>',
  );
  const pPr = /<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/.exec(template)?.[0] ?? '';
  const firstRun = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/.exec(template)?.[0] ?? '';
  const rPr = /<w:rPr\b[\s\S]*?<\/w:rPr>|<w:rPr\b[^>]*\/>/.exec(firstRun)?.[0] ?? '';
  const pieces = text.split(/(\t|\n)/).flatMap((piece) => {
    if (piece === '\t') return ['<w:tab/>'];
    if (piece === '\n') return ['<w:br/>'];
    return piece ? [`<w:t xml:space="preserve">${encodeXml(piece)}</w:t>`] : [];
  });
  const run = pieces.length > 0 ? `<w:r>${rPr}${pieces.join('')}</w:r>` : '';
  return `${open}${pPr}${run}</w:p>`;
}

/**
 * 変更を当てる。番号はすべて**元の**段落の番号。
 * 同じ段落の後ろへの追加は、頼まれた順に並べる。
 */
export function applyDocxEdits(
  xml: string,
  edits: readonly DocxEdit[],
): { xml: string; applied: DocxEdit[]; skipped: string[] } {
  const paragraphs = readParagraphs(xml);
  const applied: DocxEdit[] = [];
  const skipped: string[] = [];
  const replaced = new Map<number, string | null>();
  const inserted = new Map<number, string[]>();

  for (const edit of edits) {
    const target = paragraphs[edit.index];
    if (!target) {
      skipped.push(`段落 ${edit.index} はありません`);
      continue;
    }
    if (!target.editable && edit.op !== 'insert_after') {
      skipped.push(`段落 ${edit.index} は図や入れ子を含むため書き換えていません`);
      continue;
    }
    if (edit.op !== 'insert_after' && replaced.has(edit.index)) {
      skipped.push(`段落 ${edit.index} への 2 つ目の変更は書いていません`);
      continue;
    }
    if (edit.op === 'replace') replaced.set(edit.index, rebuildParagraph(target.xml, edit.text));
    else if (edit.op === 'delete')
      // 表のセルには段落が 1 つは要る。セルの中の段落は消さずに空にする。
      replaced.set(
        edit.index,
        insideTableCell(xml, target.start) ? rebuildParagraph(target.xml, '') : null,
      );
    else {
      const list = inserted.get(edit.index) ?? [];
      list.push(rebuildParagraph(target.xml, edit.text, true));
      inserted.set(edit.index, list);
    }
    applied.push(edit);
  }

  let out = '';
  let cursor = 0;
  for (const paragraph of paragraphs) {
    out += xml.slice(cursor, paragraph.start);
    const swap = replaced.get(paragraph.index);
    out += swap === undefined ? paragraph.xml : (swap ?? '');
    for (const extra of inserted.get(paragraph.index) ?? []) out += extra;
    cursor = paragraph.end;
  }
  out += xml.slice(cursor);
  return { xml: out, applied, skipped };
}

function insideTableCell(xml: string, at: number): boolean {
  const before = xml.slice(0, at);
  // `<w:tcPr` も `<w:tc` で始まるので、セルの開始は空白か `>` が続くものだけ数える。
  let open = -1;
  for (const match of before.matchAll(/<w:tc[\s>]/g)) open = match.index;
  return open > before.lastIndexOf('</w:tc>');
}
