import { isAbsolute } from 'node:path';
import { GenieError, type McpServerDecl } from '@genie/contracts';
import { McpClient } from './client.js';
import { stdioChannel } from './transport.js';
import type { ToolCallResult } from './protocol.js';

export interface OathraPhoneInput {
  readonly phone: string;
  readonly name: string;
  readonly instruction: string;
  readonly callerName?: string;
  readonly conversationMode?: 'message' | 'chat';
  readonly engine?: 'gpt-live' | 'gemini-live';
  readonly voice?: string;
  readonly voicePreset?: 'character-female' | 'character-male' | 'sales-female' | 'sales-male' | 'guide-female' | 'guide-male';
}
export interface OathraDraftResult {
  readonly apiVersion: 1;
  readonly kind: 'oathra.phone-draft';
  readonly missionId: string;
  readonly status: 'DRAFT';
  readonly dialed: false;
  readonly humanReview: { readonly required: true; readonly missionId: string; readonly gatewayUrl: string };
}
export interface OathraCallResult {
  readonly apiVersion: 1;
  readonly kind: 'oathra.phone-result';
  readonly missionId: string;
  /** Preserve the Gateway's canonical status; never derive success from `state`. */
  readonly status: string;
  readonly state: string;
  readonly result: unknown;
  readonly memory: unknown;
  readonly voiceSetting: unknown;
  readonly evidenceNotice: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const rejected = () => new GenieError('host.capability_denied', 'Oathraの応答を確認できません。再実行せず、Oathraで状況を確認してください。', { retryable: false });
function payload(result: ToolCallResult): Record<string, unknown> {
  let value: unknown = result.structuredContent;
  if (value === undefined) {
    try { value = JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')); }
    catch { throw rejected(); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>)['apiVersion'] !== 1) throw rejected();
  return value as Record<string, unknown>;
}
/**
 * Host-side integration. Approval here permits forwarding the draft's personal data,
 * NOT placing the call. The model is never given an approval token or a start tool.
 */
export class OathraClient {
  constructor(private readonly client: Pick<McpClient, 'callTool' | 'close'>) {}
  async capabilities(): Promise<Record<string, unknown>> {
    const value = payload(await this.client.callTool('oathra_phone_capabilities', {}, { approved: false }));
    if (value['kind'] !== 'oathra.phone-capabilities') throw rejected();
    return value;
  }
  async draft(input: OathraPhoneInput, context: { readonly approved: boolean }): Promise<OathraDraftResult> {
    if (!context.approved) throw new GenieError('plugin.permission_denied', '電話番号と依頼内容をOathraへ渡す前に確認が必要です。');
    let value: Record<string, unknown>;
    try { value = payload(await this.client.callTool('oathra_phone_draft', { ...input }, context)); }
    catch { throw rejected(); } // Draft POST has no retry guarantee. Do not inherit MCP's generic retryable flag.
    const review = value['humanReview'] as Record<string, unknown> | undefined;
    if (value['kind'] !== 'oathra.phone-draft' || value['status'] !== 'DRAFT' || value['dialed'] !== false || !UUID.test(String(value['missionId'] ?? '')) || review?.['required'] !== true || review['missionId'] !== value['missionId']) throw rejected();
    return value as unknown as OathraDraftResult;
  }
  async result(missionId: string, includeTranscript = false): Promise<OathraCallResult> {
    if (!UUID.test(missionId)) throw rejected();
    const value = payload(await this.client.callTool('oathra_phone_result', { id: missionId, includeTranscript }, { approved: false }));
    if (value['kind'] !== 'oathra.phone-result' || value['missionId'] !== missionId || typeof value['status'] !== 'string' || typeof value['state'] !== 'string') throw rejected();
    return value as unknown as OathraCallResult;
  }
  async close(): Promise<void> { await this.client.close(); }
}
export interface OathraConnectionOptions {
  /** Absolute path of a trusted, locally installed Oathra apps/gateway/mcp.mjs. Never supplied by a model. */
  readonly serverPath: string;
  readonly gatewayUrl: string;
  /** Read from the local secret store, never put in a task, prompt, command argument or URL. */
  readonly token: string;
}
export async function connectOathra(options: OathraConnectionOptions): Promise<OathraClient> {
  if (!isAbsolute(options.serverPath)) throw new GenieError('plugin.permission_denied', 'Oathra MCPの絶対パスを指定してください。');
  const url = new URL(options.gatewayUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw rejected();
  if (!options.token || /[\r\n]/.test(options.token)) throw rejected();
  const server: McpServerDecl = {
    id: 'oathra', transport: 'stdio', surface: 'local', command: process.execPath, args: [options.serverPath],
    tool_risks: { oathra_phone_capabilities: 'READ', oathra_phone_draft: 'EXTERNAL_COMMIT', oathra_phone_result: 'READ' },
  };
  const channel = stdioChannel({ command: process.execPath, args: [options.serverPath], env: { OATHRA_GATEWAY_URL: url.origin, OATHRA_GATEWAY_TOKEN: options.token } });
  const client = new McpClient({ server, channel, trust: 'TRUSTED' });
  try {
    await client.initialize();
    // stdioChannel handles messages without IDs as notifications, with no response wait.
    await channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = await client.listTools();
    if (!['oathra_phone_capabilities', 'oathra_phone_draft', 'oathra_phone_result'].every(name => tools.some(t => t.name === name))) throw rejected();
    return new OathraClient(client);
  } catch (error) { await client.close(); throw error; }
}
