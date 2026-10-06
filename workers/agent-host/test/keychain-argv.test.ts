import { describe, expect, it, vi } from 'vitest';

const calls: { args: string[]; input: string }[] = [];
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    done: (e: Error | null, out: string, err: string) => void,
  ) => {
    const call = { args, input: '' };
    calls.push(call);
    return {
      stdin: {
        end: (input: string) => {
          call.input = input;
          done(null, '', '');
        },
      },
    };
  },
}));

describe('saving a connector token to the macOS keychain', () => {
  it('never puts the token on the command line', async () => {
    const { MacKeychain } = await import('../src/keychain.js');
    const secret = JSON.stringify({ accessToken: 'ya29.secret-value', refreshToken: '1//refresh' });
    await new MacKeychain('someone').set('com.astra.gmail/gmail', secret);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['-i']);
    expect(calls[0]!.args.join(' ')).not.toContain('secret-value');
    // 値は標準入力に 16 進で渡る（引用が崩れない）
    expect(calls[0]!.input).toContain(`-X ${Buffer.from(secret).toString('hex')}`);
    expect(calls[0]!.input).not.toContain('ya29');
  });
});
