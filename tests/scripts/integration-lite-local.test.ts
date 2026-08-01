import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

describe('lite integration local runtime isolation', () => {
  it('regenerates Components.js metadata before starting the runtime', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-lite-local.ts'), 'utf8');

    const buildIndex = script.indexOf("runCommand('bun', [ 'run', 'build:components' ]");
    const startIndex = script.indexOf("stack.start('local'");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(startIndex);
  });

  it('does not auto-register a standalone lite stack against the official Cloud', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-lite-local.ts'), 'utf8');

    expect(script).toContain("XPOD_LOCAL_AUTO_PROVISION: 'false'");
    expect(script).toContain('stack.start(');
    expect(script).not.toMatch(/await\s+stack\.start\(\s*\)/);
  });

  it('disables auto-provision only for standalone full-runtime local nodes', async () => {
    const script = await readFile(path.join(root, 'scripts/run-integration-full.ts'), 'utf8');

    const localManagedBlock = script.slice(
      script.indexOf("runtimeRoot: path.join(runtimeRoot, 'local')"),
      script.indexOf("runtimeRoot: path.join(runtimeRoot, 'standalone')"),
    );
    const standaloneBlock = script.slice(script.indexOf("runtimeRoot: path.join(runtimeRoot, 'standalone')"));

    expect(localManagedBlock).toContain('XPOD_CLOUD_API_ENDPOINT');
    expect(localManagedBlock).not.toContain('XPOD_LOCAL_AUTO_PROVISION');
    expect(standaloneBlock).toContain("XPOD_LOCAL_AUTO_PROVISION: 'false'");
  });

});
