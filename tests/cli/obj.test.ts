import { credentialDescriptor, solidResources } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  buildModelTypeIndexEntries,
  buildModelTypeIndexEntriesFromCatalog,
  buildModelTypeIndexInsertData,
  buildModelTypeIndexJsonLdDocument,
  buildProfileTypeIndexInsertData,
  modelPrivateTypeIndexUrl,
  renderModelTypeIndexTurtle,
  resolveModelTypeIndexEntries,
} from '../../src/provision/model-type-index';
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
  const requireFromTest = createRequire(import.meta.url);

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

  it('derives TypeIndex registrations from the models catalog', () => {
    const entries = buildModelTypeIndexEntries('https://pod.example/alice/');

    expect(entries).toHaveLength(Object.keys(solidResources).length);
    expect(entries.some((entry) =>
      entry.rdfClass === 'https://vocab.xpod.dev/credential#Credential' &&
      entry.instanceContainer === 'https://pod.example/alice/settings/')).toBe(true);
    expect(entries.some((entry) =>
      entry.resourceName === 'solidProfileResource' &&
      entry.instanceContainer === 'https://pod.example/alice/profile/')).toBe(true);
    expect(entries.some((entry) =>
      entry.rdfClass === 'http://www.w3.org/ns/pim/meeting#LongChat' &&
      entry.instanceContainer === 'https://pod.example/alice/.data/chat/')).toBe(true);

    const uniqueTargets = new Set(entries.map((entry) => `${entry.rdfClass}\n${entry.instanceContainer}`));
    expect(uniqueTargets.size).toBe(entries.length);
  });

  it('resolves portable JSON-LD catalog registrations against the Pod root', () => {
    const entries = buildModelTypeIndexEntriesFromCatalog('https://pod.example/alice/', {
      modelTypeIndexCatalog: {
        registrations: [
          {
            resourceName: 'widgetResource',
            resourceKind: 'widget',
            'solid:forClass': { '@id': 'https://example.com/ns#Widget' },
            instanceContainerPath: '/widgets/',
            storageBase: '/widgets/',
          },
        ],
      },
    });

    expect(entries).toEqual([
      expect.objectContaining({
        name: 'widget',
        resourceName: 'widgetResource',
        rdfClass: 'https://example.com/ns#Widget',
        containerPath: '/widgets/',
        instanceContainer: 'https://pod.example/alice/widgets/',
      }),
    ]);
  });

  it('renders model TypeIndex Turtle and SPARQL patches without xpod-local schema facts', () => {
    const entries = buildModelTypeIndexEntries('https://pod.example/alice/');
    const turtle = renderModelTypeIndexTurtle(entries);
    const patch = buildModelTypeIndexInsertData('https://pod.example/alice/settings/privateTypeIndex.ttl', entries);
    const jsonLd = buildModelTypeIndexJsonLdDocument('https://pod.example/alice/settings/privateTypeIndex.ttl', entries);
    const profilePatch = buildProfileTypeIndexInsertData({
      webId: 'https://pod.example/alice/profile/card#me',
      podRoot: 'https://pod.example/alice/',
      privateTypeIndex: modelPrivateTypeIndexUrl('https://pod.example/alice/'),
    });

    expect(turtle).toContain('solid:TypeIndex');
    expect(turtle).toContain('<https://vocab.xpod.dev/credential#Credential>');
    expect(turtle).toContain('<https://pod.example/alice/settings/>');
    expect(patch).toContain('INSERT DATA');
    expect(patch).toContain('<https://pod.example/alice/settings/privateTypeIndex.ttl>');
    expect(patch).toContain('<http://www.w3.org/ns/solid/terms#TypeRegistration>');
    expect(jsonLd['@graph']).toContainEqual(expect.objectContaining({
      '@type': 'solid:TypeRegistration',
      'solid:forClass': { '@id': 'https://vocab.xpod.dev/credential#Credential' },
      'solid:instanceContainer': { '@id': 'https://pod.example/alice/settings/' },
    }));
    expect(JSON.stringify(jsonLd)).not.toContain('xpod:');
    expect(profilePatch).toContain('<http://www.w3.org/ns/solid/terms#privateTypeIndex>');
    expect(profilePatch).toContain('<http://www.w3.org/ns/solid/terms#storage>');
  });

  it('prefers a JSON-LD interop catalog over solidResources compatibility fallback', () => {
    const resolution = resolveModelTypeIndexEntries('https://pod.example/alice/');

    try {
      requireFromTest.resolve('@undefineds.co/models/interop');
      expect(resolution.source).toBe('models_interop_catalog');
    } catch {
      expect(resolution.source).toBe('models_solid_resources_compat');
    }
    expect(resolution.entries.length).toBeGreaterThan(0);
  });
});
