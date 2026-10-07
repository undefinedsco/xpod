import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { stageRuntimePackageClosure } = require('../../scripts/lib/runtime-package-closure.cjs');
const repoRoot = process.cwd();

describe('lazy agent runtime package payload', () => {
  it('loads the actual ESM SDK and its dependency closure from a compiled Bun binary using staged module files', async () => {
    const root = fs.mkdtempSync(path.join(repoRoot, '.test-data/lazy-agent-runtime-'));
    try {
      const payload = path.join(root, 'payload');
      const packages = await stageRuntimePackageClosure('@mariozechner/pi-coding-agent', repoRoot, payload);
      expect(packages.some((entry: { name: string }) => entry.name === '@mariozechner/pi-agent-core')).toBe(true);
      expect(packages.some((entry: { name: string }) => entry.name === 'typescript')).toBe(false);
      const sdkDir = path.join(payload, 'node_modules/@mariozechner/pi-coding-agent');
      const metadata = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8'));
      expect(fs.existsSync(path.join(sdkDir, 'docs/sdk.md'))).toBe(true);
      expect(fs.existsSync(path.join(sdkDir, 'dist/modes/interactive/theme/dark.json'))).toBe(true);
      const entry = path.join(root, 'probe.ts');
      fs.writeFileSync(entry, `
        import { pathToFileURL } from 'node:url';
        const load = new Function('specifier', 'return import(specifier)');
        const sdk = await load(pathToFileURL(process.argv[2]).href);
        if (typeof sdk.createAgentSession !== 'function' || typeof sdk.createCodingTools !== 'function') throw new Error('SDK exports unavailable');
        console.log('agent-sdk-loaded');
      `);
      const executable = path.join(root, 'probe');
      execFileSync('bun', ['build', '--compile', entry, '--outfile', executable], { stdio: 'pipe', timeout: 60_000 });
      expect(execFileSync(executable, [path.join(sdkDir, metadata.main)], {
        cwd: payload, encoding: 'utf8', timeout: 60_000,
      }).trim()).toBe('agent-sdk-loaded');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
