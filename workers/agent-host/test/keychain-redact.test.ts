import { describe, expect, it } from 'vitest';
import { redactSecurityOutput } from '../src/keychain.js';

describe('keychain write diagnostics', () => {
  it('keeps what happened and drops anything that could be a value or a name', () => {
    const said = redactSecurityOutput(
      'security: SecKeychainItemModifyContent: User interaction is not allowed.\nadd-generic-password -U -a "astra-host-mac" -s "com.astra.connector.x" -X 7b22746f6b656e223a2279613239',
    );
    expect(said).toContain('User interaction is not allowed');
    expect(said).not.toMatch(/7b22|astra-host|com\.astra|ya29/);
    expect(redactSecurityOutput('ya29.A0ARrdaM-secretTOKENvalue1234 failed')).not.toContain('ya29');
  });
});
