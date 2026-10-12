import { connectionConfiguration } from './connection-configuration.js';
/**
 * Local Agent Host の起動口。正本 §4.4。
 *
 *   pnpm --filter @genie/worker-agent-host start
 *
 * **Dock とは別プロセス。**Dock を閉じても、これは動き続ける。
 */
import { cloudClient } from './cloud.js';
import { ApiSession } from './api-session.js';
import { acquireHostInstance } from './instance-lock.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { runInitialProfile } from './initial-profile.js';
import { createLogger } from '@genie/telemetry';
import { credentialRef, connectorProviderConfig, type OauthProvider } from '@genie/oauth';
import { LocalAgentHost } from './host.js';
import { httpTransport } from './transport.js';
import { keychainFor } from './keychain.js';
import { liveFaultTransport } from './live-fault-transport.js';
import { ConnectorRuntime } from './connector-steps.js';
import { HostStepLoop } from './step-loop.js';
import { httpStepTransport } from './step-transport.js';
import { CodexCli } from './codex.js';
import { ClaudeCodeCli } from './claude-code.js';
import { LlmRuntime } from './llm-steps.js';
import { HttpLlmClient } from './http-llm.js';
import { CompositeRunner } from './runner.js';
import { ExecutionRuntime } from './execution-runtime.js';
import { apiExecutionAdapters, nativeExecutionAdapters } from './execution-adapters.js';
import { mappedMcpAdapter } from './execution-mcp.js';
import { ComputerVisionRuntime } from './computer-vision.js';
import { NativeVisionDevice } from './computer-vision-device.js';
import { selectLanguageModel } from '@genie/contracts';
import type { WorkSyncState, LanguageModelKind } from '@genie/contracts';
import { DEFAULT_SYNC_INTERVAL_MS, WorkSyncLoop } from './work-sync.js';
import {
  grantsFromConnections,
  knownPluginIds,
  mergeGrants,
  type ConnectionRecord,
} from './grants.js';

async function main(): Promise<void> {
  const logger = createLogger({
    service: 'agent-host',
    level: process.env['ASTRA_LOG_LEVEL'] ?? 'info',
  });

  const baseUrl = process.env['ASTRA_API_URL'] ?? 'http://127.0.0.1:8080';
  const deviceLabel = process.env['ASTRA_DEVICE_LABEL'] ?? `${process.env['USER'] ?? 'device'}`;
  // A refresh chain must never be opened by two host processes. Acquire this
  // before Keychain reads/writes or bootstrap credentials can replace each other.
  const storeIdentity = process.env['ASTRA_SECRET_STORE_FILE']
    ? resolve(process.env['ASTRA_SECRET_STORE_FILE'])
    : `${homedir()}:astra-host-${deviceLabel}`;
  const instance = await acquireHostInstance(`${storeIdentity}:${new URL(baseUrl).origin}`);
  const apiSession = new ApiSession({
    baseUrl,
    ...(process.env['ASTRA_HOST_TOKEN'] ? { token: process.env['ASTRA_HOST_TOKEN'] } : {}),
    ...(process.env['ASTRA_HOST_REFRESH_TOKEN']
      ? { refreshToken: process.env['ASTRA_HOST_REFRESH_TOKEN'] }
      : {}),
    secrets: keychainFor(process.platform, `astra-host-${deviceLabel}`),
  });
  // Credentials must not be inherited by model CLIs or tools launched below.
  delete process.env['ASTRA_HOST_TOKEN'];
  delete process.env['ASTRA_HOST_REFRESH_TOKEN'];
  await apiSession.start();
  const token = ''; // Authorization is supplied at request time by apiSession.fetch.

  /*
   * 言葉を扱う仕事も端末で。正本 §21、UI/UX §22。
   *
   * **Genie は共通の API キーを持たない。**利用者が持ち込んだ利用権は
   * 端末の側にあるので、呼ぶのも端末になる。
   * Claude Code のログインは Claude Code のもので、Genie は読まない。
   */
  const preferredCli = process.env['ASTRA_LLM_CLI'];
  if (preferredCli && !['codex', 'claude_code', 'api', 'local', 'none'].includes(preferredCli))
    throw new Error('ASTRA_LLM_CLI must be codex, claude_code, api, local, or none');
  const llmKeychain = keychainFor(process.platform, deviceLabel);
  const httpClients: Partial<
    Record<'anthropic_api' | 'gemini_api' | 'openai_api' | 'local', HttpLlmClient>
  > = {};
  const httpConfigs = [
    [
      'anthropic_api',
      process.env['ASTRA_ANTHROPIC_API_URL'],
      'llm.anthropic_api',
      process.env['ASTRA_ANTHROPIC_MODEL'] ?? 'claude-3-5-sonnet-latest',
    ],
    [
      'gemini_api',
      process.env['ASTRA_GEMINI_API_URL'],
      'llm.gemini_api',
      process.env['ASTRA_GEMINI_MODEL'] ?? 'gemini-2.5-flash',
    ],
    [
      'openai_api',
      process.env['ASTRA_OPENAI_API_URL'],
      'llm.openai_api',
      process.env['ASTRA_OPENAI_MODEL'] ?? 'gpt-4o-mini',
    ],
    [
      'local',
      process.env['ASTRA_LOCAL_LLM_URL'],
      'llm.local',
      process.env['ASTRA_LOCAL_LLM_MODEL'] ?? 'llama3.2',
    ],
  ] as const;
  for (const [kind, endpoint, keyName, model] of httpConfigs) {
    if (!endpoint) continue;
    let apiKey: string | undefined;
    if (kind !== 'local') {
      try {
        apiKey = (await llmKeychain.get(keyName)) ?? undefined;
      } catch (error) {
        logger.warn(
          { error, kind },
          'LLM API key could not be read from the local credential store',
        );
      }
    }
    const reasoningEffort =
      kind === 'local' ? process.env['ASTRA_LOCAL_LLM_REASONING_EFFORT'] : undefined;
    if (reasoningEffort && !['none', 'low', 'medium', 'high'].includes(reasoningEffort))
      throw new Error('ASTRA_LOCAL_LLM_REASONING_EFFORT must be none, low, medium, or high');
    httpClients[kind] = new HttpLlmClient({
      kind,
      endpoint,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(reasoningEffort
        ? { reasoningEffort: reasoningEffort as 'none' | 'low' | 'medium' | 'high' }
        : {}),
      ...(process.env['ASTRA_LLM_MAX_OUTPUT_TOKENS'] === undefined
        ? {}
        : { maxOutputTokens: Number(process.env['ASTRA_LLM_MAX_OUTPUT_TOKENS']) }),
    });
  }
  const allowedKinds: readonly LanguageModelKind[] | undefined =
    preferredCli === 'api'
      ? ['anthropic_api', 'gemini_api', 'openai_api']
      : preferredCli === 'none'
        ? []
        : preferredCli
          ? [preferredCli as LanguageModelKind]
          : undefined;
  const llm = new LlmRuntime({
    ...(allowedKinds ? { allowedKinds } : {}),
    ...(!preferredCli || preferredCli === 'codex'
      ? {
          codex: new CodexCli({
            ...(process.env['ASTRA_CODEX_TIMEOUT_MS'] !== undefined
              ? { timeoutMs: Number(process.env['ASTRA_CODEX_TIMEOUT_MS']) }
              : {}),
            ...(process.env['ASTRA_CODEX_PATH']
              ? { command: process.env['ASTRA_CODEX_PATH'] }
              : {}),
            ...(process.env['ASTRA_CODEX_MODEL']
              ? { model: process.env['ASTRA_CODEX_MODEL'] }
              : {}),
          }),
        }
      : {}),
    ...(!preferredCli || preferredCli === 'claude_code'
      ? {
          claudeCode: new ClaudeCodeCli({
            ...(process.env['ASTRA_CLAUDE_CODE_PATH']
              ? { command: process.env['ASTRA_CLAUDE_CODE_PATH'] }
              : {}),
            ...(process.env['ASTRA_CLAUDE_CODE_MODEL']
              ? { model: process.env['ASTRA_CLAUDE_CODE_MODEL'] }
              : {}),
          }),
        }
      : {}),
    ...(Object.keys(httpClients).length ? { http: httpClients } : {}),
  });

  /*
   * この端末で使えるモデル。**空なら仕事を受けない。**
   * 受けてから失敗するより、受けないほうがよい。
   *
   * **名乗る前に確かめる。**環境変数から読んでいた間、
   * Claude Code が入っていない端末が「claude_code が使えます」と名乗り、
   * 仕事を受けてから失敗していた。名乗りは調べた結果でなければ意味が無い。
   */
  const probed = await llm.options();
  const models = probed.filter((option) => option.available).map((option) => option.kind);
  logger.info(
    { models: probed.map((o) => ({ kind: o.kind, available: o.available, reason: o.reason })) },
    'language models on this device',
  );

  /*
   * 同意の結果。**この端末が保持する。**
   * `ASTRA_GRANTED_SCOPES` は `plugin=scope,scope;plugin=...` の形。
   * 空なら何も許されていないものとして扱う（既定で通さない）。
   */
  const envGrants = parseGrants(process.env['ASTRA_GRANTED_SCOPES'] ?? '');
  /*
   * 許可の正本は cloud の接続記録（実際に許された provider scope）。環境変数は harness の上書き。
   * 起動時に読み、同期の周期で読み直す（繋ぎ直し・切断が効くように）。
   */
  let grantedScopes: Record<string, string[]> = mergeGrants({}, envGrants);
  const redirectUri = process.env['ASTRA_OAUTH_REDIRECT_URI'] ?? 'http://127.0.0.1:0/callback';

  const refreshGrants = async (): Promise<void> => {
    const items: ConnectionRecord[] = [];
    for (const pluginId of knownPluginIds()) {
      try {
        const response = await apiSession.fetch(
          `${baseUrl}/v1/plugins/${encodeURIComponent(pluginId)}/connections`,
          {
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (!response.ok) continue;
        const body = (await response.json()) as { items?: ConnectionRecord[] };
        items.push(...(body.items ?? []));
      } catch {
        // 読めなければ今の許可のまま。無いものを許したことにはしない。
      }
    }
    grantedScopes = mergeGrants(grantsFromConnections(items), envGrants);
  };
  await refreshGrants();
  logger.info({ grants: grantedScopes }, 'connector permissions from the cloud connection records');

  const host = new LocalAgentHost({
    deviceLabel,
    models,
    transport: httpTransport({ baseUrl, token, fetch: apiSession.fetch }),
    runner: {
      // 実際の実行は Phase 5（BYOK / Claude Code）で差し込む
      async run({ stillLeased }) {
        if (!stillLeased()) return;
      },
    },
    onError: (error) => logger.warn({ err: error.message }, 'heartbeat failed'),
  });

  const id = await host.start();
  logger.info({ host_id: id, device_label: deviceLabel, models }, 'local agent host started');

  /*
   * connector の step を取りに来る側。正本 §2.4・§21。
   *
   * **鍵はこの端末から出ない。**cloud から来るのは「何をしてほしいか」だけで、
   * トークンは OS の資格情報ストアから、呼ぶ直前にだけ読む。
   */
  const secrets = keychainFor(process.platform, process.env['USER'] ?? 'astra');
  const faultFetch = liveFaultTransport(process.env);
  const runtime = new ConnectorRuntime({
    secrets,
    ...(faultFetch ? { fetch: faultFetch } : {}),
    credentialRefFor: credentialRef,
    /*
     * 実際に許された scope。**要求した scope ではない。**
     * 同意画面で外された分をここに含めると、
     * 「許したはずが無い操作」が端末側の検査を通ってしまう。
     */
    grantedScopes: (pluginId) => grantedScopes[pluginId] ?? [],
    // 設定されていない提供者は更新しない。切れたら繋ぎ直しを促す。
    refreshConfig: (provider, connectorId, scopes) => {
      const config = connectorProviderConfig(
        provider as OauthProvider,
        connectorId,
        scopes,
        connectionConfiguration(process.env),
      );
      return config ? { ...config, redirectUri: redirectUri } : null;
    },
  });

  const computerVision = new ComputerVisionRuntime({
    enabled: process.env['ASTRA_COMPUTER_USE'] === 'on',
    model: llm,
    selectModel: async () => selectLanguageModel(await llm.options())?.kind ?? null,
    allowExternalPixels: process.env['ASTRA_COMPUTER_VISION_EXTERNAL'] === 'on',
    device: () => new NativeVisionDevice(process.env['ASTRA_COMPUTER_VISION_HELPER'] ?? ''),
  });

  const execution = new ExecutionRuntime({
    deviceId: id,
    model: llm,
    adapters: [
      ...apiExecutionAdapters(runtime),
      ...(process.env['ASTRA_EXECUTION_MCP_CONFIG']
        ? [mappedMcpAdapter(process.env['ASTRA_EXECUTION_MCP_CONFIG'])]
        : []),
      ...nativeExecutionAdapters({
        vision: computerVision,
        ...(process.env['ASTRA_EXECUTION_AX_HELPER']
          ? { axHelper: process.env['ASTRA_EXECUTION_AX_HELPER'] }
          : {}),
        ...(process.env['ASTRA_COMPUTER_VISION_HELPER']
          ? { visionHelper: process.env['ASTRA_COMPUTER_VISION_HELPER'] }
          : {}),
        selectVisionModel: computerVision.config.selectModel,
        allowExternalPixels: computerVision.config.allowExternalPixels,
      }),
    ],
  });

  const steps = new HostStepLoop({
    transport: httpStepTransport({ baseUrl, token, fetch: apiSession.fetch }),
    runner: new CompositeRunner([execution, runtime, computerVision, llm]),
    onError: (error) => logger.warn({ err: error.message }, 'a step could not be handled'),
  });
  void steps.start(id);

  /*
   * Work Context の同期。正本 §6、Work Context 仕様。
   *
   * 繋いであるサービスだけを読み、**抜粋にして**cloud へ渡す。
   * 意味づけは端末の LLM。`ASTRA_WORK_SYNC=off` で止められる。
   */
  const cloud = cloudClient(baseUrl, token, apiSession.fetch);
  const workSync = new WorkSyncLoop({
    connectors: runtime,
    llm: llm.forBackground(process.env['ASTRA_WORK_SYNC_METERED_LLM'] === 'on'),
    ...(process.env['ASTRA_WORK_SYNC_GOOGLE_QUERY']
      ? { googleQuery: process.env['ASTRA_WORK_SYNC_GOOGLE_QUERY'] }
      : {}),
    ...(process.env['ASTRA_WORK_SYNC_MICROSOFT_QUERY']
      ? { microsoftQuery: process.env['ASTRA_WORK_SYNC_MICROSOFT_QUERY'] }
      : {}),
    push: async (batch) => {
      await cloud('/v1/work/artifacts', 'POST', batch);
    },
    // 続きは cloud の work_sync_state から（再起動しても 14 日分を読み直さない）。
    loadState: async () =>
      ((await cloud('/v1/work/sync', 'GET')) as { items: WorkSyncState[] }).items,
    attempt: async (source, attempt) => {
      await cloud(`/v1/work/sync/${source}/attempt`, 'POST', attempt);
    },
    onError: (source, error) =>
      logger.warn({ source, err: error.message }, 'work context sync failed for a source'),
  });
  let initialBusy = false;
  const initialTimer = setInterval(() => {
    // Initial profiling is explicitly requested in Connections. Disabling
    // continuous background sync must not strand that user-requested job.
    if (initialBusy) return;
    initialBusy = true;
    void runInitialProfile({ cloud, connectors: runtime, refreshGrants })
      .catch(() => logger.warn('initial profile could not finish; the lease will allow recovery'))
      .finally(() => {
        initialBusy = false;
      });
  }, 4_000);
  initialTimer.unref?.();
  if (process.env['ASTRA_WORK_SYNC'] !== 'off') {
    const minutes = Number(process.env['ASTRA_WORK_SYNC_INTERVAL_MIN']);
    const interval =
      Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_SYNC_INTERVAL_MS;
    workSync.start(interval);
    const grantsTimer = setInterval(() => void refreshGrants(), interval);
    grantsTimer.unref?.();
  }

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down the local agent host');
    clearInterval(initialTimer);
    workSync.stop();
    steps.stop();
    void host.stop().finally(async () => {
      await instance.release();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** `plugin=scope,scope;plugin=...` を読む。読めない部分は捨てる（推測しない）。 */
export function parseGrants(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of value.split(';')) {
    const [pluginId, scopes] = entry.split('=');
    if (!pluginId?.trim() || !scopes) continue;
    out[pluginId.trim()] = scopes
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return out;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
