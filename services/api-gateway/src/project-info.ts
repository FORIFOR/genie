/**
 * 作業しているフォルダのプロジェクト（git の根・名前・ブランチ）。Claude Code の承認のカードに出す
 * （agent-approvals.ts）。gateway は同じ Mac で動くので、手元の git に聞く。分からなければ null。
 */
import { execFile } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectInfo } from './agent-approvals.js';

const run = promisify(execFile);

export async function projectOf(cwd: string): Promise<ProjectInfo | null> {
  if (!isAbsolute(cwd)) return null;
  const git = (args: string[]) =>
    run('/usr/bin/git', ['-C', cwd, ...args], { timeout: 2000, maxBuffer: 64 * 1024 }).then(
      (r) => r.stdout.trim(),
      () => '',
    );
  const root = await git(['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return { root, name: basename(root), branch: branch || null };
}
