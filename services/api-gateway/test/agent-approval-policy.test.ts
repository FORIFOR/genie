/**
 * 承認の方針（src/agent-approval-policy.ts）。継続許可にしてよい操作と、毎回聞く操作を分けられるか。
 */
import { describe, expect, it } from 'vitest';
import { classify, ruleFor, type ApprovalRule } from '../src/agent-approval-policy.js';

const ROOT = '/Users/taro/Projects/genie';
const CWD = `${ROOT}/services/api`;
const bash = (command: string, cwd = CWD) => classify('Bash', { command }, cwd, ROOT);

describe('classify', () => {
  it('lets safe, project-local work become a standing permission', () => {
    expect(bash('touch out-line.txt')).toMatchObject({
      operation: 'create_file',
      risk: 'low',
      ruleable: true,
      targets: [`${CWD}/out-line.txt`],
    });
    expect(bash('pnpm test -- --run src/app.test.ts')).toMatchObject({
      operation: 'run_checks',
      ruleable: true,
    });
    expect(bash('git status && git diff --stat')).toMatchObject({
      operation: 'read',
      ruleable: true,
    });
    expect(
      classify(
        'Edit',
        { file_path: `${ROOT}/src/app.ts`, old_string: 'a', new_string: 'b' },
        CWD,
        ROOT,
      ),
    ).toMatchObject({ operation: 'edit_file', risk: 'low', ruleable: true });
    expect(classify('WebFetch', { url: 'https://docs.example.com/a' }, CWD, ROOT)).toMatchObject({
      operation: 'web_read',
      match: 'docs.example.com',
      ruleable: true,
    });
  });

  it('always asks for secrets, sending out, deploys, destruction, privileges and payments', () => {
    for (const [command, operation] of [
      ['git push origin main', 'git_push'],
      ['pnpm publish', 'publish'],
      ['pnpm deploy', 'deploy'],
      ['kubectl apply -f prod.yaml', 'deploy'],
      ['rm -rf dist', 'destructive'],
      ['git reset --hard HEAD~1', 'destructive'],
      ['sudo make install', 'privileged'],
      ['curl -X POST https://api.example.com -d @data.json', 'send_out'],
      ['scp build.zip server:/srv', 'send_out'],
      ['cat .env', 'secrets'],
      ['node scripts/stripe-refund.mjs', 'payment'],
    ] as const)
      expect(bash(command), command).toMatchObject({ operation, risk: 'high', ruleable: false });
    // git checkout はブランチの切り替え（決済ではない）
    expect(bash('git checkout feature').operation).toBe('command');
  });

  it('never makes a standing permission for paths outside the project or for secret files', () => {
    expect(bash('touch /tmp/x')).toMatchObject({ operation: 'outside_project', ruleable: false });
    expect(bash('touch ../../../../other/x')).toMatchObject({ ruleable: false });
    expect(bash('echo hi > ~/.zshrc')).toMatchObject({ ruleable: false });
    expect(bash('ls', '/Users/taro/Desktop')).toMatchObject({ operation: 'outside_project' });
    expect(
      classify('Write', { file_path: `${ROOT}/.env`, content: 'X=1' }, CWD, ROOT),
    ).toMatchObject({
      operation: 'secrets',
      ruleable: false,
    });
    expect(
      classify(
        'Edit',
        { file_path: '/Users/taro/.claude/settings.json', old_string: 'a', new_string: 'b' },
        CWD,
        ROOT,
      ),
    ).toMatchObject({ ruleable: false });
    expect(classify('Edit', { file_path: '/Users/taro/other/a.ts' }, CWD, ROOT)).toMatchObject({
      operation: 'outside_project',
      ruleable: false,
    });
  });

  it('allows an unknown command again only when it is the very same command', () => {
    const op = bash('python3 scripts/gen.py --out build');
    expect(op).toMatchObject({
      operation: 'command',
      match: 'python3 scripts/gen.py --out build',
      ruleable: true,
    });
    expect(bash('python3 -c "$(printf x)"\npython3 other.py').ruleable).toBe(false);
  });
});

describe('ruleFor', () => {
  const rule = (over: Partial<ApprovalRule>): ApprovalRule => ({
    id: 'r',
    scope: 'project',
    projectRoot: ROOT,
    sessionId: null,
    toolName: 'Bash',
    operation: 'create_file',
    match: null,
    ...over,
  });
  const req = { toolName: 'Bash', sessionId: 's1', projectRoot: ROOT };

  it('matches the same kind of operation in the same project', () => {
    expect(ruleFor([rule({})], bash('touch a.txt'), req)?.id).toBe('r');
    // 種類が違えば当たらない
    expect(ruleFor([rule({})], bash('pnpm test'), req)).toBeNull();
    // 別のプロジェクトでは当たらない（パスを持たない操作も）
    expect(
      ruleFor(
        [rule({ operation: 'run_checks', projectRoot: '/Users/taro/Projects/other' })],
        bash('pnpm test'),
        req,
      ),
    ).toBeNull();
    expect(
      ruleFor([rule({ projectRoot: '/Users/taro/Projects/other' })], bash('touch a.txt'), req),
    ).toBeNull();
  });

  it('keeps session rules to that session and never applies a rule to an operation that must be asked', () => {
    const session = rule({ scope: 'session', sessionId: 's1' });
    expect(ruleFor([session], bash('touch a.txt'), req)?.id).toBe('r');
    expect(ruleFor([session], bash('touch a.txt'), { ...req, sessionId: 's2' })).toBeNull();
    // 「消す」はルールがあっても毎回聞く
    expect(ruleFor([rule({ operation: 'destructive' })], bash('rm -rf dist'), req)).toBeNull();
    // 知らないコマンドは同じ文だけ
    const same = rule({ operation: 'command', match: 'make gen' });
    expect(ruleFor([same], bash('make gen'), req)?.id).toBe('r');
    expect(ruleFor([same], bash('make gen && make all'), req)).toBeNull();
  });
});
