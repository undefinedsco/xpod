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
  UDFS_NS,
  PROVIDER_BASE_URLS,
} from '../../src/cli/commands/config';

// These must match the drizzle-solid schema definitions exactly
const PROVIDER_BASE_PATH = '/settings/ai/providers.ttl';
const CREDENTIAL_BASE_PATH = '/settings/credentials.ttl';

const POD_URL = 'http://localhost:3000/alice/';
const PROVIDER_RESOURCE = `${POD_URL}settings/ai/providers.ttl`;
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

  describe('UDFS_NS', () => {
    it('should match the namespace used by drizzle-solid schemas', () => {
      expect(UDFS_NS).toBe('https://undefineds.co/ns#');
    });
  });

  describe('buildProviderSparql', () => {
    it('should target the correct subject URI matching Provider schema subjectTemplate', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      // Subject must be {base}#{id} — matches podTable subjectTemplate: '#{id}'
      expect(sparql).toContain(`<${PROVIDER_RESOURCE}#openai>`);
    });

    it('should use udfs:Provider type matching Provider schema type', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('a udfs:Provider');
    });

    it('should write udfs:baseUrl matching Provider schema field', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('udfs:baseUrl');
      expect(sparql).toContain(PROVIDER_BASE_URLS.openai);
    });

    it('should write udfs:displayName matching Provider schema field', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('udfs:displayName "Openai"');
    });

    it('should use correct PREFIX', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toMatch(/^PREFIX udfs: <https:\/\/undefineds\.co\/ns#>/);
    });

    it('should handle unknown provider without baseUrl', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'custom-provider');
      expect(sparql).toContain(`<${PROVIDER_RESOURCE}#custom-provider>`);
      expect(sparql).toContain('a udfs:Provider');
      expect(sparql).toContain('udfs:displayName "Custom-provider"');
      // No baseUrl for unknown provider
      expect(sparql).not.toMatch(/udfs:baseUrl "[^"]+"/);
    });

    it('should include DELETE for old values (upsert pattern)', () => {
      const sparql = buildProviderSparql(PROVIDER_RESOURCE, 'openai');
      expect(sparql).toContain('DELETE');
      expect(sparql).toContain('?oldBase');
      expect(sparql).toContain('?oldName');
      expect(sparql).toContain('OPTIONAL');
    });
  });

  describe('buildCredentialSparql', () => {
    it('should target cred-{provider} subject matching Credential schema subjectTemplate', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      // Subject must be {base}#cred-{provider}
      expect(sparql).toContain(`<${CREDENTIAL_RESOURCE}#cred-openai>`);
    });

    it('should use udfs:Credential type matching Credential schema type', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      expect(sparql).toContain('a udfs:Credential');
    });

    it('should set service=ai and status=active for getAiConfig() query', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      // PodChatKitStore.getAiConfig() queries: eq(Credential.service, 'ai'), eq(Credential.status, 'active')
      expect(sparql).toContain('udfs:service "ai"');
      expect(sparql).toContain('udfs:status "active"');
    });

    it('should link to provider URI matching Provider schema base path', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      // getAiConfig() extracts providerId from cred.provider URI via extractProviderId()
      expect(sparql).toContain(`udfs:provider <${POD_URL}settings/ai/providers.ttl#openai>`);
    });

    it('should write udfs:apiKey matching Credential schema field', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test-key-123' });
      expect(sparql).toContain('udfs:apiKey "sk-test-key-123"');
    });

    it('should write udfs:defaultModel when provided', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test', model: 'gpt-4o' });
      expect(sparql).toContain('udfs:defaultModel "gpt-4o"');
    });

    it('should omit apiKey from SPARQL when not provided', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { model: 'gpt-4o' });
      expect(sparql).not.toContain('udfs:apiKey');
    });

    it('should omit defaultModel from SPARQL when not provided', () => {
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'openai', { apiKey: 'sk-test' });
      expect(sparql).not.toContain('udfs:defaultModel');
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
      expect(sparql).toContain(`<${POD_URL}settings/ai/providers.ttl#anthropic>`);
      expect(sparql).toContain('udfs:apiKey "sk-ant-xxx"');
      expect(sparql).toContain('udfs:defaultModel "claude-sonnet-4-20250514"');
      expect(sparql).toContain('udfs:service "ai"');
      expect(sparql).toContain('udfs:status "active"');
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
      // Provider schema: base: '/settings/ai/providers.ttl'
      expect(PROVIDER_RESOURCE).toContain(PROVIDER_BASE_PATH);
    });

    it('Credential resource path should match Credential schema base', () => {
      // Credential schema: base: '/settings/credentials.ttl'
      expect(CREDENTIAL_RESOURCE).toContain(CREDENTIAL_BASE_PATH);
    });

    it('provider URI in credential should be extractable by PodChatKitStore.extractProviderId', () => {
      // PodChatKitStore.extractProviderId does: uri.lastIndexOf('#') then slice
      const sparql = buildCredentialSparql(CREDENTIAL_RESOURCE, POD_URL, 'google', { apiKey: 'key' });
      const providerUriMatch = sparql.match(/udfs:provider <([^>]+)>/);
      expect(providerUriMatch).not.toBeNull();

      const providerUri = providerUriMatch![1];
      const hash = providerUri.lastIndexOf('#');
      const extractedId = providerUri.slice(hash + 1);
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
