import { describe, expect, it } from 'vitest';

import { PlaintextCredentialVault } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialVault';
import { CredentialVaultError } from '../../../src/api/ai-gateway/credentials/CredentialVault';

describe('PlaintextCredentialVault', () => {
  it('stores provider credentials as plain JSON without an encryption key', async() => {
    const vault = new PlaintextCredentialVault();
    const principal = { webId: 'https://id.example/alice#me' };
    const record = await vault.seal(
      principal,
      'https://pod.example/settings/ai.ttl#openai',
      'openai',
      { type: 'apiKey', apiKey: 'sk-user-owned', baseUrl: 'https://api.example/v1' },
    );

    expect(record).toEqual({
      webId: principal.webId,
      credentialIri: 'https://pod.example/settings/ai.ttl#openai',
      provider: 'openai',
      secret: {
        type: 'apiKey',
        apiKey: 'sk-user-owned',
        baseUrl: 'https://api.example/v1',
      },
    });
    expect(record).not.toHaveProperty('algorithm');
    expect(record).not.toHaveProperty('ciphertext');
    expect(record).not.toHaveProperty('wrappedDek');
    expect(record.secret).toEqual({
      type: 'apiKey',
      apiKey: 'sk-user-owned',
      baseUrl: 'https://api.example/v1',
    });
    await expect(vault.open(
      principal,
      'https://pod.example/settings/ai.ttl#openai',
      'openai',
      record,
    )).resolves.toEqual({
      type: 'apiKey',
      apiKey: 'sk-user-owned',
      baseUrl: 'https://api.example/v1',
    });
  });

  it('still binds the stored value to its Pod owner and credential resource', async() => {
    const vault = new PlaintextCredentialVault();
    const record = await vault.seal(
      { webId: 'https://id.example/alice#me' },
      'https://pod.example/settings/ai.ttl#openai',
      'openai',
      { apiKey: 'sk-user-owned' },
    );

    await expect(vault.open(
      { webId: 'https://id.example/bob#me' },
      'https://pod.example/settings/ai.ttl#openai',
      'openai',
      record,
    )).rejects.toThrow(/context/i);
    await expect(vault.open(
      { webId: 'https://id.example/alice#me' },
      'https://pod.example/settings/ai.ttl#anthropic',
      'openai',
      record,
    )).rejects.toBeInstanceOf(CredentialVaultError);
    await expect(vault.open(
      { webId: 'https://id.example/alice#me' },
      'https://pod.example/settings/ai.ttl#openai',
      'anthropic',
      record,
    )).rejects.toThrow(/context/i);
  });

  it('rejects old encrypted-shaped records instead of migrating them', async() => {
    const vault = new PlaintextCredentialVault();
    const encrypted = {
      algorithm: 'AES-256-GCM',
      ciphertext: 'encrypted',
      webId: 'https://id.example/alice#me',
      credentialIri: 'https://pod.example/settings/ai.ttl#openai',
      provider: 'openai',
    } as any;

    await expect(vault.open({ webId: encrypted.webId }, encrypted.credentialIri, encrypted.provider, encrypted))
      .rejects.toThrow(/could not be read/i);
    await expect(vault.open(
      { webId: encrypted.webId },
      encrypted.credentialIri,
      encrypted.provider,
      { webId: encrypted.webId, credentialIri: encrypted.credentialIri, provider: encrypted.provider } as any,
    )).rejects.toThrow(/could not be read/i);
  });
});
