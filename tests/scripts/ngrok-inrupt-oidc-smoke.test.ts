import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('ngrok Inrupt OIDC smoke script', () => {
  it('has a package script for formal Inrupt redirect/PKCE acceptance', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:tunnel:ngrok:inrupt']).toBe('bun scripts/ngrok-inrupt-oidc-smoke.ts');
  });

  it('prints a dry-run plan for browser OIDC redirect/PKCE without starting services', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/ngrok-inrupt-oidc-smoke.ts',
      '--dry-run',
      '--ngrok-url', 'https://ravioli-basics-throbbing.ngrok-free.dev',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      kind: string;
      dryRun: boolean;
      endpoint: string;
      browser: string;
      steps: string[];
      proves: string[];
      caveats: string[];
    };

    expect(result.kind).toBe('ngrok-inrupt-oidc-smoke');
    expect(result.dryRun).toBe(true);
    expect(result.endpoint).toBe('https://ravioli-basics-throbbing.ngrok-free.dev/');
    expect(result.browser).toBe('chromium');
    expect(result.steps.join('\n')).toContain('click the Inrupt login button');
    expect(result.steps.join('\n')).toContain('submit the CSS password login form');
    expect(result.proves.join('\n')).toContain('authorization-code redirect flow with PKCE');
    expect(result.proves.join('\n')).toContain('session.fetch');
    expect(result.caveats.join('\n')).toContain('ngrok-skip-browser-warning');
    expect(result.caveats.join('\n')).toContain('does not use the client credentials shortcut');
  });

  it('can dry-run the same formal Inrupt flow against a local loopback origin without ngrok', async () => {
    const { stdout } = await execFileAsync('bun', [
      'scripts/ngrok-inrupt-oidc-smoke.ts',
      '--dry-run',
      '--local-only',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      kind: string;
      dryRun: boolean;
      endpoint: string;
      steps: string[];
      caveats: string[];
    };

    expect(result.kind).toBe('ngrok-inrupt-oidc-smoke');
    expect(result.dryRun).toBe(true);
    expect(result.endpoint).toBe('auto-local-loopback-origin');
    expect(result.steps.join('\n')).toContain('start local xpod runtime');
    expect(result.steps.join('\n')).not.toContain('start ngrok tunnel');
    expect(result.caveats.join('\n')).toContain('loopback');
  });


  it('submits the password login form without clicking the forgot-password button', async () => {
    const source = await readFile(path.join(root, 'scripts/ngrok-inrupt-oidc-smoke.ts'), 'utf8');

    expect(source).toContain("passwordInput.press('Enter')");
    expect(source).not.toContain('button[type=\"submit\"], input[type=\"submit\"], button');
  });


  it('uses localhost rather than 127.0.0.1 for local DPoP WebID acceptance', async () => {
    const source = await readFile(path.join(root, 'scripts/ngrok-inrupt-oidc-smoke.ts'), 'utf8');

    expect(source).toContain("bindHost: 'localhost'");
  });


  it('probes the runtime base URL in local-only mode', async () => {
    const source = await readFile(path.join(root, 'scripts/ngrok-inrupt-oidc-smoke.ts'), 'utf8');

    expect(source).toContain("const localGateway = options.localOnly ? endpoint : `http://127.0.0.1:${localPort}/`;");
  });

});
