import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relativePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(relativePath)
      : entry.isFile() && relativePath.endsWith('.tsx') && !relativePath.endsWith('.test.tsx')
        ? [relativePath]
        : [];
  }));
  return files.flat();
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
    const controller = await source('packages/ai-connections/src/controller.tsx');
    const main = await source('packages/ai-connections/src/AiConnectionsMain.tsx');

    expect(host).not.toContain('useXpodAuth');
    expect(host).not.toContain('XpodAuthContext');
    expect(host).not.toContain('AccountAuth');
    expect(host).not.toContain('/.account/');
    expect(controller).not.toContain('/.account/');
    expect(controller).not.toContain('requireLogin');
    expect(controller).not.toContain('loginRoutes');
    expect(main).not.toContain('SolidAuthBoundary');
  });

  it('does not admit CSS Account tokens into the API principal chain', async () => {
    const container = await source('src/api/container/common.ts');
    const authContext = await source('src/api/auth/AuthContext.ts');

    expect(container).not.toContain('CssAccountTokenAuthenticator');
    expect(authContext).not.toContain('AccountAuthContext');
    expect(authContext).not.toContain("type: 'account'");
  });

  it('prevents Xpod product flows from selecting a generic auth host or presentation', async () => {
    const allowedPrimitives = new Set([
      'ui/src/auth/XpodAccountViews.tsx',
      'ui/src/auth/XpodAuthSurface.tsx',
    ]);
    const directImports: string[] = [];
    const allowedAccountSurfaces = new Set([
      'ui/src/auth/XpodAccountCredentials.tsx',
      'ui/src/auth/XpodAuthSurface.tsx',
    ]);
    const directAccountSurfaces: string[] = [];

    for (const relativePath of await sourceFiles('ui/src')) {
      const contents = await source(relativePath);
      if (!allowedPrimitives.has(relativePath)
        && /import\s*\{[^}]*\bAuthSurface\b[^}]*\}\s*from\s*['"]@undefineds\.co\/shared-ui['"]/su.test(contents)) {
        directImports.push(relativePath);
      }
      if (!allowedAccountSurfaces.has(relativePath)
        && /import\s*\{[^}]*\bAccountCredentialsSurface\b[^}]*\}\s*from\s*['"][^'"]*XpodAccountViews['"]/su.test(contents)) {
        directAccountSurfaces.push(relativePath);
      }
    }

    expect(directImports).toEqual([]);
    expect(directAccountSurfaces).toEqual([]);
  });
});
