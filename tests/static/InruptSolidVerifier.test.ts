import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function listAssets(): Promise<string[]> {
  return readdir(path.join(root, 'static/app/assets'));
}

async function readFirstAsset(prefix: string): Promise<string> {
  const files = await listAssets();
  const file = files.find((entry) => entry.startsWith(prefix) && entry.endsWith('.js'));
  if (!file) {
    throw new Error(`Missing static app asset with prefix ${prefix}`);
  }
  return readRepoFile(`static/app/assets/${file}`);
}

function hasAsset(files: string[], prefix: string): boolean {
  return files.some((entry) => entry.startsWith(prefix) && entry.endsWith('.js'));
}

describe('Inrupt Solid verifier app', () => {
  it('implements Cloud login and SP resource access with the Inrupt browser SDK', async () => {
    const source = await readRepoFile('ui/src/inrupt-smoke.ts');

    expect(source).toContain("@inrupt/solid-client-authn-browser");
    expect(source).toContain('new Session()');
    expect(source).toContain('login(');
    expect(source).toContain('handleIncomingRedirect');
    expect(source).toContain('session.fetch');
    expect(source).toContain('/.well-known/openid-configuration');
    expect(source).toContain('spResourceUrl');
    expect(source).toContain('discoverStorage');
    expect(source).toContain('solid:storage');
    expect(source).toContain('http://www.w3.org/ns/solid/terms#storage');
    expect(source).toContain('storagePath');
    expect(source).toContain('@undefineds.co/drizzle-solid');
    expect(source).toContain('drizzle(');
    expect(source).toContain('podUrl: homeUrl');
    expect(source).toContain('checkDrizzleReadWrite');
    expect(source).toContain('db.insert');
    expect(source).toContain('db.findById');
    expect(source).toContain('db.deleteById');
  });

  it('builds a dedicated /app/inrupt-smoke.html verifier page', async () => {
    const html = await readRepoFile('static/app/inrupt-smoke.html');
    const sourceHtml = await readRepoFile('ui/inrupt-smoke.html');

    expect(sourceHtml).toContain('Inrupt Solid Smoke');
    expect(html).toContain('Inrupt Solid Smoke');
    expect(html).toContain('/app/assets/inrupt-smoke.js');
  });

  it('keeps the generated verifier bundles available despite static asset ignores', async () => {
    const bundle = await readRepoFile('static/app/assets/inrupt-smoke.js');
    const helper = await readFirstAsset('_commonjsHelpers-');
    const assets = await listAssets();

    expect(bundle).toContain('solid-client-authn-browser');
    expect(bundle).toContain('drizzle-solid');
    expect(bundle).toContain('Inrupt Solid Smoke');
    expect(helper).toContain('modulepreload');
    expect(hasAsset(assets, 'index-')).toBe(true);
    expect(hasAsset(assets, 'index-browser-')).toBe(false);
  });
});
