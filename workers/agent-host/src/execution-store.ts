import { randomUUID, createHash } from 'node:crypto';
import { mkdir, lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { visualContextDir } from './visual-context.js';
import type { PreparedExecution } from './execution-policy.js';
export interface ExecutionStore {
  save(value: Omit<PreparedExecution, 'id'>): Promise<PreparedExecution>;
  load(id: string): Promise<PreparedExecution>;
  claim(id: string): Promise<void>;
}
/** A private, immutable plan followed by an exclusive start journal. No unsafe resume. */
export class FileExecutionStore implements ExecutionStore {
  constructor(readonly directory = join(visualContextDir(), 'ExecutionPlans')) {}
  async root(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error('execution.private_store_required');
    return realpath(resolve(this.directory));
  }
  async save(value: Omit<PreparedExecution, 'id'>): Promise<PreparedExecution> {
    const prepared = { ...value, id: randomUUID() };
    const file = await open(join(await this.root(), `${prepared.id}.json`), 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(prepared));
      await file.sync();
    } finally {
      await file.close();
    }
    return prepared;
  }
  async load(id: string): Promise<PreparedExecution> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('execution.invalid_plan');
    return this.read(id);
  }
  private async read(id: string): Promise<PreparedExecution> {
    const { constants } = await import('node:fs');
    const file = await open(
      join(await this.root(), `${id}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.size > 100000 ||
        stat.mode & 0o077
      )
        throw new Error('execution.invalid_plan');
      const value = JSON.parse(await file.readFile('utf8')) as PreparedExecution;
      if (value.id !== id || value.version !== 1) throw new Error('execution.invalid_plan');
      return value;
    } finally {
      await file.close();
    }
  }
  async claim(id: string): Promise<void> {
    const key = createHash('sha256').update(id).digest('hex');
    const file = await open(join(await this.root(), `${key}.started`), 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ startedAt: new Date().toISOString() }));
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
