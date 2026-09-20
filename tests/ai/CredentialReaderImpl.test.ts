import { describe, expect, it, vi } from 'vitest';

const credentialRows: Record<string, unknown>[] = [];
const providerRows: Record<string, unknown>[] = [];

vi.mock('@undefineds.co/drizzle-solid', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    drizzle: vi.fn(() => ({
      query: {
        credential: { findMany: async () => credentialRows },
        provider: { findMany: async () => providerRows },
      },
    })),
    eq: vi.fn((...args: unknown[]) => args),
    and: vi.fn((...args: unknown[]) => args),
  };
});

import { CredentialReaderImpl } from '../../src/ai/service/CredentialReaderImpl';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_BASE_URL = 'https://pod.example/alice/';

function envelope(secret: Record<string, unknown>): string {
  return JSON.stringify({
    algorithm: 'PLAINTEXT',
    encoding: 'base64',
    ciphertext: Buffer.from(JSON.stringify(secret), 'utf8').toString('base64'),
    webId: WEB_ID,
    credentialIri: `${POD_BASE_URL}settings/providers/openai.ttl#cred-openai`,
    provider: 'openai',
  });
}

function resetRows(credential: Record<string, unknown>): void {
  credentialRows.length = 0;
  credentialRows.push(credential);
  providerRows.length = 0;
  providerRows.push({
    id: 'openai',
    '@id': `${POD_BASE_URL}settings/providers/openai.ttl`,
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  });
}

describe('CredentialReaderImpl AI Connections credentials', () => {
  it('resolves a key stored in the AI Connections envelope', async () => {
    resetRows({
      id: 'cloud-openai',
      provider: `${POD_BASE_URL}settings/providers/openai.ttl`,
      service: 'ai',
      status: 'active',
      encryptedSecret: envelope({ type: 'apiKey', apiKey: 'sk-connections' }),
      metadata: JSON.stringify({ enabled: true }),
    });

    const reader = new CredentialReaderImpl();
    await expect(reader.getAiCredential(POD_BASE_URL, 'openai', (async () => new Response()) as typeof fetch, WEB_ID))
      .resolves.toMatchObject({ provider: 'openai', apiKey: 'sk-connections' });
  });

  it('ignores a credential disabled in AI Connections', async () => {
    resetRows({
      id: 'cloud-openai',
      provider: `${POD_BASE_URL}settings/providers/openai.ttl`,
      service: 'ai',
      status: 'active',
      apiKey: 'sk-disabled',
      metadata: JSON.stringify({ enabled: false }),
    });

    const reader = new CredentialReaderImpl();
    await expect(reader.getAiCredential(POD_BASE_URL, 'openai', (async () => new Response()) as typeof fetch, WEB_ID))
      .resolves.toBeNull();
  });

  it('keeps the legacy bare apiKey working', async () => {
    resetRows({
      id: 'local-openai',
      provider: `${POD_BASE_URL}settings/providers/openai.ttl`,
      service: 'ai',
      status: 'active',
      apiKey: 'sk-legacy',
    });

    const reader = new CredentialReaderImpl();
    await expect(reader.getAiCredential(POD_BASE_URL, 'openai', (async () => new Response()) as typeof fetch, WEB_ID))
      .resolves.toMatchObject({ apiKey: 'sk-legacy' });
  });
});
