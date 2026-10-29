/**
 * Genie の答え（Markdown）を、LINE の Flex Message にする。**純粋関数。**
 *
 * LINE の文のメッセージは太字も箇条書きも描かない。見出し・太字・箇条書き・リンクのある答えは、
 * 暗い吹き出しの Flex Message にして、太字は span、箇条書きは記号と字下げ、リンクは下のボタンにする。
 * 一言の答え（構造の無いもの）は、いつもどおり文のメッセージで送る（null を返す）。
 *
 * 作れないとき（大きすぎる・空）も null。呼ぶ側は文のメッセージに戻す。
 */

type Inline = { readonly text: string; readonly bold?: boolean; readonly link?: boolean };

type Block =
  | { readonly kind: 'heading'; readonly inline: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly inline: readonly Inline[] }
  | {
      readonly kind: 'item';
      readonly depth: number;
      readonly marker: string;
      readonly inline: readonly Inline[];
    }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'rule' };

export interface ParsedAnswer {
  readonly blocks: readonly Block[];
  readonly links: readonly { readonly label: string; readonly url: string }[];
  /** 見出し・太字・箇条書き・リンクのどれかがある。 */
  readonly structured: boolean;
}

const COLORS = {
  background: '#2C2C2E',
  text: '#FFFFFF',
  muted: '#AEAEB2',
  link: '#8AB4F8',
  rule: '#48484A',
} as const;

/** 1 枚の吹き出しの JSON の目安（LINE の上限より小さく）。 */
const BUBBLE_BYTES = 9_000;
/** 横にめくる枚数の上限（LINE は 12 枚まで。読み切れる長さにとどめる）。 */
const MAX_BUBBLES = 5;
/** 下に置くリンクのボタン（多すぎると本文が押し出される）。 */
const MAX_LINK_BUTTONS = 4;
const ALT_TEXT_CHARS = 400;

const BULLETS = ['•', '–', '◦'] as const;

/** 行の中の **太字**・[文](URL)・`code`・裸の URL を分ける。 */
export function parseInline(
  source: string,
  links: { label: string; url: string }[] = [],
): Inline[] {
  const out: Inline[] = [];
  const push = (part: Inline) => {
    if (!part.text) return;
    const last = out[out.length - 1];
    if (last && !!last.bold === !!part.bold && !!last.link === !!part.link) {
      out[out.length - 1] = { ...last, text: last.text + part.text };
    } else out.push(part);
  };
  const pattern =
    /\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|(https?:\/\/[^\s)<>]+)/g;
  let at = 0;
  for (const m of source.matchAll(pattern)) {
    push({ text: source.slice(at, m.index) });
    if (m[1] ?? m[2]) push({ text: (m[1] ?? m[2])!, bold: true });
    else if (m[3] && m[4]) {
      push({ text: m[3], link: true });
      links.push({ label: m[3], url: m[4] });
    } else if (m[5]) push({ text: m[5] });
    else if (m[6]) {
      push({ text: m[6], link: true });
      links.push({ label: m[6], url: m[6] });
    }
    at = m.index + m[0].length;
  }
  push({ text: source.slice(at) });
  // 残った *斜体* の記号は外す（LINE の span は斜体を描けるが、記号のまま出るよりよい）
  return out.map((p) => ({
    ...p,
    text: p.text.replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[、。])/g, '$1$2'),
  }));
}

export function parseAnswer(markdown: string): ParsedAnswer {
  const links: { label: string; url: string }[] = [];
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n'), links) });
      paragraph = [];
    }
  };
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]!); i += 1) code.push(lines[i]!);
      if (code.length) blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', inline: parseInline(heading[1]!, links) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const item = /^(\s*)([-*+・]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush();
      const depth = Math.min(2, Math.floor(item[1]!.replace(/\t/g, '  ').length / 2));
      const ordered = /^\d/.test(item[2]!);
      blocks.push({
        kind: 'item',
        depth,
        marker: ordered ? item[2]!.replace(')', '.') : BULLETS[depth]!,
        inline: parseInline(item[3]!, links),
      });
      continue;
    }
    // 表は 1 行ずつの文にする（区切りの行は捨てる）
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      blocks.push({
        kind: 'item',
        depth: 0,
        marker: BULLETS[0],
        inline: parseInline(cells.join(' / '), links),
      });
      continue;
    }
    paragraph.push(line.replace(/^\s{0,3}>\s?/, ''));
  }
  flush();
  // 先頭の見出しは答えの題（Genie の作業一覧の題）。吹き出しには要らない
  if (blocks[0]?.kind === 'heading' && blocks.length > 1) blocks.shift();
  // 題を除いたあとに、見出し・箇条書き・コード・区切り・太字・リンクのどれかがあれば構造のある答え
  const structured = blocks.some(
    (b) => b.kind !== 'paragraph' || b.inline.some((p) => p.bold || p.link),
  );
  const seen = new Set<string>();
  return {
    blocks,
    links: links.filter((l) => !seen.has(l.url) && seen.add(l.url)),
    structured,
  };
}

const textOf = (inline: readonly Inline[]) => inline.map((p) => p.text).join('');

function textComponent(
  inline: readonly Inline[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const plain = textOf(inline);
  const component: Record<string, unknown> = {
    type: 'text',
    text: plain || ' ',
    wrap: true,
    color: COLORS.text,
    ...extra,
  };
  if (inline.some((p) => p.bold || p.link)) {
    component['contents'] = inline.map((p) => ({
      type: 'span',
      text: p.text,
      ...(p.bold ? { weight: 'bold' } : {}),
      ...(p.link ? { color: COLORS.link } : {}),
    }));
  }
  return component;
}

function blockComponent(block: Block, first: boolean): Record<string, unknown> {
  const margin = first ? {} : { margin: block.kind === 'heading' ? 'xl' : 'md' };
  switch (block.kind) {
    case 'heading':
      return textComponent(block.inline, { weight: 'bold', ...margin });
    case 'paragraph':
      return textComponent(block.inline, margin);
    case 'code':
      return {
        type: 'text',
        text: block.text,
        wrap: true,
        size: 'sm',
        color: COLORS.muted,
        ...margin,
      };
    case 'rule':
      return { type: 'separator', color: COLORS.rule, ...(first ? {} : { margin: 'lg' }) };
    case 'item':
      return {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        ...(block.depth ? { paddingStart: `${String(block.depth * 16)}px` } : {}),
        ...(first ? {} : { margin: 'sm' }),
        contents: [
          { type: 'text', text: block.marker, flex: 0, color: COLORS.muted },
          textComponent(block.inline, { flex: 1 }),
        ],
      };
  }
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function bubble(body: Record<string, unknown>[], footer: Record<string, unknown>[] | null) {
  return {
    type: 'bubble',
    size: 'mega',
    styles: {
      body: { backgroundColor: COLORS.background },
      ...(footer
        ? {
            footer: {
              backgroundColor: COLORS.background,
              separator: true,
              separatorColor: COLORS.rule,
            },
          }
        : {}),
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: body },
    ...(footer
      ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } }
      : {}),
  };
}

/** ボタンのラベル（LINE は 40 字まで。読める長さに縮める）。 */
const buttonLabel = (label: string) => {
  const text = label
    .replace(/^https?:\/\//, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 20 ? `${text.slice(0, 19)}…` : text;
};

/**
 * 答えの Flex Message。構造の無い答え・作れないときは null（文のメッセージで送る）。
 * `plain` は通知や一覧に出る文（altText）に使う。
 */
export function answerFlex(markdown: string, plain: string): Record<string, unknown> | null {
  const parsed = parseAnswer(markdown);
  if (!parsed.structured || parsed.blocks.length === 0) return null;
  const footer = parsed.links.length
    ? parsed.links.slice(0, MAX_LINK_BUTTONS).map((l) => ({
        type: 'button',
        style: 'link',
        height: 'sm',
        color: COLORS.link,
        action: { type: 'uri', label: buttonLabel(l.label), uri: l.url },
      }))
    : null;
  // 大きすぎる答えは、区切りのよいところで次の吹き出しへ
  const pages: Record<string, unknown>[][] = [[]];
  for (const block of parsed.blocks) {
    const page = pages[pages.length - 1]!;
    const component = blockComponent(block, page.length === 0);
    if (bytes(component) > BUBBLE_BYTES) return null;
    if (page.length && bytes([...page, component]) > BUBBLE_BYTES - 1_500) {
      pages.push([blockComponent(block, true)]);
    } else page.push(component);
  }
  if (pages.length > MAX_BUBBLES) return null;
  const bubbles = pages.map((page, i) => bubble(page, i === pages.length - 1 ? footer : null));
  const altText = plain.replace(/\s+/g, ' ').trim().slice(0, ALT_TEXT_CHARS) || 'Genie の答え';
  return {
    type: 'flex',
    altText,
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
  };
}
