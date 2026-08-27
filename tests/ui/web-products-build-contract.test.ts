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

  it('builds app, dashboard, and settings from the aggregate UI command', () => {
    const uiPackage = JSON.parse(readFileSync(path.join(root, 'ui/package.json'), 'utf8'));
    const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

    expect(uiPackage.scripts['build:settings']).toBe('tsc -b && BUILD_TARGET=settings vite build');
    expect(uiPackage.scripts['build:all']).toBe('bun run build:app && bun run build:dashboard && bun run build:settings');
    expect(rootPackage.scripts['build:ui']).toContain('bun run build:all');
  });

  it('provides a Settings HTML and React entry', () => {
    const html = readFileSync(path.join(root, 'ui/settings.html'), 'utf8');
    const entry = readFileSync(path.join(root, 'ui/src/settings.tsx'), 'utf8');

    expect(html).toContain('/src/settings.tsx');
    expect(entry).toContain('<SettingsApp />');
  });

  it('keeps ChatKit conversation history hidden until the product exposes it', () => {
    const chatPage = readFileSync(path.join(root, 'ui/src/pages/ChatPage.tsx'), 'utf8');
    const appHtml = readFileSync(path.join(root, 'static/app/index.html'), 'utf8');
    const appBundle = readFileSync(path.join(root, 'static/app/assets/main.js'), 'utf8');

    expect(chatPage).toMatch(/history:\s*\{\s*enabled:\s*false,?\s*\}/u);
    expect(chatPage).not.toMatch(/history:\s*\{\s*enabled:\s*true,?\s*\}/u);
    expect(chatPage).toContain("const API_URL = import.meta.env.VITE_CHATKIT_API_URL || '/v1/chatkit';");
    expect(appHtml).toContain('https://cdn.platform.openai.com/deployments/chatkit/chatkit.js');
    expect(appBundle).toContain('history:{enabled:!1}');
    expect(appBundle).toContain('="/v1/chatkit"');
  });
});
