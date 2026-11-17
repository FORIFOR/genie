import { describe, expect, it } from 'vitest';
import { lineOrcaRequest } from '../src/channels.js';

describe('LINE coding request routing', () => {
  it('selects the named fallback only when the sender explicitly asks for a limit handoff', () => {
    expect(
      lineOrcaRequest(
        'GenieのREADMEをClaudeで修正してください。利用上限に達したらCodexへ引き継いでください。',
      ),
    ).toEqual({ agent: 'claude', fallbackAgent: 'codex' });
    expect(lineOrcaRequest('GenieのREADMEをClaudeで修正してください。')).toEqual({
      agent: 'claude',
    });
  });

  it('leaves normal questions and requests without a named coding agent in chat', () => {
    expect(lineOrcaRequest('Claudeのコードについて教えてください。')).toBeNull();
    expect(lineOrcaRequest('明日の予定を教えて')).toBeNull();
    expect(lineOrcaRequest('GenieのREADMEを修正してください。')).toBeNull();
  });
});
