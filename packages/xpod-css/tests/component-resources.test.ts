import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { materializeCssResources } from '../scripts/component-resources';
import { buildScopedCssComponents } from '../scripts/scoped-components';
const root = path.resolve(import.meta.dir, '../../..');
describe('CSS Components/resource adapter', () => {
  it('binds actual profile components to canonical source instead of the service index', async () => {
    const base = path.join(root, '.test-data/css-module-resources'); mkdirSync(base, { recursive: true });
    const scratch = mkdtempSync(path.join(base, 'owned-'));
    try {
      // Match the normal producer: root dist may be missing or stale.
      const { plan, metadataRoot } = await buildScopedCssComponents(root, path.join(scratch, 'metadata'));
      const product = path.join(scratch, 'product');
      expect(plan.componentExports.some(row => row.name === 'MixDataAccessor')).toBe(true);
      expect(plan.componentExports.some(row => row.name === 'ConfigurableLoggerFactory')).toBe(true);
      // Its shared metadata document also declares the CSS resolver selected at runtime.
      expect(plan.componentExports.some(row => row.name === 'CssPodOwnershipResolver')).toBe(true);
      expect(plan.componentExports.every(row => row.source.startsWith('src/') && row.source !== 'src/index.ts')).toBe(true);
      expect(plan.files.some(row => row.path === 'config/local.json')).toBe(true);
      expect(plan.files.some(row => row.path === 'config/cloud.json')).toBe(true);
      const entries = materializeCssResources(root, product, '@undefineds.co/xpod-css-darwin-arm64', plan, metadataRoot);
      const manifest = JSON.parse(readFileSync(path.join(product, 'dist/components/components.jsonld'), 'utf8'));
      expect(manifest.requireName).toBe('@undefineds.co/xpod-css-darwin-arm64');
      expect(manifest['@id']).toBe('npmd:@undefineds.co/xpod');
      expect(readFileSync(path.join(product, 'source/dist/components/components.jsonld'))).toEqual(readFileSync(path.join(metadataRoot, 'dist/components/components.jsonld')));
      expect(entries.length).toBe(plan.componentExports.length);
      expect(readFileSync(path.join(product, 'dist/css-components.cjs'), 'utf8')).not.toContain("require('./index.js')");
      expect(readFileSync(path.join(product, 'config/local.json'))).toEqual(readFileSync(path.join(root, 'config/local.json')));
    } finally { rmSync(scratch, { recursive: true }); }
  }, 30_000);
});
