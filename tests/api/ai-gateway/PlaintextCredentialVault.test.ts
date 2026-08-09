import { describe, expect, it } from 'vitest';

import { PlaintextCredentialVault } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialVault';

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

    expect(record.algorithm).toBe('PLAINTEXT');
    expect(record.ciphertext).toBe(JSON.stringify({
      type: 'apiKey',
      apiKey: 'sk-user-owned',
      baseUrl: 'https://api.example/v1',
    }));
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
  });

  it('reads browser-written legacy base64 plaintext envelopes', async() => {
    const vault = new PlaintextCredentialVault();
    const principal = { webId: 'https://id.example/alice#me' };
    const credentialIri = 'https://pod.example/settings/ai.ttl#openai';
    const record = {
      algorithm: 'PLAINTEXT' as const,
      encoding: 'base64',
      ciphertext: Buffer.from(JSON.stringify({ type: 'apiKey', apiKey: 'sk-browser' })).toString('base64'),
      webId: principal.webId,
      credentialIri,
      provider: 'openai',
      aadPurpose: 'xpod-provider-credential',
      aadVersion: 'v1',
      nonce: '',
      dekWrapAlgorithm: 'PLAINTEXT',
      keyId: 'plaintext',
      wrappedDek: '',
    };

    await expect(vault.open(principal, credentialIri, 'openai', record as never))
      .resolves.toEqual({ type: 'apiKey', apiKey: 'sk-browser' });
  });

  it('reads a legacy encrypted record but rewrites it as plaintext', async() => {
    const legacy = {
      seal: async() => { throw new Error('new writes must not use the legacy vault'); },
      open: async() => ({ apiKey: 'sk-legacy' }),
      rewrap: async(record: any) => record,
    };
    const vault = new PlaintextCredentialVault({ legacyVault: legacy });
    const encrypted = {
      algorithm: 'AES-256-GCM' as const,
      aadPurpose: 'legacy',
      aadVersion: 'v1',
      ciphertext: 'encrypted',
      nonce: 'nonce',
      webId: 'https://id.example/alice#me',
      credentialIri: 'https://pod.example/settings/ai.ttl#openai',
      provider: 'openai',
      dekWrapAlgorithm: 'legacy',
      keyId: 'legacy',
      wrappedDek: 'wrapped',
    };

    const rewritten = await vault.rewrap({ webId: encrypted.webId }, encrypted);

    expect(rewritten.algorithm).toBe('PLAINTEXT');
    expect(rewritten.ciphertext).toBe(JSON.stringify({ apiKey: 'sk-legacy' }));
  });
});
