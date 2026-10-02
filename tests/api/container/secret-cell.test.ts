import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiContainer, loadConfigFromEnv, loadDeploymentRootKeyProvider, type ApiContainerConfig } from '../../../src/api/container';
import { secretPathForSecretCellDatabase } from '../../../src/runtime/secret-cell-root-key';
import { SecretCellCredentialVault } from '../../../src/api/ai-gateway/credentials/SecretCellCredentialVault';
import { SecretCellVault } from '../../../src/security/secret-cell';

// Exercise the actual container wiring without loading SQLite's Node ABI here.
vi.mock('../../../src/api/tasks/TaskCredentialDatabase', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/api/tasks/TaskCredentialDatabase')>(),
  getTaskCredentialDatabase: vi.fn(() => ({ db: {}, schema: {} })),
}));
vi.mock('../../../src/api/tasks/TaskCredentialStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/api/tasks/TaskCredentialStore')>(),
  TaskCredentialStore: class {
    public readonly vault: SecretCellVault;
    public constructor(options: { vault: SecretCellVault }) { this.vault = options.vault; }
  },
}));

const originalEnv = { ...process.env };
const roots: string[] = [];
afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): { root: string; config: ApiContainerConfig } {
  const root = path.resolve('.test-data', 'container-secret-cell', randomUUID());
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  return { root, config: {
    edition: 'local', port: 3001, host: '127.0.0.1', authMode: 'acp',
    databaseUrl: `sqlite:${path.join(root, 'identity.sqlite')}`,
    cssTokenEndpoint: 'https://pod.example/.oidc/token', corsOrigins: ['*'],
  } };
}
const principal = { webId: 'https://pod.example/#me' };
const credentialIri = 'https://pod.example/settings/credentials.ttl#test';

describe('SecretCell container initialization', () => {
  it('waits for the runtime database path, shares one vault, and decrypts after restart', async () => {
    const { root, config } = fixture();
    process.env = { XPOD_EDITION: 'local', CSS_ROOT_FILE_PATH: root };
    const early = loadConfigFromEnv();
    expect(early.databaseUrl).toBe('');
    expect(early.secretCellVaultFactory).toBeUndefined();
    expect(fs.existsSync(path.join(root, '.xpod'))).toBe(false);
    const finalized = { ...early, databaseUrl: config.databaseUrl };
    const container = createApiContainer(finalized);
    const resolved = container.resolve('config');
    expect(fs.existsSync(secretPathForSecretCellDatabase(config.databaseUrl)!)).toBe(false);
    const credentialVault = resolved.secretCellCredentialVaultFactory!();
    expect(resolved.secretCellCredentialVaultFactory!()).toBe(credentialVault);
    const vault = resolved.secretCellVaultFactory!();
    expect(resolved.secretCellVaultFactory!()).toBe(vault);
    const tasks = container.resolve('taskCredentialStore') as unknown as { vault: SecretCellVault };
    expect(tasks.vault).toBe(vault);
    const sealed = await credentialVault.seal(principal, credentialIri, 'openai', { apiKey: 'test-key' });
    expect(sealed.keyId).toBe('local-v1');
    // The two adapters must share the same root, not merely compatible factory signatures.
    await expect(new SecretCellCredentialVault({ vault }).open(principal, credentialIri, 'openai', sealed))
      .resolves.toEqual({ apiKey: 'test-key' });
    const restarted = createApiContainer(finalized).resolve('config').secretCellCredentialVaultFactory!();
    await expect(restarted.open(principal, credentialIri, 'openai', sealed)).resolves.toEqual({ apiKey: 'test-key' });
  });

  it.each(['local', 'cloud'])('uses validated ENV keys ahead of a local file in %s and shares the explicit provider', async edition => {
    const { root, config } = fixture();
    process.env = { XPOD_EDITION: edition, CSS_ROOT_FILE_PATH: root, CSS_IDENTITY_DB_URL: config.databaseUrl,
      XPOD_SECRET_CELL_KEY_ID: 'configured-v2', XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 7).toString('base64'),
      XPOD_SECRET_CELL_PREVIOUS_KEYS: JSON.stringify({ 'configured-v1': Buffer.alloc(32, 6).toString('base64') }),
    };
    const resolved = createApiContainer(loadConfigFromEnv()).resolve('config');
    const sealed = await resolved.secretCellCredentialVaultFactory!().seal(principal, credentialIri, 'openai', { apiKey: 'test-key' });
    expect(sealed.keyId).toBe('configured-v2');
    expect(resolved.secretCellVaultFactory!()).toBe(resolved.secretCellVaultFactory!());
    expect(fs.existsSync(path.join(root, '.xpod'))).toBe(false);
    expect(loadDeploymentRootKeyProvider(process.env)!.getKey('configured-v1')).toBeDefined();
  });

  it.each([
    { XPOD_SECRET_CELL_KEY_ID: 'missing-value' },
    { XPOD_SECRET_CELL_KEY: Buffer.alloc(32).toString('base64') },
    { XPOD_SECRET_CELL_KEY_ID: 'valid', XPOD_SECRET_CELL_KEY: 'bad' },
    { XPOD_SECRET_CELL_KEY_ID: 'valid', XPOD_SECRET_CELL_KEY: Buffer.alloc(32).toString('base64'), XPOD_SECRET_CELL_PREVIOUS_KEYS: '{bad' },
  ])('rejects incomplete or malformed explicit ENV without local fallback', env => {
    const { root, config } = fixture();
    process.env = { XPOD_EDITION: 'local', CSS_ROOT_FILE_PATH: root, CSS_IDENTITY_DB_URL: config.databaseUrl, ...env };
    expect(() => loadConfigFromEnv()).toThrow(/SecretCell|XPOD_SECRET_CELL/u);
    expect(fs.existsSync(path.join(root, '.xpod'))).toBe(false);
  });

  it('does not invent root keys for Cloud or non-persistent local databases', () => {
    const { root, config } = fixture();
    for (const override of [{ edition: 'cloud' as const }, { databaseUrl: 'sqlite::memory:' }, { databaseUrl: 'postgres://db.example/xpod' }]) {
      const container = createApiContainer({ ...config, ...override });
      expect(container.resolve('config').secretCellVaultFactory).toBeUndefined();
      expect(container.resolve('taskCredentialStore')).toBeUndefined();
    }
    expect(fs.existsSync(path.join(root, '.xpod'))).toBe(false);
  });
});
