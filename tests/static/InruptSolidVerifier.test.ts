import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
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
    const helper = await readRepoFile('static/app/assets/_commonjsHelpers-B-UnjaXt.js');

    expect(bundle).toContain('solid-client-authn-browser');
    expect(bundle).toContain('Inrupt Solid Smoke');
    expect(helper).toContain('modulepreload');
  });
});
