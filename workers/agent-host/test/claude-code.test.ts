/**
 * 端末の Claude Code。正本 §21、UI/UX §22。
 *
 * 見るのは:
 *   - **ログインの中身を読まない**
 *   - 入っていない / サインインしていない / 落ちた / 上限 を取り違えない
 *   - 読めない返事を、空の答えとして通さない
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeCli,
  ClaudeCodeError,
  failureFrom,
  parseReply,
  type RunResult,
} from '../src/claude-code.js';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const reply = (value: unknown): string =>
  JSON.stringify({ type: 'result', result: JSON.stringify(value) });

const runs = (result: Partial<RunResult>) => {
  const calls: { command: string; args: readonly string[]; input?: string }[] = [];
  return {
    calls,
    run: async (
      command: string,
      args: readonly string[],
      options: { input?: string; timeoutMs: number },
    ): Promise<RunResult> => {
      calls.push({
        command,
        args,
        ...(options.input === undefined ? {} : { input: options.input }),
      });
      return { code: 0, stdout: '', stderr: '', ...result };
    },
  };
};

describe('the Claude Code boundary', () => {
  it('never reads Claude Code credentials', async () => {
    /*
     * 利用者が Claude Code に同意したのは「Claude Code が使う」ことであって、
     * 「別のプログラムがその鍵で好きに呼ぶ」ことではない。
     */
    const source = await readFile(path.join(src, 'claude-code.ts'), 'utf8');
    expect(source).not.toMatch(/\.claude\/\.credentials|credentials\.json|oauth_token|sessionKey/);
    expect(source).not.toMatch(/ANTHROPIC_API_KEY/);
    // 呼ぶのは CLI そのもの
    expect(source).toContain("'--version'");
  });

  it('does not send the prompt on the command line', async () => {
    // 引数はプロセス一覧から読める。問いの中身が他のユーザーに見えてしまう。
    const { calls, run } = runs({ stdout: reply({ queries: ['a'] }) });
    await new ClaudeCodeCli({ run }).ask('社外秘の質問');
    expect(calls[0]!.args.join(' ')).not.toContain('社外秘');
    expect(calls[0]!.input).toBe('社外秘の質問');
  });
});

describe('telling the failures apart', () => {
  it('knows it is not installed', () => {
    expect(failureFrom({ code: null, stdout: '', stderr: 'ENOENT' })).toBe('not_installed');
    expect(failureFrom({ code: 127, stdout: '', stderr: 'command not found: claude' })).toBe(
      'not_installed',
    );
  });

  it('knows nobody has signed in', () => {
    expect(failureFrom({ code: 1, stdout: '', stderr: 'Not logged in. Run /login' })).toBe(
      'not_signed_in',
    );
    expect(failureFrom({ code: 1, stdout: '', stderr: 'Unauthorized (401)' })).toBe(
      'not_signed_in',
    );
  });

  it('knows the limit was reached', () => {
    expect(failureFrom({ code: 1, stdout: '', stderr: 'usage limit reached' })).toBe(
      'rate_limited',
    );
    expect(failureFrom({ code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests' })).toBe(
      'rate_limited',
    );
  });

  it('says it crashed rather than guessing', () => {
    // 分からないものを「たぶん上限」にしない。待っても直らない失敗を待たせることになる。
    expect(failureFrom({ code: 3, stdout: '', stderr: 'segmentation fault' })).toBe('crashed');
    expect(failureFrom({ code: 1, stdout: '', stderr: '' })).toBe('crashed');
  });

  it('calls a clean exit a success', () => {
    expect(failureFrom({ code: 0, stdout: '{}', stderr: '' })).toBeNull();
  });
});

describe('reading the reply', () => {
  it('reads the JSON inside the envelope', () => {
    expect(parseReply(reply({ queries: ['a', 'b'] }))).toEqual({ queries: ['a', 'b'] });
  });

  it('reads JSON that came back fenced', () => {
    const fenced = JSON.stringify({
      type: 'result',
      result: '```json\n{"queries": ["a"]}\n```',
    });
    expect(parseReply(fenced)).toEqual({ queries: ['a'] });
  });

  it('reads JSON that has the web-search citations tacked on after it', () => {
    /*
     * web を引かせると、CLI は答えのあとに
     * 「Sources: [example.com](https://…)」を足す。これは消せない。
     * 全体を捨てていた間、**正しく引けた検索結果まで捨てていた。**
     */
    const withCitations = JSON.stringify({
      type: 'result',
      result:
        '{"results": [{"url": "https://example.com/a", "title": "A"}]}\n\nSources: [example.com](https://example.com/a)',
    });
    expect(parseReply(withCitations)).toEqual({
      results: [{ url: 'https://example.com/a', title: 'A' }],
    });
  });

  it('is not confused by braces inside strings', () => {
    const tricky = JSON.stringify({
      type: 'result',
      result: '{"snippet": "見出し {ここ} と \\"引用\\""}\n\nSources: none',
    });
    expect(parseReply(tricky)).toEqual({ snippet: '見出し {ここ} と "引用"' });
  });

  it('does not accept a reply that was cut off mid-way', () => {
    // 途中で切れたものを、完全な答えとして扱わない
    const truncated = JSON.stringify({ type: 'result', result: '{"results": [{"url": "https:/' });
    expect(() => parseReply(truncated)).toThrow(ClaudeCodeError);
  });

  it('refuses a reply it cannot read, rather than returning nothing', () => {
    // 空を返すと「調べたが何も無かった」になる。読めなかったのとは違う。
    expect(() => parseReply('not json at all')).toThrow(ClaudeCodeError);
    expect(() => parseReply(JSON.stringify({ type: 'result' }))).toThrow(ClaudeCodeError);
    expect(() => parseReply(reply(undefined))).toThrow(ClaudeCodeError);
  });

  it('refuses prose wrapped in the envelope', () => {
    const prose = JSON.stringify({ type: 'result', result: 'ここに答えがあります。' });
    expect(() => parseReply(prose)).toThrow(ClaudeCodeError);
  });
});

describe('probing the device', () => {
  it('reports the version when it is there', async () => {
    const { run } = runs({ stdout: '2.0.14 (Claude Code)\n' });
    expect(await new ClaudeCodeCli({ run }).probe()).toEqual({
      available: true,
      version: '2.0.14 (Claude Code)',
      reason: null,
    });
  });

  it('says what is wrong when it is not there', async () => {
    const { run } = runs({ code: null, stderr: 'ENOENT' });
    const probe = await new ClaudeCodeCli({ run }).probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain('見つかりません');
  });

  it('turns a failed run into a typed error', async () => {
    const { run } = runs({ code: 1, stderr: 'usage limit reached' });
    await expect(new ClaudeCodeCli({ run }).ask('x')).rejects.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('stops before starting when it was already cancelled', async () => {
    const { calls, run } = runs({ stdout: reply({}) });
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ClaudeCodeCli({ run }).ask('x', { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: 'timed_out' });
    expect(calls).toEqual([]);
  });

  it('shows screen images inline with no tools, MCP or settings, and reads the stream result', async () => {
    const { calls, run } = runs({
      stdout: [
        JSON.stringify({ type: 'system', subtype: 'init', tools: [] }),
        JSON.stringify({ type: 'assistant' }),
        reply({ action: 'click', elementId: 'e1' }),
      ].join('\n'),
    });
    const png = Buffer.from('89504e47', 'hex');
    const answer = await new ClaudeCodeCli({ run }).askWithImages('次の一手', [
      { mimeType: 'image/png', data: png },
    ]);
    expect(answer).toEqual({ action: 'click', elementId: 'e1' });
    const args = calls[0]!.args;
    expect(args).toEqual(
      expect.arrayContaining(['--input-format', 'stream-json', '--strict-mcp-config']),
    );
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
    const sent = JSON.parse(calls[0]!.input!);
    expect(sent.message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
    });
    expect(sent.message.content[1]).toEqual({ type: 'text', text: '次の一手' });
  });

  it('turns an error result in the stream into a typed error', async () => {
    const { run } = runs({
      stdout: JSON.stringify({ type: 'result', is_error: true, result: 'usage limit reached' }),
    });
    await expect(
      new ClaudeCodeCli({ run }).askWithImages('x', [
        { mimeType: 'image/png', data: Buffer.from('x') },
      ]),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
    const { run: noResult } = runs({ stdout: JSON.stringify({ type: 'assistant' }) });
    await expect(new ClaudeCodeCli({ run: noResult }).askWithImages('x', [])).rejects.toMatchObject(
      { reason: 'unreadable_output' },
    );
  });
});
