/**
 * 決定論的検証器（Deterministic Verifier）。
 *
 * LLMの自己申告（「保存されたと思います」等）を信じず、
 * ファイルの存在・更新日時・内容、プロセス終了コード、AX要素状態、APIレスポンス等を
 * 実際のPC状態から決定論的に検証して確証（Evidence）を生成する。
 */
import * as fs from 'node:fs/promises';
import {
  type EvidenceType,
  type LedgerEvidence,
  type VerificationCriteria,
  type VerificationType,
} from '@genie/contracts';

export interface VerificationResult {
  readonly id: string;
  readonly type: VerificationType;
  readonly satisfied: boolean;
  readonly message: string;
  readonly evidence?: LedgerEvidence;
}

export interface VerifierEnvironment {
  readonly stat?: ((path: string) => Promise<{ size: number; mtimeMs: number } | null>) | undefined;
  readonly readFile?: ((path: string) => Promise<string | null>) | undefined;
  readonly queryAx?: ((query: {
    app?: string | undefined;
    role?: string | undefined;
    title?: string | undefined;
    value?: string | undefined;
  }) => Promise<{ found: boolean; value?: string | undefined }>) | undefined;
}

const defaultEnv: VerifierEnvironment = {
  stat: async (path: string) => {
    try {
      const s = await fs.stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  },
  readFile: async (path: string) => {
    try {
      return await fs.readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * ファイルが存在し、最小サイズとmtime条件を満たすか検証する。
 */
export async function verifyFileExists(
  id: string,
  target: { path: string; min_bytes?: number | undefined; mtime_after_ms?: number | undefined },
  env: VerifierEnvironment = defaultEnv,
): Promise<VerificationResult> {
  const statFn = env.stat ?? defaultEnv.stat!;
  const stat = await statFn(target.path);

  if (!stat) {
    return {
      id,
      type: 'file_exists',
      satisfied: false,
      message: `File does not exist: ${target.path}`,
    };
  }

  if (target.min_bytes !== undefined && stat.size < target.min_bytes) {
    return {
      id,
      type: 'file_exists',
      satisfied: false,
      message: `File size ${stat.size} bytes is less than expected minimum ${target.min_bytes} bytes`,
    };
  }

  if (target.mtime_after_ms !== undefined && stat.mtimeMs < target.mtime_after_ms) {
    return {
      id,
      type: 'file_exists',
      satisfied: false,
      message: `File mtime ${stat.mtimeMs} is earlier than threshold ${target.mtime_after_ms}`,
    };
  }

  return {
    id,
    type: 'file_exists',
    satisfied: true,
    message: `File verified: ${target.path} (${stat.size} bytes)`,
    evidence: {
      id: `ev-${id}`,
      type: 'file',
      uri: target.path.startsWith('file://') ? target.path : `file://${target.path}`,
      description: `File exists with size ${stat.size} bytes and mtime ${new Date(stat.mtimeMs).toISOString()}`,
      captured_at: new Date().toISOString(),
    },
  };
}

/**
 * ファイルの内容に特定の文字列・パターンが含まれるか検証する。
 */
export async function verifyFileContent(
  id: string,
  target: { path: string; contains?: string | undefined; pattern?: string | undefined },
  env: VerifierEnvironment = defaultEnv,
): Promise<VerificationResult> {
  const readFn = env.readFile ?? defaultEnv.readFile!;
  const content = await readFn(target.path);

  if (content === null) {
    return {
      id,
      type: 'file_content',
      satisfied: false,
      message: `Cannot read file: ${target.path}`,
    };
  }

  if (target.contains !== undefined && !content.includes(target.contains)) {
    return {
      id,
      type: 'file_content',
      satisfied: false,
      message: `File does not contain expected substring: "${target.contains}"`,
    };
  }

  if (target.pattern !== undefined) {
    const re = new RegExp(target.pattern);
    if (!re.test(content)) {
      return {
        id,
        type: 'file_content',
        satisfied: false,
        message: `File content does not match regex pattern: /${target.pattern}/`,
      };
    }
  }

  return {
    id,
    type: 'file_content',
    satisfied: true,
    message: `File content matched in ${target.path}`,
    evidence: {
      id: `ev-${id}`,
      type: 'file',
      uri: target.path.startsWith('file://') ? target.path : `file://${target.path}`,
      description: `File content matched condition (contains="${target.contains ?? ''}", pattern="${target.pattern ?? ''}")`,
      captured_at: new Date().toISOString(),
    },
  };
}

/**
 * プロセス終了コードを検証する。
 */
export function verifyProcessExit(
  id: string,
  target: { exit_code: number; expected_code?: number | undefined },
): VerificationResult {
  const expected = target.expected_code ?? 0;
  const satisfied = target.exit_code === expected;
  return {
    id,
    type: 'process_exit',
    satisfied,
    message: satisfied
      ? `Process exited with expected code ${expected}`
      : `Process exited with code ${target.exit_code}, expected ${expected}`,
    evidence: {
      id: `ev-${id}`,
      type: 'text',
      uri: `process://exit/${target.exit_code}`,
      description: `Process exit code: ${target.exit_code}`,
      captured_at: new Date().toISOString(),
    },
  };
}

/**
 * macOS AX要素の状態を検証する。
 */
export async function verifyAxState(
  id: string,
  target: {
    app?: string | undefined;
    role?: string | undefined;
    title?: string | undefined;
    value?: string | undefined;
    expected_found?: boolean | undefined;
  },
  env: VerifierEnvironment = defaultEnv,
): Promise<VerificationResult> {
  const expectedFound = target.expected_found ?? true;
  if (!env.queryAx) {
    // queryAx環境が注入されていない場合は検証不可
    return {
      id,
      type: 'ax_element_state',
      satisfied: false,
      message: 'AX verifier query environment is not available',
    };
  }

  const queryRes = await env.queryAx({
    app: target.app,
    role: target.role,
    title: target.title,
    value: target.value,
  });

  const match = queryRes.found === expectedFound;
  if (!match) {
    return {
      id,
      type: 'ax_element_state',
      satisfied: false,
      message: `AX element condition not satisfied (found=${queryRes.found}, expected=${expectedFound})`,
    };
  }

  if (target.value !== undefined && queryRes.value !== target.value) {
    return {
      id,
      type: 'ax_element_state',
      satisfied: false,
      message: `AX element value "${queryRes.value}" does not match expected "${target.value}"`,
    };
  }

  return {
    id,
    type: 'ax_element_state',
    satisfied: true,
    message: `AX element state verified: ${target.app ?? ''} [${target.role ?? ''}] "${target.title ?? ''}"`,
    evidence: {
      id: `ev-${id}`,
      type: 'element_id',
      uri: `ax://${target.app ?? 'unknown'}/${target.role ?? 'any'}/${encodeURIComponent(target.title ?? '')}`,
      description: `AX element found=${queryRes.found}, value=${queryRes.value ?? ''}`,
      captured_at: new Date().toISOString(),
    },
  };
}

/**
 * 汎用的な検証ディスパッチャー。
 */
export async function verifyCriterion(
  criterion: VerificationCriteria,
  env: VerifierEnvironment = defaultEnv,
): Promise<VerificationResult> {
  const target = criterion.target as Record<string, unknown>;

  switch (criterion.type) {
    case 'file_exists':
      return verifyFileExists(
        criterion.id,
        {
          path: String(target['path'] ?? ''),
          min_bytes: typeof target['min_bytes'] === 'number' ? target['min_bytes'] : undefined,
          mtime_after_ms:
            typeof target['mtime_after_ms'] === 'number' ? target['mtime_after_ms'] : undefined,
        },
        env,
      );

    case 'file_content':
      return verifyFileContent(
        criterion.id,
        {
          path: String(target['path'] ?? ''),
          contains: typeof target['contains'] === 'string' ? target['contains'] : undefined,
          pattern: typeof target['pattern'] === 'string' ? target['pattern'] : undefined,
        },
        env,
      );

    case 'process_exit':
      return verifyProcessExit(criterion.id, {
        exit_code: Number(target['exit_code'] ?? -1),
        expected_code:
          typeof target['expected_code'] === 'number' ? target['expected_code'] : 0,
      });

    case 'ax_element_state':
      return verifyAxState(
        criterion.id,
        {
          app: typeof target['app'] === 'string' ? target['app'] : undefined,
          role: typeof target['role'] === 'string' ? target['role'] : undefined,
          title: typeof target['title'] === 'string' ? target['title'] : undefined,
          value: typeof target['value'] === 'string' ? target['value'] : undefined,
          expected_found:
            typeof target['expected_found'] === 'boolean' ? target['expected_found'] : true,
        },
        env,
      );

    default:
      return {
        id: criterion.id,
        type: criterion.type,
        satisfied: false,
        message: `Unsupported verification type: ${criterion.type}`,
      };
  }
}

/**
 * 複数の検証基準を評価し、すべて満たされているかを判定する。
 */
export async function verifyAllCriteria(
  criteriaList: readonly VerificationCriteria[],
  env: VerifierEnvironment = defaultEnv,
): Promise<{ allSatisfied: boolean; results: VerificationResult[] }> {
  const results: VerificationResult[] = [];
  let allSatisfied = true;

  for (const crit of criteriaList) {
    const res = await verifyCriterion(crit, env);
    results.push(res);
    if (!res.satisfied) {
      allSatisfied = false;
    }
  }

  return { allSatisfied, results };
}
