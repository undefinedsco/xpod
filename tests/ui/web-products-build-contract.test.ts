import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

describe('Xpod web product build contract', () => {
  it('declares Settings as an independent Vite target', () => {
    const viteConfig = readFileSync(path.join(root, 'ui/vite.config.ts'), 'utf8');

    expect(viteConfig).toContain("settings: {");
    expect(viteConfig).toContain("base: '/settings/'");
    expect(viteConfig).toContain("outDir: '../static/settings'");
    expect(viteConfig).toContain("input: 'settings.html'");
  });

  it('declares the isolated same-origin auth callback target', () => {
    const viteConfig = readFileSync(path.join(root, 'ui/vite.config.ts'), 'utf8');

    expect(viteConfig).toContain("authCallback: {");
    expect(viteConfig).toContain("base: '/auth/callback/'");
    expect(viteConfig).toContain("outDir: '../static/auth-callback'");
    expect(viteConfig).toContain("input: 'auth-callback.html'");
  });

  it('keeps the Inrupt verifier on the current Xpod instead of exposing a provider chooser', () => {
    const viteConfig = readFileSync(path.join(root, 'ui/vite.config.ts'), 'utf8');
    const smokeSource = readFileSync(path.join(root, 'ui/src/inrupt-smoke.ts'), 'utf8');
    const appStart = viteConfig.indexOf('app: {');
    const dashboardStart = viteConfig.indexOf('dashboard: {');
    const appTarget = viteConfig.slice(appStart, dashboardStart);

    expect(appTarget).toContain("'inrupt-smoke': 'inrupt-smoke.html'");
    expect(smokeSource).toContain('requireCurrentXpodUrl');
    expect(smokeSource).not.toContain("params.get('issuer') || window.location.origin");
    expect(smokeSource).toContain('Current Xpod OIDC Issuer');
  });

  it('builds app, dashboard, settings, and callback from the aggregate UI command', () => {
    const uiPackage = JSON.parse(readFileSync(path.join(root, 'ui/package.json'), 'utf8'));
    const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

    expect(uiPackage.scripts['build:settings']).toBe('tsc -b && BUILD_TARGET=settings vite build');
    expect(uiPackage.scripts['build:callback']).toBe('tsc -b && BUILD_TARGET=authCallback vite build');
    expect(uiPackage.scripts['build:all']).toBe('bun run build:app && bun run build:dashboard && bun run build:settings && bun run build:callback');
    expect(rootPackage.scripts['build:ui']).toBe('bun run --filter ui build:all');
  });

  it('provides a Settings HTML and React entry', () => {
    const html = readFileSync(path.join(root, 'ui/settings.html'), 'utf8');
    const entry = readFileSync(path.join(root, 'ui/src/settings.tsx'), 'utf8');

    expect(html).toContain('/src/settings.tsx');
    expect(entry).toContain('<XpodShellApp />');
  });

  it('serves canonical product documents during Vite dev while leaving APIs proxied', async () => {
    const { developmentDocumentPath } = await import('../../ui/vite.config');
    for (const route of ['/ai-connections', '/ai-config/model-assignments']) {
      expect(developmentDocumentPath(`${route}?login=return`, 'GET', 'text/html')).toBe('/settings.html?login=return');
      expect(developmentDocumentPath(route, 'GET', 'application/json')).toBeUndefined();
    }
    expect(developmentDocumentPath('/network', 'GET', 'text/html')).toBe('/dashboard.html');
    expect(developmentDocumentPath('/status/overview', 'GET', 'text/html')).toBe('/dashboard.html');
    expect(developmentDocumentPath('/auth/callback?state=test', 'GET', 'text/html')).toBe('/auth-callback.html?state=test');
  });

  it('provides a callback HTML and React entry', () => {
    const html = readFileSync(path.join(root, 'ui/auth-callback.html'), 'utf8');
    const entry = readFileSync(path.join(root, 'ui/src/auth-callback.tsx'), 'utf8');

    expect(html).toContain('/src/auth-callback.tsx');
    expect(entry).toContain('<XpodOidcCallbackApp');
    expect(entry).toContain('resolveCallbackProductDestination');
    expect(entry).toContain('<XpodShellApp');
    expect(entry).not.toContain("destination.app === 'dashboard'");
    expect(entry).toContain('initialPathname={destination.pathname}');
    expect(entry).toContain("window.history.replaceState({}, '', destination.target)");
  });
});
