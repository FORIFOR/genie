// Wire fixture, not an Oathra backend or an actual call.
import { createInterface } from 'node:readline';
const id = '12345678-1234-1234-1234-123456789abc';
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'notifications/initialized') {
    initialized = true;
    continue;
  }
  let result;
  if (m.method === 'initialize')
    result = { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  else if (!initialized)
    result = {
      isError: true,
      content: [{ type: 'text', text: 'initialized_notification_missing' }],
    };
  else if (m.method === 'tools/list')
    result = {
      tools: ['oathra_phone_capabilities', 'oathra_phone_draft', 'oathra_phone_result'].map(
        (name) => ({ name, inputSchema: { type: 'object' } }),
      ),
    };
  else {
    const kind = m.params.name;
    let data;
    if (kind === 'oathra_phone_capabilities')
      data = {
        apiVersion: 1,
        kind: 'oathra.phone-capabilities',
        ready: false,
        inheritedUnrelatedCredential: !!process.env.UNRELATED_API_KEY,
      };
    else if (kind === 'oathra_phone_draft')
      data = {
        apiVersion: 1,
        kind: 'oathra.phone-draft',
        missionId: id,
        status: 'DRAFT',
        dialed: false,
        humanReview: { required: true, missionId: id, gatewayUrl: 'http://127.0.0.1:4244/' },
      };
    else
      data = {
        apiVersion: 1,
        kind: 'oathra.phone-result',
        missionId: id,
        status: 'INCOMPLETE',
        state: 'ended',
        result: { status: 'incomplete' },
        evidenceNotice: 'fixture only',
      };
    result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
}
