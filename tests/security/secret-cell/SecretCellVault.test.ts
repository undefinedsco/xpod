import { describe, expect, it } from 'vitest';
import {
  DeploymentRootKeyProvider,
  SecretCellError,
  SecretCellVault,
  parseDeploymentRootKeyConfig,
  type SecretCellContext,
  type SecretCellEnvelope,
} from '../../../src/security/secret-cell';
import { SecretCellKeyWrapper } from '../../../src/api/ai-gateway/credentials/SecretCellKeyWrapper';
import type { KeyWrapContext } from '../../../src/api/ai-gateway/credentials/KeyWrapper';

const rootV1 = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const rootV2 = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';

const context: SecretCellContext = {
  ownerWebId: 'https://alice.example/profile#me',
  resourceIri: 'https://alice.example/settings/providers/openai.ttl',
  predicate: 'https://xpod.dev/ns#credentialSecret',
  field: 'providerCredentialSecret',
  schemaVersion: 'v1',
  provider: 'openai',
};

describe('SecretCellVault', () => {
  it('roundtrips bytes while binding the envelope to the full context', async () => {
    const vault = createVault({ activeKeyId: 'root-v1', keys: { 'root-v1': rootV1 } });
    const plaintext = new TextEncoder().encode('sk-secret-value');

    const sealed = await vault.seal(plaintext, context);

    expect(sealed.algorithm).toBe('AES-256-GCM');
    expect(sealed.aadPurpose).toBe('xpod.secret-cell.payload');
    expect(sealed.aadVersion).toBe('v1');
    expect(sealed.context).toEqual(context);
    expect(JSON.stringify(sealed)).not.toContain('sk-secret-value');
    await expect(vault.open(sealed, context)).resolves.toEqual(plaintext);
  });

  it('rejects owner, resource, predicate, field, schema, and provider mismatches', async () => {
    const vault = createVault({ activeKeyId: 'root-v1', keys: { 'root-v1': rootV1 } });
    const sealed = await vault.seal(new TextEncoder().encode('bound-secret'), context);

    await expect(vault.open(sealed, { ...context, ownerWebId: 'https://bob.example/#me' }))
      .rejects.toThrow(SecretCellError);
    await expect(vault.open(sealed, { ...context, resourceIri: `${context.resourceIri}#other` }))
      .rejects.toThrow(SecretCellError);
    await expect(vault.open(sealed, { ...context, predicate: 'https://xpod.dev/ns#other' }))
      .rejects.toThrow(SecretCellError);
    await expect(vault.open(sealed, { ...context, field: 'otherField' }))
      .rejects.toThrow(SecretCellError);
    await expect(vault.open(sealed, { ...context, schemaVersion: 'v2' }))
      .rejects.toThrow(SecretCellError);
    await expect(vault.open(sealed, { ...context, provider: 'anthropic' }))
      .rejects.toThrow(SecretCellError);
  });

  it('rejects ciphertext, nonce, wrapped DEK, and AAD domain tampering without leaking material', async () => {
    const vault = createVault({ activeKeyId: 'root-v1', keys: { 'root-v1': rootV1 } });
    const sealed = await vault.seal(new TextEncoder().encode('sk-tamper-secret'), context);

    const tamperedCiphertext = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}AA` };
    const tamperedNonce = { ...sealed, nonce: `${sealed.nonce.slice(0, -2)}AA` };
    const tamperedDek = {
      ...sealed,
      wrappedDek: {
        ...sealed.wrappedDek,
        ciphertext: `${sealed.wrappedDek.ciphertext.slice(0, -2)}AA`,
      },
    };
    const tamperedPurpose: SecretCellEnvelope = { ...sealed, aadPurpose: 'xpod.secret-cell.other' as never };

    for (const envelope of [tamperedCiphertext, tamperedNonce, tamperedDek, tamperedPurpose]) {
      await expect(vault.open(envelope, context)).rejects.toThrow(/secret cell operation failed/i);
    }

    const error = await vault.open(tamperedCiphertext, context).catch((caught) => caught);
    expect(error).toBeInstanceOf(SecretCellError);
    expect(JSON.stringify(error)).not.toContain('sk-tamper-secret');
    expect(JSON.stringify(error)).not.toContain(sealed.ciphertext);
    expect(error.toJSON()).toEqual({ name: 'SecretCellError', message: 'Secret cell operation failed' });
  });

  it('uses fresh random DEKs and nonces for identical plaintext and context', async () => {
    const vault = createVault({ activeKeyId: 'root-v1', keys: { 'root-v1': rootV1 } });
    const plaintext = new TextEncoder().encode('same-secret');

    const first = await vault.seal(plaintext, context);
    const second = await vault.seal(plaintext, context);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedDek.ciphertext).not.toBe(second.wrappedDek.ciphertext);
  });

  it('decrypts with previous keys and rewraps only the DEK to the active key', async () => {
    const oldVault = createVault({ activeKeyId: 'root-v1', keys: { 'root-v1': rootV1 } });
    const sealed = await oldVault.seal(new TextEncoder().encode('rotated-secret'), context);
    const rotatedVault = createVault({
      activeKeyId: 'root-v2',
      keys: { 'root-v2': rootV2, 'root-v1': rootV1 },
    });

    await expect(rotatedVault.open(sealed, context)).resolves.toEqual(new TextEncoder().encode('rotated-secret'));

    const rewrapped = await rotatedVault.rewrap(sealed, context);

    expect(rewrapped.ciphertext).toBe(sealed.ciphertext);
    expect(rewrapped.nonce).toBe(sealed.nonce);
    expect(rewrapped.context).toEqual(sealed.context);
    expect(rewrapped.wrappedDek.keyId).toBe('root-v2');
    expect(rewrapped.wrappedDek.ciphertext).not.toBe(sealed.wrappedDek.ciphertext);
    await expect(rotatedVault.open(rewrapped, context)).resolves.toEqual(new TextEncoder().encode('rotated-secret'));
  });

  it('wraps and unwraps data keys for an existing KeyWrapper adapter shape', async () => {
    const vault = createVault({ activeKeyId: 'root-v1', keys: { 'root-v1': rootV1 } });
    const wrapper = new SecretCellKeyWrapper({
      vault,
      predicate: 'https://xpod.dev/ns#credentialSecret',
      field: 'providerCredentialSecret',
      schemaVersion: 'v1',
    });
    const keyWrapContext: KeyWrapContext = {
      webId: context.ownerWebId,
      credentialIri: context.resourceIri,
      provider: context.provider!,
    };
    const dek = new Uint8Array(32).fill(7);

    const wrapped = await wrapper.wrapDek(keyWrapContext, dek);
    const unwrapped = await wrapper.unwrapDek(keyWrapContext, wrapped);

    expect(wrapped.algorithm).toBe('xpod-secret-cell-root-hkdf-aes-256-gcm');
    expect(wrapped.keyId).toBe('root-v1');
    expect(wrapped.metadata).toMatchObject({
      aadPurpose: 'xpod.secret-cell.dek-wrap',
      aadVersion: 'v1',
      field: 'providerCredentialSecret',
      provider: 'openai',
      schemaVersion: 'v1',
    });
    expect(unwrapped).toEqual(dek);
  });
});

describe('DeploymentRootKeyProvider', () => {
  it('parses strict base64 32-byte root key config and rejects invalid material', () => {
    expect(parseDeploymentRootKeyConfig(rootV1)).toEqual(new Uint8Array(32).fill(1));

    expect(() => parseDeploymentRootKeyConfig(Buffer.alloc(31).toString('base64'))).toThrow(/32 bytes/i);
    expect(() => parseDeploymentRootKeyConfig(Buffer.alloc(33).toString('base64'))).toThrow(/32 bytes/i);
    expect(() => parseDeploymentRootKeyConfig('AQE')).toThrow(/base64/i);
    expect(() => parseDeploymentRootKeyConfig(`${rootV1.slice(0, -1)}!`)).toThrow(/base64/i);
  });
});

function createVault(input: {
  activeKeyId: string;
  keys: Record<string, string>;
}): SecretCellVault {
  return new SecretCellVault({
    rootKeys: new DeploymentRootKeyProvider({
      activeKeyId: input.activeKeyId,
      keys: Object.fromEntries(
        Object.entries(input.keys).map(([keyId, encoded]) => [keyId, parseDeploymentRootKeyConfig(encoded)]),
      ),
    }),
  });
}
