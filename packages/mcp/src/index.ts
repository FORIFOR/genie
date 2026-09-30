/**
 * @genie/mcp
 *
 * MCP を tool の供給源として扱う。正本 §9.1・§21、Phase 4 実装仕様 §7。
 * **外から来た宣言を信用しない**のが、この package の存在理由。
 */
export { McpClient, MAX_MCP_TOOLS, textOf, type McpClientOptions } from './client.js';
export {
  InitializeResult,
  JsonRpcResponse,
  JSONRPC_VERSION,
  PROTOCOL_VERSION,
  ToolCallResult,
  ToolsListResult,
  type McpTransportChannel,
} from './protocol.js';
export {
  httpChannel,
  stdioChannel,
  MAX_MESSAGE_BYTES,
  MCP_TIMEOUT_MS,
  type HttpOptions,
  type StdioOptions,
} from './transport.js';
export {
  connectOathra,
  OathraClient,
  type OathraConnectionOptions,
  type OathraPhoneInput,
  type OathraDraftResult,
  type OathraCallResult,
} from './oathra.js';
