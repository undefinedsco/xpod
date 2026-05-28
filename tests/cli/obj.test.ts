import { credentialDescriptor } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import {
  buildDescriptorDeleteSparql,
  buildDescriptorLinkSparql,
  buildDescriptorObjectQuery,
  buildDescriptorPatchSparql,
  buildDescriptorUpsertSparql,
  extractReservedWhereSelectors,
  redactDescriptorObject,
} from '../../src/cli/commands/obj';

describe('obj command helpers', () => {
  it('redacts descriptor fields marked secret', () => {
    expect(redactDescriptorObject(credentialDescriptor, {
      service: 'ai',
      providerId: 'openai',
      apiKey: 'sk-secret',
    })).toEqual({
      service: 'ai',
      providerId: 'openai',
      apiKey: '[redacted]',
    });
  });

  it('builds descriptor-backed upsert SPARQL without private predicates', () => {
    const sparql = buildDescriptorUpsertSparql(
      credentialDescriptor,
      'https://pod.example/alice/settings/credentials.ttl#ai-openai-api-key',
      {
        schema: credentialDescriptor.uri,
        match: {
          service: 'ai',
          providerId: 'openai',
          secretType: 'api-key',
        },
        set: {
          label: 'OpenAI',
          apiKey: 'sk-secret',
          status: 'active',
        },
      },
    );

    expect(sparql).toContain(`<${credentialDescriptor.class}>`);
    expect(sparql).toContain('<https://vocab.xpod.dev/credential#provider> "openai"');
    expect(sparql).toContain('<https://vocab.xpod.dev/credential#apiKey> "sk-secret"');
    expect(sparql).not.toContain('udfs:');
  });

  it('builds descriptor-backed patch SPARQL only for writable descriptor fields', () => {
    const sparql = buildDescriptorPatchSparql(
      credentialDescriptor,
      'https://pod.example/alice/settings/credentials.ttl#ai-openai-api-key',
      { label: 'OpenAI', status: 'active' },
    );

    expect(sparql).toContain('?old_label');
    expect(sparql).toContain('<https://vocab.xpod.dev/credential#label> "OpenAI"');
    expect(sparql).toContain('<https://vocab.xpod.dev/credential#status> "active"');
  });

  it('builds descriptor-backed relation and delete SPARQL without inventing semantics', () => {
    expect(buildDescriptorLinkSparql(
      'https://pod.example/alice/settings/credentials.ttl#cred',
      'https://example.com/rel',
      'https://pod.example/alice/target#x',
    )).toContain('<https://example.com/rel> <https://pod.example/alice/target#x>');

    expect(buildDescriptorDeleteSparql('https://pod.example/alice/settings/credentials.ttl#cred'))
      .toContain('<https://pod.example/alice/settings/credentials.ttl#cred> ?p ?o');
  });

  it('builds object list queries from descriptor fields and filters', () => {
    const query = buildDescriptorObjectQuery({
      descriptor: credentialDescriptor,
      where: { status: 'active' },
      relations: {},
      limit: 25,
      includeMetadata: true,
    });

    expect(query).toContain(`?subject a <${credentialDescriptor.class}>`);
    expect(query).toContain('<https://vocab.xpod.dev/credential#status> "active"');
    expect(query).toContain('LIMIT 25');
  });

  it('keeps reserved selector fields out of descriptor field filters', () => {
    expect(extractReservedWhereSelectors({
      subject: 'settings/credentials.ttl#cred',
      resource: 'settings/credentials.ttl',
      status: 'active',
    })).toEqual({
      subject: 'settings/credentials.ttl#cred',
      resource: 'settings/credentials.ttl',
      where: { status: 'active' },
    });
  });

  it('rejects non-string reserved selector fields', () => {
    expect(() => extractReservedWhereSelectors({ subject: 123 }))
      .toThrow('Reserved selector field "subject" must be a string.');
  });
});
