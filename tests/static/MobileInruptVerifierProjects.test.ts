import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('mobile Inrupt verifier shells', () => {
  it('Harmony shell loads the shared Inrupt smoke verifier in a WebView', async () => {
    const page = await readRepoFile('harmony/minimal/entry/src/main/ets/pages/Index.ets');
    const readme = await readRepoFile('harmony/minimal/README.md');

    expect(page).toContain('Xpod Inrupt Smoke');
    expect(page).toContain('Web({ src:');
    expect(page).toContain('/app/inrupt-smoke.html');
    expect(page).not.toContain('/p2p-sessions');
    expect(page).not.toContain('/relay-sessions');
    expect(readme).toContain('Inrupt browser SDK');
    expect(readme).toContain('Cloud OIDC issuer');
    expect(readme).toContain('SP resource');
  });

  it('iOS shell loads the shared Inrupt smoke verifier in WKWebView', async () => {
    const contentView = await readRepoFile('ios/InruptSmoke/XpodInruptSmoke/ContentView.swift');
    const plist = await readRepoFile('ios/InruptSmoke/XpodInruptSmoke/Info.plist');

    expect(contentView).toContain('WKWebView');
    expect(contentView).toContain('/app/inrupt-smoke.html');
    expect(contentView).toContain('Xpod Inrupt Smoke');
    expect(plist).toContain('NSAllowsArbitraryLoads');
  });
});
