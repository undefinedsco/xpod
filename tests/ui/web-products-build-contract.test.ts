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

  it('builds app, dashboard, settings, and callback from the aggregate UI command', () => {
    const uiPackage = JSON.parse(readFileSync(path.join(root, 'ui/package.json'), 'utf8'));
    const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

    expect(uiPackage.scripts['build:settings']).toBe('tsc -b && BUILD_TARGET=settings vite build');
    expect(uiPackage.scripts['build:callback']).toBe('tsc -b && BUILD_TARGET=authCallback vite build');
    expect(uiPackage.scripts['build:all']).toBe('bun run build:app && bun run build:dashboard && bun run build:settings && bun run build:callback');
    expect(rootPackage.scripts['build:ui']).toContain('bun run build:all');
  });

  it('provides a Settings HTML and React entry', () => {
    const html = readFileSync(path.join(root, 'ui/settings.html'), 'utf8');
    const entry = readFileSync(path.join(root, 'ui/src/settings.tsx'), 'utf8');

    expect(html).toContain('/src/settings.tsx');
    expect(entry).toContain('<SettingsApp />');
  });

  it('provides a callback HTML and React entry', () => {
    const html = readFileSync(path.join(root, 'ui/auth-callback.html'), 'utf8');
    const entry = readFileSync(path.join(root, 'ui/src/auth-callback.tsx'), 'utf8');

    expect(html).toContain('/src/auth-callback.tsx');
    expect(entry).toContain('<XpodOidcCallbackApp');
  });
});
