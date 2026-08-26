import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

describe('Xpod web product build contract', () => {
  it('declares Settings as an independent Vite target', () => {
    const viteConfig = readFileSync(path.join(root, 'ui/vite.config.ts'), 'utf8');
    const solidRuntime = readFileSync(path.join(root, 'ui/src/solid/XpodSolidRuntime.ts'), 'utf8');
    const uiPackage = JSON.parse(readFileSync(path.join(root, 'ui/package.json'), 'utf8'));

    expect(viteConfig).toContain("settings: {");
    expect(viteConfig).toContain("base: '/settings/'");
    expect(viteConfig).toContain("outDir: '../static/settings'");
    expect(viteConfig).toContain("input: 'settings.html'");
    expect(viteConfig).toContain("external: ['node:module']");
    expect(uiPackage.dependencies['@comunica/query-sparql-solid']).toBeTruthy();
    expect(viteConfig).toContain('productDevServerPlugin(buildTarget)');
    expect(viteConfig).toContain('XPOD_DEV_GATEWAY_URL');
    expect(viteConfig).toContain("'/.account'");
    expect(viteConfig).toContain("'/api'");
    expect(viteConfig).toContain("'/v1'");
    expect(solidRuntime).toContain("import { solidSchema } from '@undefineds.co/models'");
    expect(solidRuntime).toContain('schema: solidSchema');
    expect(solidRuntime).toContain('sparql: { createQueryEngine: createSparqlEndpointQueryEngine }');
  });

  it('builds app, dashboard, and settings from the aggregate UI command', () => {
    const uiPackage = JSON.parse(readFileSync(path.join(root, 'ui/package.json'), 'utf8'));
    const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

    expect(uiPackage.scripts['build:settings']).toBe('tsc -b && BUILD_TARGET=settings vite build');
    expect(uiPackage.scripts['build:all']).toBe('bun run build:app && bun run build:dashboard && bun run build:settings');
    expect(rootPackage.scripts['build:ui']).toContain('bun run --cwd ui build:all');
  });

  it('provides a Settings HTML and React entry', () => {
    const html = readFileSync(path.join(root, 'ui/settings.html'), 'utf8');
    const entry = readFileSync(path.join(root, 'ui/src/settings.tsx'), 'utf8');

    expect(html).toContain('/src/settings.tsx');
    expect(entry).toContain('<SettingsApp />');
  });

  it('allows the standalone dev server to target the real Xpod issuer', () => {
    const authBoundary = readFileSync(path.join(root, 'ui/src/solid/SettingsAuthBoundary.tsx'), 'utf8');

    expect(authBoundary).toContain('import.meta.env.VITE_XPOD_OIDC_ISSUER');
    expect(authBoundary).toContain('configuredIssuer || window.location.origin');
  });
});
