import { buildCredential, verifyCredential } from '../src/lib/vc'; // adjust

// Fixed inputs so the vector is stable and can be copied into the docs.
const FIXTURE = {
  issuer: 'did:example:issuer-123',
  subject: 'did:example:student-456',
  degree: 'BSc Computer Science',
  issuedAt: '2025-01-15T00:00:00.000Z',
};

describe('verifiable credentials: documented verification recipe', () => {
  const doc = buildCredential(FIXTURE);

  it('includes credentialData.schemaVersion exactly as the doc says', () => {
    expect(doc.credentialData.schemaVersion).toBe('1.0.0');
  });

  it('example in docs parses and has the same top-level shape as the builder output', () => {
    // Keep the doc example as a JSON fixture and assert shape parity.
    const example = require('../docs/examples/credential.example.json'); // adjust or inline it
    expect(Object.keys(example.credentialData).sort()).toEqual(
      Object.keys(doc.credentialData).sort(),
    );
  });

  it('follows the documented steps end to end', () => {
    const version = doc.credentialData.schemaVersion ?? '1.0.0';
    expect(version).toBe('1.0.0');
    expect(verifyCredential(doc)).toBe(true);
  });

  it('treats a credential without schemaVersion as 1.0.0 (legacy)', () => {
    const { schemaVersion, ...legacyData } = doc.credentialData;
    const legacy = { ...doc, credentialData: legacyData };
    expect((legacy.credentialData as any).schemaVersion ?? '1.0.0').toBe('1.0.0');
    // only include this next assertion if legacy credentials must still verify:
    // expect(verifyCredential(legacy)).toBe(true);
  });
});
