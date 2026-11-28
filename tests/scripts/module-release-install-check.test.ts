import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registryShimSource } from '../../scripts/module-release/install-check';

const base = path.resolve('.test-data/module-release-install-check');
mkdirSync(base, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('module release registry shim', () => {
  it('serves one package from a local tarball with its real SRI and leaves other requests alone', async () => {
    const tarball = path.join(base, 'module.tgz');
    writeFileSync(tarball, Buffer.from('fake module tarball'));
    const shim = path.join(base, 'shim.mjs');
    writeFileSync(shim, registryShimSource('@undefineds.co/xpod-api-darwin-arm64', '1.2.3', tarball));
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => { seen.push(String(input)); return new Response('upstream'); }) as typeof fetch;
    try {
      await import(shim);
      const metadata = await (await fetch('https://registry.npmjs.org/%40undefineds.co%2Fxpod-api-darwin-arm64/1.2.3')).json() as
        { name: string; version: string; dist: { integrity: string; tarball: string } };
      expect(metadata.name).toBe('@undefineds.co/xpod-api-darwin-arm64');
      expect(metadata.dist.integrity).toBe(`sha512-${createHash('sha512').update('fake module tarball').digest('base64')}`);
      expect(await (await fetch(metadata.dist.tarball)).text()).toBe('fake module tarball');
      expect(await (await fetch('https://example.invalid/other')).text()).toBe('upstream');
      expect(seen).toEqual(['https://example.invalid/other']);
    } finally {
      globalThis.fetch = original;
    }
  });
});
