import { describe, expect, it, vi } from 'vitest';
import { CloudKmsWrapper, type CloudKmsClient } from '../../../src/api/ai-gateway/credentials/CloudKmsWrapper';
import { LocalKeychainWrapper, type LocalSecureStore } from '../../../src/api/ai-gateway/credentials/LocalKeychainWrapper';
import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type {
  EncryptedCredentialSecret,
  KeyWrapContext,
  KeyWrapper,
  WrappedDataKey,
} from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import type { GatewayPrincipal, ProviderSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';

const principal: GatewayPrincipal = { webId: 'https://alice.example/profile#me' };
const credentialIri = 'https://alice.example/settings/ai/credentials/openai';
const provider = 'openai';

class RecordingKeyWrapper implements KeyWrapper {
  public version = 'v1';
  public readonly wrappedDeks: Uint8Array[] = [];
  private readonly keys = new Map<string, Uint8Array>();

  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    const keyId = `${context.webId}|${context.credentialIri}|${context.provider}|${this.version}`;
    this.wrappedDeks.push(new Uint8Array(dek));
    this.keys.set(keyId, new Uint8Array(dek));
    return {
      algorithm: 'test-wrapper',
      keyId,
      keyVersion: this.version,
      wrappedDek: Buffer.from(JSON.stringify({ keyId, material: Buffer.from(dek).toString('base64url') }))
        .toString('base64url'),
      metadata: { version: this.version },
    };
  }

  public async unwrapDek(context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    expect(context).toEqual({
      webId: principal.webId,
      credentialIri,
      provider,
    });
    const key = this.keys.get(wrapped.keyId);
    if (!key) {
      throw new Error('missing wrapped test key');
    }
    return new Uint8Array(key);
  }
}

describe('WebCryptoCredentialVault', () => {
  it('seals and opens provider secrets without serializing plaintext into the Pod payload', async () => {
    const wrapper = new RecordingKeyWrapper();
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper });
    const secret: ProviderSecret = {
      type: 'apiKey',
      apiKey: 'sk-plaintext-never-store',
      refreshToken: 'refresh-token-never-store',
    };

    const encrypted = await vault.seal(principal, credentialIri, provider, secret);

    expect(encrypted.algorithm).toBe('AES-256-GCM');
    expect(encrypted.webId).toBe(principal.webId);
    expect(encrypted.credentialIri).toBe(credentialIri);
    expect(encrypted.provider).toBe(provider);
    expect(JSON.stringify(encrypted)).not.toContain('sk-plaintext-never-store');
    expect(JSON.stringify(encrypted)).not.toContain('refresh-token-never-store');
    await expect(vault.open(principal, credentialIri, provider, encrypted)).resolves.toEqual(secret);
  });

  it('uses independent random DEKs and nonces for every seal operation', async () => {
    const wrapper = new RecordingKeyWrapper();
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper });
    const secret: ProviderSecret = { type: 'apiKey', apiKey: 'same-secret' };

    const first = await vault.seal(principal, credentialIri, provider, secret);
    const second = await vault.seal(principal, credentialIri, provider, secret);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedDek).not.toBe(second.wrappedDek);
    expect(wrapper.wrappedDeks).toHaveLength(2);
    expect(Buffer.compare(Buffer.from(wrapper.wrappedDeks[0]), Buffer.from(wrapper.wrappedDeks[1]))).not.toBe(0);
    expect(wrapper.wrappedDeks.every((dek) => dek.byteLength === 32)).toBe(true);
  });

  it('binds authentication data to WebID, credential IRI, and provider', async () => {
    const wrapper = new RecordingKeyWrapper();
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper });
    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'apiKey',
      apiKey: 'aad-bound-secret',
    });

    await expect(vault.open({ webId: 'https://mallory.example/#me' }, credentialIri, provider, encrypted))
      .rejects.toThrow(/credential secret could not be decrypted/i);
    await expect(vault.open(principal, `${credentialIri}-other`, provider, encrypted))
      .rejects.toThrow(/credential secret could not be decrypted/i);
    await expect(vault.open(principal, credentialIri, 'anthropic', encrypted))
      .rejects.toThrow(/credential secret could not be decrypted/i);
  });

  it('fails closed on ciphertext tampering without leaking plaintext in errors or logs', async () => {
    const wrapper = new RecordingKeyWrapper();
    const logger = { warn: vi.fn() };
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper, logger });
    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'apiKey',
      apiKey: 'sk-tamper-plaintext',
    });
    const tampered: EncryptedCredentialSecret = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA`,
    };

    await expect(vault.open(principal, credentialIri, provider, tampered))
      .rejects.toThrow(/credential secret could not be decrypted/i);

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('sk-tamper-plaintext');
    expect(logged).not.toContain(encrypted.ciphertext);
  });

  it('rewraps only the DEK wrapper metadata and leaves payload ciphertext unchanged', async () => {
    const wrapper = new RecordingKeyWrapper();
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper });
    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'oauth',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });

    wrapper.version = 'v2';
    const rewrapped = await vault.rewrap(principal, encrypted);

    expect(rewrapped.ciphertext).toBe(encrypted.ciphertext);
    expect(rewrapped.nonce).toBe(encrypted.nonce);
    expect(rewrapped.webId).toBe(encrypted.webId);
    expect(rewrapped.credentialIri).toBe(encrypted.credentialIri);
    expect(rewrapped.provider).toBe(encrypted.provider);
    expect(rewrapped.wrappedDek).not.toBe(encrypted.wrappedDek);
    expect(rewrapped.keyVersion).toBe('v2');
    await expect(vault.open(principal, credentialIri, provider, rewrapped)).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  it('uses an injected local secure-store boundary to wrap and unwrap DEKs', async () => {
    const secrets = new Map<string, string>();
    const secureStore: LocalSecureStore = {
      getSecret: vi.fn(async (key) => secrets.get(key) ?? null),
      setSecret: vi.fn(async (key, value) => {
        secrets.set(key, value);
      }),
    };
    const wrapper = new LocalKeychainWrapper({
      secureStore,
      keyId: 'xpod-local-ai-gateway-master',
      keyVersion: 'local-v1',
    });
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper });
    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'apiKey',
      apiKey: 'local-secret',
    });

    expect(secureStore.setSecret).toHaveBeenCalledTimes(1);
    expect(encrypted.dekWrapAlgorithm).toBe('local-keychain-aes-256-gcm');
    expect(encrypted.keyId).toBe('xpod-local-ai-gateway-master');
    expect(encrypted.keyVersion).toBe('local-v1');
    await expect(vault.open(principal, credentialIri, provider, encrypted)).resolves.toMatchObject({
      apiKey: 'local-secret',
    });
    await expect(vault.open(principal, credentialIri, 'anthropic', encrypted))
      .rejects.toThrow(/credential secret could not be decrypted/i);
  });

  it('delegates Cloud wrapping to an injected KMS client with credential-bound context', async () => {
    const encryptedDeks = new Map<string, Uint8Array>();
    const kmsClient: CloudKmsClient = {
      encrypt: vi.fn(async (input) => {
        expect(input.keyArn).toBe('arn:example:kms:ai-gateway');
        expect(input.encryptionContext).toEqual({
          webId: principal.webId,
          credentialIri,
          provider,
        });
        const ciphertext = new Uint8Array(input.plaintext).reverse();
        const encoded = Buffer.from(ciphertext).toString('base64url');
        encryptedDeks.set(encoded, new Uint8Array(input.plaintext));
        return {
          ciphertext,
          keyId: input.keyArn,
          keyVersion: 'cloud-v1',
        };
      }),
      decrypt: vi.fn(async (input) => {
        expect(input.encryptionContext).toEqual({
          webId: principal.webId,
          credentialIri,
          provider,
        });
        const plaintext = encryptedDeks.get(Buffer.from(input.ciphertext).toString('base64url'));
        if (!plaintext) {
          throw new Error('missing encrypted DEK');
        }
        return { plaintext };
      }),
    };
    const vault = new WebCryptoCredentialVault({
      keyWrapper: new CloudKmsWrapper({
        kmsClient,
        keyArn: 'arn:example:kms:ai-gateway',
      }),
    });

    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'oauth',
      accessToken: 'cloud-access-token',
    });

    expect(encrypted.dekWrapAlgorithm).toBe('cloud-kms');
    expect(encrypted.keyVersion).toBe('cloud-v1');
    await expect(vault.open(principal, credentialIri, provider, encrypted)).resolves.toMatchObject({
      accessToken: 'cloud-access-token',
    });
  });
});
