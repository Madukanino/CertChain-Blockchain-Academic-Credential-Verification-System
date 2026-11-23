import { readFileSync } from 'fs';
import { resolve } from 'path';

// Paths relative to the repo root; adjust '../../../' if your test runs from a different cwd.
const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const VERSION_RE = /sha256:canonical-json:v(\d+)/g;

function versionsIn(text: string): number[] {
  return [...text.matchAll(VERSION_RE)].map((m) => Number(m[1]));
}

describe('credential hash version stays consistent across code and docs', () => {
  const codeVersions = versionsIn(read('frontend/src/lib/credentialHash.ts'));
  const latest = Math.max(...codeVersions);

  it('code defines at least one hash version', () => {
    expect(codeVersions.length).toBeGreaterThan(0);
  });

  it.each(['README.md', 'docs/verifiable-credentials.md'])(
    '%s documents the latest version (v%s from code)',
    (file) => {
      const text = read(file);
      expect(text).toContain(`sha256:canonical-json:v${latest}`);
    },
  );

  it('README does not call an older version "current"', () => {
    const text = read('README.md');
    for (let v = 1; v < latest; v++) {
      expect(text).not.toMatch(
        new RegExp(`sha256:canonical-json:v${v}[^\\n]{0,80}\\bcurrent\\b`, 'i'),
      );
    }
  });
});
