import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { buildVerificationAuditRow } from './verificationAudit';

describe('verificationAudit HMAC privacy hashing', () => {
  const secret = 'test-secret';

  it('does not include raw IP or User-Agent in audit rows', () => {
    const row = buildVerificationAuditRow({
      token: 'raw-token-value',
      ip: '203.0.113.42',
      userAgent: 'Mozilla/5.0 (Raw UA)',
      secret,
    });

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('203.0.113.42');
    expect(serialized).not.toContain('Mozilla/5.0 (Raw UA)');
    expect(serialized).not.toContain('raw-token-value');
  });

  it('produces stable hashes across repeated calls with the same secret', () => {
    const input = {
      token: 'stable-token',
      ip: '198.51.100.7',
      userAgent: 'StableAgent/1.0',
      secret,
    };

    const first = buildVerificationAuditRow(input);
    const second = buildVerificationAuditRow(input);

    expect(first).toEqual(second);
  });

  it('changes hashes when the secret changes', () => {
    const base = {
      token: 'same-token',
      ip: '198.51.100.7',
      userAgent: 'StableAgent/1.0',
    };

    const withSecretA = buildVerificationAuditRow({ ...base, secret: 'secret-a' });
    const withSecretB = buildVerificationAuditRow({ ...base, secret: 'secret-b' });

    expect(withSecretA).not.toEqual(withSecretB);
  });

  it('normalizes null and whitespace-only inputs consistently', () => {
    const nullRow = buildVerificationAuditRow({
      token: null,
      ip: null,
      userAgent: null,
      secret,
    });

    const whitespaceRow = buildVerificationAuditRow({
      token: '   ',
      ip: '\t\n ',
      userAgent: '  ',
      secret,
    });

    expect(nullRow).toEqual(whitespaceRow);
  });

  it('pins the field mapping of the audit row', () => {
    const row = buildVerificationAuditRow({
      token: 'mapping-token',
      ip: '192.0.2.10',
      userAgent: 'MappingAgent/2.0',
      secret,
    });

    expect(Object.keys(row).sort()).toEqual(
      ['tokenHash', 'ipHash', 'userAgentHash'].sort(),
    );

    expect(row.tokenHash).toBe(
      createHmac('sha256', secret).update('mapping-token').digest('hex'),
    );
    expect(row.ipHash).toBe(
      createHmac('sha256', secret).update('192.0.2.10').digest('hex'),
    );
    expect(row.userAgentHash).toBe(
      createHmac('sha256', secret).update('MappingAgent/2.0').digest('hex'),
    );
  });
});
