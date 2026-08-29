import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('authentication authority boundaries', () => {
  it('keeps the CSS Account SPA native and free of Solid session ownership', async () => {
    const app = await source('ui/src/App.tsx');

    expect(app).toContain('AuthProvider');
    expect(app).not.toContain('XpodAuthProvider');
    expect(app).not.toContain('XpodSolidRuntimeProvider');
    expect(app).not.toContain('useXpodAuth');
  });

  it('mounts Account and WebID runtimes independently in the product shell', async () => {
    const shell = await source('ui/src/XpodShellApp.tsx');

    expect(shell).toContain('AuthProvider');
    expect(shell).toContain('XpodSolidRuntimeProvider');
    expect(shell).not.toContain('XpodAuthProvider');
    expect(shell).not.toContain('XpodAuthContext');
  });

  it('keeps the AI Connections applet independent from Account auth', async () => {
    const host = await source('ui/src/extensions/ai-connections-host.ts');

    expect(host).not.toContain('useXpodAuth');
    expect(host).not.toContain('XpodAuthContext');
    expect(host).not.toContain('AccountAuth');
    expect(host).not.toContain('/.account/');
  });

  it('does not admit CSS Account tokens into the API principal chain', async () => {
    const container = await source('src/api/container/common.ts');
    const authContext = await source('src/api/auth/AuthContext.ts');

    expect(container).not.toContain('CssAccountTokenAuthenticator');
    expect(authContext).not.toContain('AccountAuthContext');
    expect(authContext).not.toContain("type: 'account'");
  });
});
