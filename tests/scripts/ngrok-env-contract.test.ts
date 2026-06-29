import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const legacyPrefix = `${'XPOD'}_${'NGROK'}_`;
const legacyNames = ['AUTHTOKEN', 'URL', 'BIN'].map((name) => `${legacyPrefix}${name}`);

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('ngrok environment contract', () => {
  it('uses native ngrok environment names without XPOD aliases', async () => {
    const files = [
      'src/api/container/index.ts',
      'scripts/ngrok-tunnel-smoke.ts',
      'scripts/ngrok-pod-readwrite-smoke.ts',
      'scripts/ngrok-browser-pod-smoke.ts',
      'scripts/ngrok-inrupt-oidc-smoke.ts',
    ];

    for (const file of files) {
      const source = await readRepoFile(file);
      expect(source, file).toContain('NGROK_AUTHTOKEN');
      for (const legacyName of legacyNames) {
        expect(source, file).not.toContain(legacyName);
      }
    }
  });
});
