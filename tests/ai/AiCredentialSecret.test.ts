import { describe, expect, it, vi } from 'vitest';

import {
  decodePlaintextAiCredentialSecret,
  defaultAiCredentialSecretDecoder,
  providerTokenFromSecret,
} from '../../src/ai/service/AiCredentialSecret';
import { createAiCredentialSecretDecoder } from '../../src/api/ai-gateway/credentials/AiCredentialSecretDecoder';
import type { CredentialVault } from '../../src/api/ai-gateway/credentials/CredentialVault';

function envelope(secret: Record<string, unknown>): string {
  return JSON.stringify({
    algorithm: 'PLAINTEXT',
    encoding: 'base64',
    ciphertext: Buffer.from(JSON.stringify(secret), 'utf8').toString('base64'),
  });
}

describe('AI credential secret decoding', () => {
  it('reads the legacy bare apiKey', () => {
    expect(decodePlaintextAiCredentialSecret({ apiKey: 'sk-legacy' })).toEqual({ apiKey: 'sk-legacy' });
  });

  it('reads the plaintext-v1 payload shape', () => {
    expect(decodePlaintextAiCredentialSecret({
      storageMode: 'plaintext-v1',
      secretPayload: JSON.stringify({ type: 'apiKey', apiKey: 'sk-payload' }),
    })).toEqual({ type: 'apiKey', apiKey: 'sk-payload' });
  });

  it('reads the PLAINTEXT envelope AI Connections writes', () => {
    expect(decodePlaintextAiCredentialSecret({ encryptedSecret: envelope({ type: 'apiKey', apiKey: 'sk-envelope' }) }))
      .toEqual({ type: 'apiKey', apiKey: 'sk-envelope' });
  });

  it('accepts an envelope that is still an object', () => {
    expect(decodePlaintextAiCredentialSecret({
      encryptedSecret: JSON.parse(envelope({ type: 'apiKey', apiKey: 'sk-object' })),
    })).toEqual({ type: 'apiKey', apiKey: 'sk-object' });
  });

  it('leaves wrapped envelopes to the vault', () => {
    const wrapped = { algorithm: 'AES-256-GCM', ciphertext: 'x', wrappedDek: 'y' };
    expect(decodePlaintextAiCredentialSecret({ encryptedSecret: JSON.stringify(wrapped) })).toBeUndefined();
    expect(decodePlaintextAiCredentialSecret({ encryptedSecret: JSON.stringify(wrapped), apiKey: undefined })).toBeUndefined();
  });

  it('ignores malformed payloads instead of throwing', () => {
    expect(decodePlaintextAiCredentialSecret({ encryptedSecret: 'not-json' })).toBeUndefined();
    expect(decodePlaintextAiCredentialSecret({ storageMode: 'plaintext-v1', secretPayload: '[]' })).toBeUndefined();
    expect(decodePlaintextAiCredentialSecret({})).toBeUndefined();
  });

  it('maps apiKey, accessToken and token to a provider token', () => {
    expect(providerTokenFromSecret({ apiKey: 'sk-a' })).toBe('sk-a');
    expect(providerTokenFromSecret({ accessToken: 'oauth-token' })).toBe('oauth-token');
    expect(providerTokenFromSecret({ token: 'legacy-token' })).toBe('legacy-token');
    expect(providerTokenFromSecret({})).toBeUndefined();
    expect(providerTokenFromSecret(undefined)).toBeUndefined();
  });

  it('falls back to the vault for wrapped secrets', async () => {
    const open = vi.fn(async () => ({ apiKey: 'sk-wrapped' }));
    const vault = { open } as unknown as CredentialVault;
    const decode = createAiCredentialSecretDecoder({ vault });

    await expect(decode(
      { encryptedSecret: JSON.stringify({ algorithm: 'AES-256-GCM', ciphertext: 'x' }) },
      { webId: 'https://pod.example/alice/profile/card#me', credentialIri: 'https://pod.example/alice/settings/credentials.ttl#cloud-openai', provider: 'openai' },
    )).resolves.toEqual({ apiKey: 'sk-wrapped' });
    expect(open).toHaveBeenCalledWith(
      { webId: 'https://pod.example/alice/profile/card#me' },
      'https://pod.example/alice/settings/credentials.ttl#cloud-openai',
      'openai',
      expect.objectContaining({ algorithm: 'AES-256-GCM' }),
    );
  });

  it('treats an unopenable wrapped secret as unavailable', async () => {
    const vault = { open: vi.fn(async () => { throw new Error('no key'); }) } as unknown as CredentialVault;
    const decode = createAiCredentialSecretDecoder({ vault });

    await expect(decode(
      { encryptedSecret: JSON.stringify({ algorithm: 'AES-256-GCM', ciphertext: 'x' }) },
      { webId: 'https://pod.example/alice/profile/card#me' },
    )).resolves.toBeUndefined();
  });

  it('does not need a vault for plaintext envelopes', () => {
    expect(defaultAiCredentialSecretDecoder(
      { encryptedSecret: envelope({ type: 'apiKey', apiKey: 'sk-plain' }) },
      { webId: 'https://pod.example/alice/profile/card#me' },
    )).toEqual({ type: 'apiKey', apiKey: 'sk-plain' });
  });
});
