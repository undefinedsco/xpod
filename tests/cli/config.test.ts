/**
 * Config command unit tests
 *
 * Verifies:
 * 1. SPARQL generation aligns with drizzle-solid schema (namespace, predicates, subject templates)
 * 2. Credential ID generation
 * 3. maskSecret helper
 * 4. Provider → Credential URI linkage
 */

import { describe, it, expect } from 'vitest';
import {
  buildProviderSparql,
  buildCredentialSparql,
  buildResetSparql,
  credentialId,
  maskSecret,
  AI_NS,
  CREDENTIAL_NS,
  PROVIDER_BASE_URLS,
} from '../../src/cli/commands/config';

// These must match the drizzle-solid schema definitions exactly
const PROVIDER_BASE_PATH = '/settings/providers/openai.ttl';
const CREDENTIAL_BASE_PATH = '/settings/credentials.ttl';

const POD_URL = 'http://localhost:3000/alice/';
const PROVIDER_RESOURCE = `${POD_URL}settings/providers/openai.ttl`;
const CREDENTIAL_RESOURCE = `${POD_URL}settings/credentials.ttl`;

describe('config command', () => {
  describe('credentialId', () => {
    it('should generate cred-{provider} format', () => {
      expect(credentialId('openai')).toBe('cred-openai');
      expect(credentialId('Google')).toBe('cred-google');
      expect(credentialId('ANTHROPIC')).toBe('cred-anthropic');
    });
  });

  describe('maskSecret', () => {
    it('should mask short secrets entirely', () => {
      expect(maskSecret('abc')).toBe('****');
      expect(maskSecret('12345678')).toBe('****');
    });

    it('should show first 4 and last 4 chars for longer secrets', () => {
      expect(maskSecret('sk-1234567890abcdef')).toBe('sk-1****cdef');
      expect(maskSecret('123456789')).toBe('1234****6789');
    });
  });

  describe('namespaces', () => {
    it('should match the namespace used by drizzle-solid schemas', () => {
      expect(AI_NS).toBe('https://vocab.xpod.dev/ai#');
      expect(CREDENTIAL_NS).toBe('https://vocab.xpod.dev/credential#');
    });
  });

  describe('buildProviderSparql', () => {
    it('should target the provider document URI', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain(`<${PROVIDER_RESOURCE}>`);
    });

    it('should use ai:Provider type matching Provider schema type', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('a ai:Provider');
    });

    it('should write ai:baseUrl matching Provider schema field', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('ai:baseUrl');
      expect(sparql).toContain(PROVIDER_BASE_URLS.openai);
    });

    it('should write ai:displayName matching Provider schema field', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('ai:displayName "OpenAI"');
    });

    it('should use correct PREFIX', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toMatch(/^PREFIX ai: <https:\/\/vocab\.xpod\.dev\/ai#>/);
    });

    it('should handle unknown provider without baseUrl', () => {
      const resource = `${POD_URL}settings/providers/custom-provider.ttl`;
      const sparql = buildProviderSparql(resource, 'custom-provider');
      expect(sparql).toContain(`<${resource}>`);
      expect(sparql).toContain('a ai:Provider');
      expect(sparql).toContain('ai:displayName "Custom Provider"');
      // No baseUrl for unknown provider
      expect(sparql).not.toMatch(/ai:baseUrl "[^"]+"/);
    });

    it('should include DELETE for old values (upsert pattern)', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('DELETE');
      expect(sparql).toContain('?oldBase');
      expect(sparql).toContain('?oldName');
      expect(sparql).toContain('OPTIONAL');
    });

    it('should write default model into the provider resource when provided', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai', { model: 'gpt-4o' });
      expect(sparql).toContain(`<${PROVIDER_RESOURCE}#gpt-4o> a ai:Model`);
      expect(sparql).toContain(`ai:defaultModel <${PROVIDER_RESOURCE}#gpt-4o>`);
      expect(sparql).toContain(`ai:hasModel <${PROVIDER_RESOURCE}#gpt-4o>`);
      expect(sparql).toContain(`ai:isProvidedBy <${PROVIDER_RESOURCE}>`);
    });
  });

  describe('buildCredentialSparql', () => {
    it('should target the credential subject for cred-{provider}', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      // Subject must be {base}#cred-{provider}
      expect(sparql).toContain(`<${CREDENTIAL_RESOURCE}#cred-openai>`);
    });

    it('should use cred:Credential type matching Credential schema type', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      expect(sparql).toContain('a cred:Credential');
    });

    it('should set service=ai and status=active for getAiConfig() query', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      // PodChatKitStore.getAiConfig() queries: eq(Credential.service, 'ai'), eq(Credential.status, 'active')
      expect(sparql).toContain('cred:service "ai"');
      expect(sparql).toContain('cred:status "active"');
    });

    it('should link to provider URI matching Provider schema base path', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      // getAiConfig() extracts providerId from cred.provider URI via extractProviderId()
      expect(sparql).toContain(`cred:provider <${POD_URL}settings/providers/openai.ttl>`);
    });

    it('should write cred:apiKey matching Credential schema field', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test-key-123' });
      expect(sparql).toContain('cred:apiKey "sk-test-key-123"');
    });

    it('should not write model fields into credentials', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test', model: 'gpt-4o' });
      expect(sparql).not.toContain('defaultModel');
      expect(sparql).not.toContain('gpt-4o');
    });

    it('should omit apiKey from SPARQL when not provided', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { model: 'gpt-4o' });
      expect(sparql).not.toContain('cred:apiKey');
    });

    it('should omit defaultModel from SPARQL when not provided', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      expect(sparql).not.toContain('defaultModel');
    });

    it('should always delete+reinsert provider link (upsert)', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', {});
      expect(sparql).toContain('DELETE');
      expect(sparql).toContain('?oldProv');
    });

    it('should set all three fields together', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'anthropic', {
        apiKey: 'sk-ant-xxx',
        model: 'claude-sonnet-4-20250514',
      });
      expect(sparql).toContain(`<${CREDENTIAL_RESOURCE}#cred-anthropic>`);
      expect(sparql).toContain(`<${POD_URL}settings/providers/anthropic.ttl>`);
      expect(sparql).toContain('cred:apiKey "sk-ant-xxx"');
      expect(sparql).toContain('cred:service "ai"');
      expect(sparql).toContain('cred:status "active"');
    });
  });

  describe('buildResetSparql', () => {
    it('should target the correct credential subject', () => {
      const sparql = buildResetSparql(CREDENTIAL_RESOURCE, 'openai');
      expect(sparql).toContain(`<${CREDENTIAL_RESOURCE}#cred-openai>`);
    });

    it('should delete all triples for the subject', () => {
      const sparql = buildResetSparql(CREDENTIAL_RESOURCE, 'openai');
      expect(sparql).toContain('DELETE WHERE');
      expect(sparql).toContain('?p ?o');
    });
  });

  describe('schema alignment', () => {
    it('Provider resource path should match Provider schema base', () => {
      // Provider schema: base: '/settings/providers/'
      expect(PROVIDER_RESOURCE).toContain(PROVIDER_BASE_PATH);
    });

    it('Credential resource path should match Credential schema base', () => {
      // Credential schema: base: '/settings/credentials.ttl'
      expect(CREDENTIAL_RESOURCE).toContain(CREDENTIAL_BASE_PATH);
    });

    it('provider URI in credential should be extractable by PodChatKitStore.extractProviderId', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'google', { apiKey: 'key' });
      const providerUriMatch = sparql.match(/cred:provider <([^>]+)>/);
      expect(providerUriMatch).not.toBeNull();

      const providerUri = providerUriMatch![1];
      const extractedId = providerUri.split('/').pop()!.replace(/\.ttl$/, '');
      expect(extractedId).toBe('google');
    });

    it('all known providers should have base URLs', () => {
      const knownProviders = ['openai', 'google', 'anthropic', 'deepseek', 'openrouter', 'ollama', 'mistral', 'cohere', 'zhipu'];
      for (const p of knownProviders) {
        expect(PROVIDER_BASE_URLS[p]).toBeDefined();
        expect(PROVIDER_BASE_URLS[p]).toMatch(/^https?:\/\//);
      }
    });
  });
});
