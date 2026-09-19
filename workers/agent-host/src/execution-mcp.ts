import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { McpServerDecl, type McpServerDecl as Server } from '@genie/contracts';
import { McpClient, stdioChannel, httpChannel, type McpTransportChannel } from '@genie/mcp';
import { executionDigest, type ExecutionAdapter } from './execution-runtime.js';
import { object, matchesReadback, type ExecutionIntent } from './execution-policy.js';

interface Binding {
  operation: 'mail.draft' | 'calendar.create';
  writeTool: string;
  readTool: string;
}
interface Configuration {
  trusted: true;
  label: string;
  server: Server;
  bindings: Binding[];
}

/** The user-owned local manifest, not a model/server response, grants this narrowly mapped MCP route. */
async function configuration(path: string): Promise<Configuration> {
  if (!isAbsolute(path)) throw new Error('MCP execution config must have an absolute path');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32768 || stat.uid !== process.getuid?.() || stat.mode & 0o022)
      throw new Error('MCP config must be user-owned and not writable by others');
    const value = object(JSON.parse(await file.readFile('utf8')));
    if (
      value?.['trusted'] !== true ||
      typeof value['label'] !== 'string' ||
      value['label'].length > 120 ||
      !Array.isArray(value['bindings'])
    )
      throw new Error('Explicit MCP execution trust is required');
    const server = McpServerDecl.parse(value['server']);
    if (server.transport === 'stdio' && !isAbsolute(server.command ?? ''))
      throw new Error('An absolute server executable is required');
    if (server.transport === 'http') {
      const url = new URL(server.url!);
      if (
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      )
        throw new Error('HTTPS or loopback HTTP is required');
    }
    const bindings = value['bindings'].map((raw): Binding => {
      const row = object(raw);
      if (
        !row ||
        !['mail.draft', 'calendar.create'].includes(String(row['operation'])) ||
        typeof row['writeTool'] !== 'string' ||
        typeof row['readTool'] !== 'string' ||
        row['writeTool'] === row['readTool'] ||
        server.tool_risks[row['writeTool']] !== 'EXTERNAL_COMMIT' ||
        server.tool_risks[row['readTool']] !== 'READ'
      )
        throw new Error('MCP tools need explicit write/read risks');
      return row as unknown as Binding;
    });
    if (
      bindings.length < 1 ||
      bindings.length > 2 ||
      new Set(bindings.map((b) => b.operation)).size !== bindings.length
    )
      throw new Error('Ambiguous MCP execution bindings');
    return { trusted: true, label: value['label'], server, bindings };
  } finally {
    await file.close();
  }
}

async function withClient<T>(
  config: Configuration,
  signal: AbortSignal | undefined,
  use: (client: McpClient) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const channel: McpTransportChannel =
    config.server.transport === 'stdio'
      ? stdioChannel({ command: config.server.command!, args: config.server.args, env: {} })
      : httpChannel({
          url: config.server.url!,
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              redirect: 'error',
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
                : AbortSignal.timeout(30_000),
            }),
        });
  const abort = () => {
    void channel.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const client = new McpClient({ server: config.server, channel, trust: 'TRUSTED' });
    await client.initialize();
    signal?.throwIfAborted();
    return await use(client);
  } finally {
    signal?.removeEventListener('abort', abort);
    await channel.close();
  }
}

/** Compatible mapped tools accept canonical parameters and return canonical structuredContent. */
export function mappedMcpAdapter(path: string): ExecutionAdapter {
  const id = 'mcp:configured';
  let pinnedFingerprint: string | null = null;
  const inspect = async (config: Configuration, intent: ExecutionIntent, signal?: AbortSignal) => {
    const binding = config.bindings.find((b) => b.operation === intent.operation);
    if (!binding) return null;
    return withClient(config, signal, async (client) => {
      const tools = await client.listTools();
      const declared = tools.filter((t) => [binding.writeTool, binding.readTool].includes(t.name));
      if (declared.length !== 2) return null;
      return {
        binding,
        fingerprint: executionDigest([
          config,
          declared.sort((a, b) => a.name.localeCompare(b.name)),
        ]),
      };
    });
  };
  return {
    id,
    async probe(intent, signal) {
      const config = await configuration(path);
      const ready = await inspect(config, intent, signal);
      if (!ready) return null;
      pinnedFingerprint = ready.fingerprint;
      return {
        id,
        route: 'mcp',
        label: config.label,
        fingerprint: ready.fingerprint,
        operations: [ready.binding.operation],
        verification: 'readback',
      };
    },
    async execute(intent, _proof, _requestId, signal) {
      const config = await configuration(path);
      const ready = await inspect(config, intent, signal);
      if (!ready || ready.fingerprint !== pinnedFingerprint) throw new Error('MCP route changed');
      return withClient(config, signal, async (client) => {
        signal?.throwIfAborted();
        const written = await client.callTool(ready.binding.writeTool, intent.parameters, {
          approved: true,
        });
        const result = object(written.structuredContent);
        if (typeof result?.['id'] !== 'string' || !result['id'] || result['id'].length > 512)
          return { verified: false };
        signal?.throwIfAborted();
        // A separate read tool call is mandatory, never accept write.verified or a text answer.
        const read = await client.callTool(
          ready.binding.readTool,
          { id: result['id'] },
          { approved: false },
        );
        const verified = matchesReadback(intent, result['id'], read.structuredContent);
        return {
          verified,
          ...(verified ? { evidence: executionDigest(read.structuredContent) } : {}),
        };
      });
    },
  };
}
