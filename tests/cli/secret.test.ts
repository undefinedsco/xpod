import { describe, expect, it } from 'vitest';
import {
  buildSecretPlan,
  buildSecretUpsertSparql,
  resolveSecretSelector,
} from '../../src/cli/commands/secret';

describe('secret command helpers', () => {
  it('builds descriptor-backed credential subjects from the shared model descriptor', () => {
    const plan = buildSecretPlan('https://pod.example/alice/', {
      service: 'infra',
      provider: 'cloudflare',
      kind: 'tunnel-token',
      json: false,
    });

    expect(plan.schemaUri).toBe('https://vocab.xpod.dev/credential#Credential');
    expect(plan.subject).toBe('https://pod.example/alice/settings/credentials.ttl#infra-cloudflare-tunnel-token');
    expect(plan.resourceUrl).toBe('https://pod.example/alice/settings/credentials.ttl');
    expect(plan.redacted).toBe(true);
  });

  it('writes secret values only into the SPARQL update body', () => {
    const plan = buildSecretPlan('https://pod.example/alice/', {
      service: 'ai',
      provider: 'openai',
      kind: 'api-key',
      json: false,
    });
    const sparql = buildSecretUpsertSparql(plan, {
      value: 'sk-secret',
      label: 'OpenAI',
    });

    expect(sparql).toContain('<https://vocab.xpod.dev/credential#apiKey> "sk-secret"');
    expect(sparql).toContain('<https://vocab.xpod.dev/credential#provider> "openai"');
    expect(sparql).toContain('<https://vocab.xpod.dev/credential#secretType> "api-key"');
  });

  it('deletes existing secret material when revoking', () => {
    const plan = buildSecretPlan('https://pod.example/alice/', {
      service: 'ai',
      provider: 'openai',
      kind: 'api-key',
      json: false,
    });
    const sparql = buildSecretUpsertSparql(plan, { revoke: true });

    expect(sparql).toContain('?oldApiKey');
    expect(sparql).toContain('<https://vocab.xpod.dev/credential#status> "revoked"');
    expect(sparql).not.toContain('<https://vocab.xpod.dev/credential#apiKey> "');
  });

  it('resolves compact secret selectors without exposing values', () => {
    expect(resolveSecretSelector({
      selector: 'infra/cloudflare/tunnel-token',
      json: false,
    })).toMatchObject({
      service: 'infra',
      provider: 'cloudflare',
      kind: 'tunnel-token',
    });

    expect(resolveSecretSelector({
      selector: 'openai/api-key',
      json: false,
    })).toMatchObject({
      service: 'ai',
      provider: 'openai',
      kind: 'api-key',
    });
  });
});
