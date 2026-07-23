import { describe, expect, it } from 'vitest';

import { SecretCellCredentialVault } from '../../../src/api/ai-gateway/credentials/SecretCellCredentialVault';
import {
  DeploymentRootKeyProvider,
  SecretCellVault,
} from '../../../src/security/secret-cell';

const principal = { webId: 'https://id.example/alice/profile/card#me' };
const credentialIri = 'https://pod.example/settings/credentials.ttl#openai';

describe('SecretCell CredentialVault compatibility', () => {
  it('keeps the existing Pod encrypted-record shape while rotating only the wrapped DEK', async() => {
    const oldVault = credentialVault('root-v1', {
      'root-v1': new Uint8Array(32).fill(1),
    });
    const encrypted = await oldVault.seal(principal, credentialIri, 'openai', {
      apiKey: 'sk-secret',
      refreshToken: 'refresh-secret',
    });

    expect(encrypted.algorithm).toBe('AES-256-GCM');
    expect(encrypted.dekWrapAlgorithm).toBe('xpod-secret-cell-root-hkdf-aes-256-gcm');
    expect(encrypted.keyId).toBe('root-v1');
    expect(JSON.stringify(encrypted)).not.toContain('sk-secret');
    await expect(oldVault.open(principal, credentialIri, 'openai', encrypted)).resolves.toEqual({
      apiKey: 'sk-secret',
      refreshToken: 'refresh-secret',
    });

    const rotatedVault = credentialVault('root-v2', {
      'root-v1': new Uint8Array(32).fill(1),
      'root-v2': new Uint8Array(32).fill(2),
    });
    const rewrapped = await rotatedVault.rewrap(principal, encrypted);

    expect(rewrapped.ciphertext).toBe(encrypted.ciphertext);
    expect(rewrapped.nonce).toBe(encrypted.nonce);
    expect(rewrapped.wrappedDek).not.toBe(encrypted.wrappedDek);
    expect(rewrapped.keyId).toBe('root-v2');
    await expect(rotatedVault.open(principal, credentialIri, 'openai', rewrapped)).resolves.toEqual({
      apiKey: 'sk-secret',
      refreshToken: 'refresh-secret',
    });
  });
});

function credentialVault(activeKeyId: string, keys: Record<string, Uint8Array>): SecretCellCredentialVault {
  return new SecretCellCredentialVault({
    vault: new SecretCellVault({
      rootKeys: new DeploymentRootKeyProvider({ activeKeyId, keys }),
    }),
  });
}
