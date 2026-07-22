import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CloudKmsWrapper, type CloudKmsClient } from '../../../src/api/ai-gateway/credentials/CloudKmsWrapper';
import {
  LOCAL_KEYCHAIN_WRAP_AAD_PURPOSE,
  LOCAL_KEYCHAIN_WRAP_AAD_VERSION,
  LocalKeychainWrapper,
  type LocalSecureStore,
} from '../../../src/api/ai-gateway/credentials/LocalKeychainWrapper';
import {
  CREDENTIAL_SECRET_AAD_PURPOSE,
  CREDENTIAL_SECRET_AAD_VERSION,
  WebCryptoCredentialVault,
} from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
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

class ReferenceCapturingKeyWrapper implements KeyWrapper {
  public wrappedDekReference?: Uint8Array;
  public unwrappedDekReference?: Uint8Array;
  private readonly keys = new Map<string, Uint8Array>();

  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    this.wrappedDekReference = dek;
    const keyId = `${context.webId}|${context.credentialIri}|${context.provider}`;
    this.keys.set(keyId, new Uint8Array(dek));
    return {
      algorithm: 'reference-test-wrapper',
      keyId,
      wrappedDek: Buffer.from(keyId).toString('base64url'),
    };
  }

  public async unwrapDek(context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    const dek = this.keys.get(wrapped.keyId);
    if (!dek) {
      throw new Error('missing captured DEK');
    }
    this.unwrappedDekReference = new Uint8Array(dek);
    return this.unwrappedDekReference;
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
    expect(encrypted.aadPurpose).toBe(CREDENTIAL_SECRET_AAD_PURPOSE);
    expect(encrypted.aadVersion).toBe(CREDENTIAL_SECRET_AAD_VERSION);
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

  it('binds credential ciphertext to a fixed purpose and version domain', async () => {
    const wrapper = new RecordingKeyWrapper();
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper });
    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'apiKey',
      apiKey: 'domain-bound-secret',
    });

    await expect(vault.open(principal, credentialIri, provider, {
      ...encrypted,
      aadPurpose: 'xpod.ai-gateway.other-purpose',
    })).rejects.toThrow(/credential secret could not be decrypted/i);
    await expect(vault.open(principal, credentialIri, provider, {
      ...encrypted,
      aadVersion: 'v0',
    })).rejects.toThrow(/credential secret could not be decrypted/i);
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

  it('zeros owned DEK and serialized/decrypted plaintext byte buffers after use', async () => {
    const wrapper = new ReferenceCapturingKeyWrapper();
    const vault = new WebCryptoCredentialVault({ keyWrapper: wrapper });
    const capturedSealPlaintexts: Uint8Array[] = [];
    const originalEncrypt = webcrypto.subtle.encrypt.bind(webcrypto.subtle);
    const encryptPassthrough = vi.spyOn(webcrypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      capturedSealPlaintexts.push(data as Uint8Array);
      return await originalEncrypt(algorithm, key, data);
    });

    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'apiKey',
      apiKey: 'cleanup-secret',
    });
    encryptPassthrough.mockRestore();

    expect(wrapper.wrappedDekReference).toBeDefined();
    expect([...wrapper.wrappedDekReference!].every((byte) => byte === 0)).toBe(true);
    expect(capturedSealPlaintexts).toHaveLength(1);
    expect([...capturedSealPlaintexts[0]].every((byte) => byte === 0)).toBe(true);

    const decodedPlaintexts: Uint8Array[] = [];
    const originalDecode = TextDecoder.prototype.decode;
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function decode(input, options) {
      if (input instanceof Uint8Array) {
        decodedPlaintexts.push(input);
      }
      return originalDecode.call(this, input, options);
    });
    await vault.open(principal, credentialIri, provider, encrypted);
    decodeSpy.mockRestore();

    expect(wrapper.unwrappedDekReference).toBeDefined();
    expect([...wrapper.unwrappedDekReference!].every((byte) => byte === 0)).toBe(true);
    expect(decodedPlaintexts).toHaveLength(1);
    expect([...decodedPlaintexts[0]].every((byte) => byte === 0)).toBe(true);

    await vault.rewrap(principal, encrypted);
    expect(wrapper.unwrappedDekReference).toBeDefined();
    expect([...wrapper.unwrappedDekReference!].every((byte) => byte === 0)).toBe(true);
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
    expect(encrypted.metadata).toMatchObject({
      purpose: LOCAL_KEYCHAIN_WRAP_AAD_PURPOSE,
      version: LOCAL_KEYCHAIN_WRAP_AAD_VERSION,
    });
    await expect(vault.open(principal, credentialIri, provider, encrypted)).resolves.toMatchObject({
      apiKey: 'local-secret',
    });
    await expect(vault.open(principal, credentialIri, 'anthropic', encrypted))
      .rejects.toThrow(/credential secret could not be decrypted/i);
  });

  it('keeps concurrent first local seals on the same master key', async () => {
    const secrets = new Map<string, string>();
    const getSecret = vi.fn(async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return secrets.get(key) ?? null;
    });
    const secureStore: LocalSecureStore = {
      getSecret,
      setSecret: vi.fn(async (key, value) => {
        secrets.set(key, value);
      }),
    };
    const firstWrapper = new LocalKeychainWrapper({
      secureStore,
      keyId: 'xpod-concurrent-master',
    });
    const secondWrapper = new LocalKeychainWrapper({
      secureStore,
      keyId: 'xpod-concurrent-master',
    });
    const firstVault = new WebCryptoCredentialVault({ keyWrapper: firstWrapper });
    const secondVault = new WebCryptoCredentialVault({ keyWrapper: secondWrapper });

    const [first, second] = await Promise.all([
      firstVault.seal(principal, credentialIri, provider, { type: 'apiKey', apiKey: 'first' }),
      secondVault.seal(principal, credentialIri, provider, { type: 'apiKey', apiKey: 'second' }),
    ]);

    expect(secureStore.setSecret).toHaveBeenCalledTimes(1);
    await expect(firstVault.open(principal, credentialIri, provider, first)).resolves.toMatchObject({ apiKey: 'first' });
    await expect(secondVault.open(principal, credentialIri, provider, second)).resolves.toMatchObject({ apiKey: 'second' });
  });

  it('uses atomic secure-store getOrCreate when the injected boundary provides it', async () => {
    const secrets = new Map<string, string>();
    const secureStore: LocalSecureStore = {
      getSecret: vi.fn(async (key) => secrets.get(key) ?? null),
      setSecret: vi.fn(async (key, value) => {
        secrets.set(key, value);
      }),
      getOrCreateSecret: vi.fn(async (key, create) => {
        const existing = secrets.get(key);
        if (existing) {
          return existing;
        }
        const created = await create();
        secrets.set(key, created);
        return created;
      }),
    };
    const vault = new WebCryptoCredentialVault({
      keyWrapper: new LocalKeychainWrapper({
        secureStore,
        keyId: 'xpod-atomic-master',
      }),
    });

    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'apiKey',
      apiKey: 'atomic-secret',
    });

    expect(secureStore.getOrCreateSecret).toHaveBeenCalledTimes(1);
    expect(secureStore.setSecret).not.toHaveBeenCalled();
    await expect(vault.open(principal, credentialIri, provider, encrypted)).resolves.toMatchObject({
      apiKey: 'atomic-secret',
    });
  });

  it('rejects local DEK wrappers whose purpose or version domain is changed', async () => {
    const secrets = new Map<string, string>();
    const secureStore: LocalSecureStore = {
      getSecret: vi.fn(async (key) => secrets.get(key) ?? null),
      setSecret: vi.fn(async (key, value) => {
        secrets.set(key, value);
      }),
    };
    const vault = new WebCryptoCredentialVault({
      keyWrapper: new LocalKeychainWrapper({
        secureStore,
        keyId: 'xpod-local-domain-master',
      }),
    });
    const encrypted = await vault.seal(principal, credentialIri, provider, {
      type: 'apiKey',
      apiKey: 'local-domain-secret',
    });

    await expect(vault.open(principal, credentialIri, provider, {
      ...encrypted,
      metadata: { ...encrypted.metadata, purpose: 'xpod.ai-gateway.other-local-wrap' },
    })).rejects.toThrow(/credential secret could not be decrypted/i);
    await expect(vault.open(principal, credentialIri, provider, {
      ...encrypted,
      metadata: { ...encrypted.metadata, version: 'v0' },
    })).rejects.toThrow(/credential secret could not be decrypted/i);
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
