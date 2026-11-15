import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { xpodBuildObservationPlugin } from '../../ui/vite.config';

test('actual tiny Vite build records emitted and public members, excluding unrelated additions', async () => {
  const parent = path.resolve('.test-data/ui-build-observation');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  const previous = process.env.XPOD_UI_BUILD_EVIDENCE_DIR;
  try {
    mkdirSync(path.join(root, 'public/nested'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    writeFileSync(path.join(root, 'main.js'), 'document.body.textContent="tiny build";');
    writeFileSync(path.join(root, 'public/nested/public.txt'), 'public');
    process.env.XPOD_UI_BUILD_EVIDENCE_DIR = path.join(root, 'evidence');
    await build({ configFile: false, root, logLevel: 'silent', plugins: [xpodBuildObservationPlugin('app')], build: { outDir: 'output' } });
    writeFileSync(path.join(root, 'output/unknown.txt'), 'not a producer output');
    const observed = JSON.parse(readFileSync(path.join(root, 'evidence/app.json'), 'utf8'));
    expect(observed.target).toBe('app'); expect(observed.outDir).toBe('../static/app');
    expect(observed.files.includes('index.html')).toBe(true);
    expect(observed.files.includes('nested/public.txt')).toBe(true);
    expect(observed.files.some((file: string) => /^assets\/index-.*\.js$/.test(file))).toBe(true);
    expect(observed.files.includes('unknown.txt')).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.XPOD_UI_BUILD_EVIDENCE_DIR;
    else process.env.XPOD_UI_BUILD_EVIDENCE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
