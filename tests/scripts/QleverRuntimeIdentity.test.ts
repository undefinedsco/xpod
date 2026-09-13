import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
const { checkRuntimeIdentity } = require('../../scripts/check-qlever-runtime-identity.cjs');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(overrides: Record<string, string> = {}, corruptBinary = false) {
  const root = mkdtempSync(join(tmpdir(), 'xpod-runtime-identity-'));
  roots.push(root);
  const lock = { repository: 'https://example.test/qlever.git', commit: 'abc', patchSeriesSha256: 'def' };
  const binary = Buffer.from('test runtime bytes');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'lock.json'), JSON.stringify(lock));
  writeFileSync(join(root, 'bin/xpod_qlever_local_runtime'), corruptBinary ? 'corrupted' : binary);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    qlever: { ...lock, ...overrides },
    artifacts: [{ path: 'bin/xpod_qlever_local_runtime', size: binary.length,
      sha256: createHash('sha256').update(binary).digest('hex') }],
  }));
  return () => checkRuntimeIdentity(join(root, 'lock.json'), root);
}

describe('service image QLever runtime identity gate', () => {
  it('accepts matching source and binary identities', () => expect(fixture()).not.toThrow());
  it.each(['repository', 'commit', 'patchSeriesSha256'])('rejects a stale %s', (key) => {
    expect(fixture({ [key]: 'old' })).toThrow('does not match the current source lock');
  });
  it('rejects a binary that differs from the manifest', () => {
    expect(fixture({}, true)).toThrow('binary does not match');
  });
});
