import { assertCompleteDigest, collectChildStdout } from '../helpers/collectChildStdout';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePersistentGatewayLocatorSecret,
  secretPathForGatewayLocatorDatabase,
} from '../../src/runtime/gateway-locator-secret';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Gateway locator secret persistence', () => {
  it('reuses one generated secret for the same SQLite identity database path', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;

    const first = resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' });
    const second = resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' });

    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
    expectSecretMode(databaseUrl);
  });

  it('resolves sqlite file URLs through the shared database-url parser', () => {
    const root = testRoot();
    const databasePath = path.join(root, 'identity.sqlite');
    const databaseUrl = `sqlite:${new URL(`file://${databasePath}`).href}`;

    const secret = resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' });

    expect(secret).toEqual(expect.any(String));
    expect(secretPathForGatewayLocatorDatabase(databaseUrl))
      .toBe(path.join(root, '.xpod', 'secrets', 'gateway-locator-secret'));
  });

  it('generates different secrets for independent data roots', () => {
    const firstRoot = testRoot();
    const secondRoot = testRoot();

    const first = resolvePersistentGatewayLocatorSecret({
      databaseUrl: `sqlite:${path.join(firstRoot, 'identity.sqlite')}`,
      edition: 'local',
    });
    const second = resolvePersistentGatewayLocatorSecret({
      databaseUrl: `sqlite:${path.join(secondRoot, 'identity.sqlite')}`,
      edition: 'local',
    });

    expect(first).not.toBe(second);
  });

  it('handles real multi-process first reads without generating competing files', async () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;

    const digests = await Promise.all(Array.from({ length: 12 }, async () => runSecretResolverProcess(databaseUrl)));
    digests.forEach(assertCompleteDigest);
    expect(new Set(digests).size).toBe(1);
    const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    const persistedDigest = createHash('sha256').update(secret).digest('hex');
    const leftoverTemps = fs.readdirSync(path.dirname(secretPath))
      .filter((entry) => entry.startsWith('.gateway-locator-secret.'));

    expect(secret).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    for (const digest of digests) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(digest).toBe(persistedDigest);
    }
    expect(leftoverTemps).toHaveLength(0);
    expectSecretMode(databaseUrl);
  });

  it('collects the complete child digest when stdout finishes after exit', async () => {
    const child = new childProcess.ChildProcess();
    const stdout = new PassThrough();
    child.stdout = stdout;
    vi.spyOn(childProcess, 'spawn').mockReturnValueOnce(child);
    const expectedDigest = 'a'.repeat(64);

    const digest = runSecretResolverProcess('sqlite:unused-lifecycle-fixture.sqlite');
    stdout.write(expectedDigest.slice(0, 32));
    child.emit('exit', 0, null);
    stdout.end(expectedDigest.slice(32));
    child.emit('close', 0, null);

    expect(await digest).toBe(expectedDigest);
  });

  it('fails clearly on an invalid existing secret file without replacing it', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, 'bad\n', { mode: 0o600 });

    expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' }))
      .toThrow(/invalid; refusing to replace it automatically/u);
    expect(fs.readFileSync(secretPath, 'utf8')).toBe('bad\n');
  });

  it('fails clearly on an empty partially published target without replacing it', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, '', { mode: 0o600 });

    expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' }))
      .toThrow(/invalid; refusing to replace it automatically/u);
    expect(fs.readFileSync(secretPath, 'utf8')).toBe('');
  });

  it('fails clearly when the existing secret file is not private', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, 'stable-secret-value-1234567890\n', { mode: 0o644 });
    if (process.platform !== 'win32') {
      fs.chmodSync(secretPath, 0o644);
    }

    if (process.platform === 'win32') {
      expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' })).not.toThrow();
    } else {
      expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' }))
        .toThrow(/must have mode 0600/u);
    }
  });

  it('rejects a symlink secret file before reading through it', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    const publicTarget = path.join(root, 'public-secret-target');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(publicTarget, 'stable-secret-value-1234567890\n', { mode: 0o600 });
    try {
      fs.symlinkSync(publicTarget, secretPath);
    } catch {
      return;
    }

    expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' }))
      .toThrow(/must not be a symlink/u);
  });

  it('rejects a non-regular secret file', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    fs.mkdirSync(secretPath, { recursive: true, mode: 0o700 });

    expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' }))
      .toThrow(/must be a regular file/u);
  });

  it('fails clearly when the secret directory cannot be prepared', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    fs.writeFileSync(path.join(root, '.xpod'), 'not a directory');

    expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' }))
      .toThrow(/Failed to prepare Gateway locator secret directory/u);
  });

  it('requires an explicit secret for non-file-backed databases', () => {
    expect(() => resolvePersistentGatewayLocatorSecret({ databaseUrl: ':memory:', edition: 'local' }))
      .toThrow(/XPOD_GATEWAY_LOCATOR_SECRET is required/u);
    expect(() => resolvePersistentGatewayLocatorSecret({
      databaseUrl: 'postgres://db.example/xpod',
      edition: 'cloud',
    })).toThrow(/stable shared value across replicas/u);
  });

  it('keeps an existing valid locator value at its original path', () => {
    const root = testRoot();
    const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
    const secretPath = path.join(root, '.xpod', 'secrets', 'gateway-locator-secret');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    const existing = 'existing-locator-value-12345678901234567890';
    fs.writeFileSync(secretPath, `${existing}\n`, { mode: 0o600 });
    expect(secretPathForGatewayLocatorDatabase(databaseUrl)).toBe(secretPath);
    expect(resolvePersistentGatewayLocatorSecret({ databaseUrl, edition: 'local' })).toBe(existing);
  });
});

function testRoot(): string {
  const root = path.resolve('.test-data', 'gateway-locator-secret', randomUUID());
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function expectSecretMode(databaseUrl: string): void {
  if (process.platform === 'win32') {
    return;
  }
  const secretPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
  expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
}

async function runSecretResolverProcess(databaseUrl: string): Promise<string> {
  const script = `
    import { createHash } from 'node:crypto';
    import { resolvePersistentGatewayLocatorSecret } from './src/runtime/gateway-locator-secret.ts';
    const secret = resolvePersistentGatewayLocatorSecret({ databaseUrl: process.env.XPOD_TEST_DATABASE_URL, edition: 'local' });
    process.stdout.write(createHash('sha256').update(secret).digest('hex'));
  `;
  const child = childProcess.spawn('bun', ['--no-env-file', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XPOD_TEST_DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return collectChildStdout(child);
}
