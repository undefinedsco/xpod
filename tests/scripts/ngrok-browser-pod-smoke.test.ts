import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('ngrok browser Pod smoke script', () => {
  it('has a package script for browser-based public Pod read/write acceptance', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:tunnel:ngrok:browser']).toBe('bun scripts/ngrok-browser-pod-smoke.ts');
  });

  it('prints a dry-run plan without starting xpod, ngrok, or chromium', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/ngrok-browser-pod-smoke.ts',
      '--dry-run',
      '--ngrok-url', 'https://ravioli-basics-throbbing.ngrok-free.dev',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      kind: string;
      dryRun: boolean;
      endpoint: string;
      browser: string;
      steps: string[];
      caveats: string[];
    };

    expect(result.kind).toBe('ngrok-browser-pod-smoke');
    expect(result.dryRun).toBe(true);
    expect(result.endpoint).toBe('https://ravioli-basics-throbbing.ngrok-free.dev/');
    expect(result.browser).toBe('chromium');
    expect(result.steps.join('\n')).toContain('from browser JavaScript PUT/GET/DELETE');
    expect(result.caveats.join('\n')).toContain('real Chromium browser context');
    expect(result.caveats.join('\n')).toContain('ngrok-skip-browser-warning');
  });
});
