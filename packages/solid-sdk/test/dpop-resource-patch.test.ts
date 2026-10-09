import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { patchResourceDpop, RESOURCE_DPOP_MARKER } = require('../../../scripts/patch-inrupt-authn-transport.js');
const coreRoot = new URL('../../../node_modules/@inrupt/solid-client-authn-core/', import.meta.url);

describe.each([
  ['src/authenticatedFetch/dpopUtils.ts', 'source'],
  ['src/authenticatedFetch/fetchFactory.ts', 'factory'],
  ['dist/authenticatedFetch/dpopUtils.d.ts', 'dts'],
  ['dist/index.js', 'cjs'],
  ['dist/index.mjs', 'esm'],
])('pinned resource signer patch %s', (file, kind) => {
  const content = readFileSync(new URL(file, coreRoot), 'utf8');

  it('is applied exactly once and remains idempotent', () => {
    expect(content.split(RESOURCE_DPOP_MARKER)).toHaveLength(2);
    expect(patchResourceDpop(content, kind)).toBe(content);
  });

  it('rejects duplicate markers instead of reapplying the patch', () => {
    expect(() => patchResourceDpop(`${content}\n// ${RESOURCE_DPOP_MARKER}`, kind)).toThrow('Incomplete');
  });

  it('rejects a marker without its required token-binding implementation', () => {
    const damaged = content.replace(kind === 'factory' ? 'dpopKey, authToken)' :
      kind === 'dts' || kind === 'source' ? 'accessToken?: string' :
        'globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken))', 'missing implementation');
    expect(() => patchResourceDpop(damaged, kind)).toThrow('Incomplete');
  });
});
