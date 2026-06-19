import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('local phone smoke script', () => {
  it('prints a browser verifier URL and direct resource URL for phone validation', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/local-phone-smoke.cjs',
      '--print',
      '--ip', '192.0.2.10',
      '--port', '3456',
      '--path', '/alice/a.txt',
      '--node-id', 'node-0000',
    ], { cwd: root });

    expect(stdout).toContain('Phone URL:    http://192.0.2.10:3456/');
    expect(stdout).toContain('Verifier URL: http://192.0.2.10:3456/app/reachability.html?path=%2Falice%2Fa.txt');
    expect(stdout).toContain('Signal URL:   http://192.0.2.10:3456/app/signal-pod.html?path=%2Falice%2Fa.txt&nodeId=node-0000');
    expect(stdout).toContain('Inrupt URL:   http://192.0.2.10:3456/app/inrupt-smoke.html?issuer=http%3A%2F%2F192.0.2.10%3A3456%2F&sp=http%3A%2F%2F192.0.2.10%3A3456%2Falice%2Fa.txt');
    expect(stdout).toContain('Resource URL: http://192.0.2.10:3456/alice/a.txt');
  });

  it('defaults phone reachability checks to a public CSS discovery endpoint', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/local-phone-smoke.cjs',
      '--print',
      '--ip', '192.0.2.10',
      '--port', '3456',
    ], { cwd: root });

    expect(stdout).toContain('Verifier URL: http://192.0.2.10:3456/app/reachability.html?path=%2F.well-known%2Fopenid-configuration');
    expect(stdout).toContain('Resource URL: http://192.0.2.10:3456/.well-known/openid-configuration');
  });

  it('prints public registration URLs and uses the public base URL for CSS when provided', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/local-phone-smoke.cjs',
      '--print',
      '--ip', '192.0.2.10',
      '--port', '3456',
      '--public-base-url', 'https://node-0000.undefineds.co/',
    ], { cwd: root });

    expect(stdout).toContain('Public URL:   https://node-0000.undefineds.co/');
    expect(stdout).toContain('Register URL: https://node-0000.undefineds.co/.account/login/password/register/');
    expect(stdout).toContain('Login URL:    https://node-0000.undefineds.co/.account/login/password/');
    expect(stdout).toContain('Account URL:  https://node-0000.undefineds.co/.account/');
    expect(stdout).toContain('Inrupt URL:   https://node-0000.undefineds.co/app/inrupt-smoke.html?issuer=https%3A%2F%2Fnode-0000.undefineds.co%2F&sp=https%3A%2F%2Fnode-0000.undefineds.co%2F.well-known%2Fopenid-configuration');
    expect(stdout).toContain('Command: CSS_BASE_URL=https://node-0000.undefineds.co/ bun');
  });

  it('separates Cloud IdP registration from public SP resource origin', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/local-phone-smoke.cjs',
      '--print',
      '--ip', '192.0.2.10',
      '--port', '3456',
      '--sp-base-url', 'https://node-0000.undefineds.co/',
      '--idp-base-url', 'https://id.undefineds.co/',
    ], { cwd: root });

    expect(stdout).toContain('Public SP URL: https://node-0000.undefineds.co/');
    expect(stdout).toContain('Cloud IdP URL: https://id.undefineds.co/');
    expect(stdout).toContain('Register URL:  https://id.undefineds.co/.account/login/password/register/');
    expect(stdout).toContain('Login URL:     https://id.undefineds.co/.account/login/password/');
    expect(stdout).toContain('Account URL:   https://id.undefineds.co/.account/');
    expect(stdout).toContain('Inrupt URL:   https://node-0000.undefineds.co/app/inrupt-smoke.html?issuer=https%3A%2F%2Fid.undefineds.co%2F&sp=https%3A%2F%2Fnode-0000.undefineds.co%2F.well-known%2Fopenid-configuration');
    expect(stdout).toContain('Resource URL: https://node-0000.undefineds.co/.well-known/openid-configuration');
    expect(stdout).toContain('Command: CSS_BASE_URL=https://node-0000.undefineds.co/ oidcIssuer=https://id.undefineds.co/ bun');
  });

});
