import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('ngrok Pod read/write smoke script', () => {
  it('has a package script for real public Pod read/write acceptance', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:tunnel:ngrok:pod']).toBe('bun scripts/ngrok-pod-readwrite-smoke.ts');
  });

  it('prints a dry-run plan without starting xpod or ngrok', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/ngrok-pod-readwrite-smoke.ts',
      '--dry-run',
      '--ngrok-url', 'https://ravioli-basics-throbbing.ngrok-free.dev',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      kind: string;
      dryRun: boolean;
      endpoint: string;
      steps: string[];
      caveats: string[];
    };

    expect(result.kind).toBe('ngrok-pod-readwrite-smoke');
    expect(result.dryRun).toBe(true);
    expect(result.endpoint).toBe('https://ravioli-basics-throbbing.ngrok-free.dev/');
    expect(result.steps.join('\n')).toContain('PUT/GET/DELETE');
    expect(result.caveats.join('\n')).toContain('authenticated Pod PUT/GET/DELETE');
  });
});
