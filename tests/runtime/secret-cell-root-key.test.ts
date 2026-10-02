import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePersistentGatewayLocatorSecret, secretPathForGatewayLocatorDatabase } from '../../src/runtime/gateway-locator-secret';
import { resolvePersistentSecretCellRootKey, secretPathForSecretCellDatabase } from '../../src/runtime/secret-cell-root-key';
import { SecretCellVault } from '../../src/security/secret-cell';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = path.resolve('.test-data', 'secret-cell-root-key', randomUUID());
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  const databaseUrl = `sqlite:${path.join(root, 'identity.sqlite')}`;
  const file = secretPathForSecretCellDatabase(databaseUrl)!;
  return { root, file, databaseUrl, options: { databaseUrl, edition: 'local' as const } };
}
const context = { ownerWebId: 'https://pod.example/#me', resourceIri: 'https://pod.example/task/one', predicate: 'https://undefineds.co/ns#secret', field: 'clientSecret', schemaVersion: 'v1' };

describe('Persistent local SecretCell root key', () => {
  it('decrypts after restart and keeps its key independent of locator rotation', async () => {
    const { options, databaseUrl, file, root } = fixture();
    const firstRootKeys = resolvePersistentSecretCellRootKey(options);
    const first = new SecretCellVault({ rootKeys: firstRootKeys });
    const plaintext = new TextEncoder().encode('test-task-grant');
    const envelope = await first.seal(plaintext, context);
    expect(envelope.wrappedDek.keyId).toBe('local-v1');
    const locator = resolvePersistentGatewayLocatorSecret(options);
    expect(Buffer.from(firstRootKeys.getActiveKey().key).equals(Buffer.from(locator, 'base64url'))).toBe(false);
    const locatorPath = secretPathForGatewayLocatorDatabase(databaseUrl)!;
    expect(file).toBe(path.join(root, '.xpod', 'secrets', 'secret-cell-root-key'));
    expect(file).not.toBe(locatorPath);
    fs.unlinkSync(locatorPath);
    resolvePersistentGatewayLocatorSecret(options);
    const restarted = new SecretCellVault({ rootKeys: resolvePersistentSecretCellRootKey(options) });
    await expect(restarted.open(envelope, context)).resolves.toEqual(plaintext);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.dirname(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  });

  it('gives simultaneous first-start processes the same complete key', async () => {
    const { databaseUrl, file } = fixture();
    const digests = await Promise.all([childDigest(databaseUrl), childDigest(databaseUrl)]);
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['secret-cell-root-key']);
  });

  it.each(['bad', 'a'.repeat(32), '_'.repeat(43)])('rejects malformed key material without replacing it (%s)', value => {
    const { options, file } = fixture();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, value, { mode: 0o600 });
    expect(() => resolvePersistentSecretCellRootKey(options)).toThrow(/invalid; refusing to replace/u);
    expect(fs.readFileSync(file, 'utf8')).toBe(value);
  });

  it.skipIf(process.platform === 'win32')('rejects a linked secret or directory without creating files through the link', () => {
    const { options, root, file } = fixture();
    const external = path.join(root, 'elsewhere');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(root, '.xpod'), 'dir');
    expect(() => resolvePersistentSecretCellRootKey(options)).toThrow(/symlink/u);
    expect(fs.readdirSync(external)).toEqual([]);
    fs.unlinkSync(path.join(root, '.xpod'));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(external, 'missing'), file);
    expect(() => resolvePersistentSecretCellRootKey(options)).toThrow(/symlink/u);
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects unsafe file and directory permissions', () => {
    const { options, file } = fixture();
    resolvePersistentSecretCellRootKey(options);
    fs.chmodSync(file, 0o644);
    expect(() => resolvePersistentSecretCellRootKey(options)).toThrow(/mode 0600/u);
    fs.chmodSync(file, 0o600);
    fs.chmodSync(path.dirname(file), 0o755);
    expect(() => resolvePersistentSecretCellRootKey(options)).toThrow(/mode 0700/u);
  });

  it('requires explicit keys in Cloud and for non-persistent SQLite', () => {
    const { options, root } = fixture();
    expect(() => resolvePersistentSecretCellRootKey({ ...options, edition: 'cloud' })).toThrow(/stable shared root keys/u);
    for (const databaseUrl of ['', ':memory:', 'sqlite::memory:', 'postgres://db.example/xpod']) {
      expect(() => resolvePersistentSecretCellRootKey({ databaseUrl, edition: 'local' })).toThrow(/not file-backed SQLite/u);
      expect(secretPathForSecretCellDatabase(databaseUrl)).toBeUndefined();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

function childDigest(databaseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let digest = '';
    const child = spawn('bun', ['--no-env-file', '-e', `
      import { createHash } from 'node:crypto';
      import { resolvePersistentSecretCellRootKey } from './src/runtime/secret-cell-root-key.ts';
      const provider = resolvePersistentSecretCellRootKey({ databaseUrl: process.env.XPOD_TEST_DATABASE_URL, edition: 'local' });
      process.stdout.write(createHash('sha256').update(provider.getActiveKey().key).digest('hex'));
    `], { cwd: process.cwd(), env: { ...process.env, XPOD_TEST_DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => { digest += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(digest) : reject(new Error(`SecretCell child exited with ${code}`)));
  });
}
