import { solidResources } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import {
  buildModelTypeIndexEntries,
  buildProfileTypeIndexInsertData,
  renderModelTypeIndexTurtle,
} from '../../src/provision/model-type-index';
import {
  buildModelSchemaCatalog,
  buildModelSchemaDdlPlan,
  buildModelSchemaMigrationPlan,
  diffModelTypeIndexRegistrations,
  findModelSchemaCatalogEntry,
  parseModelTypeIndexRegistrations,
  parseProfileTypeIndexLinks,
} from '../../src/provision/model-schema-ddl';

describe('schema DDL helpers', () => {
  const podRoot = 'https://pod.example/alice/';
  const webId = 'https://pod.example/alice/profile/card#me';

  it('builds a models-derived schema catalog without xpod-owned schema facts', () => {
    const catalog = buildModelSchemaCatalog(podRoot);
    const credential = findModelSchemaCatalogEntry(catalog, 'credential');

    expect(catalog.packageName).toBe('@undefineds.co/models');
    expect(catalog.entries).toHaveLength(Object.keys(solidResources).length);
    expect(credential).toMatchObject({
      resourceKind: 'credential',
      classUri: 'https://vocab.xpod.dev/credential#Credential',
      schemaStatus: 'descriptor_available',
      containerPath: '/settings/',
    });
    expect(credential?.fields?.some((field) =>
      field.name === 'apiKey' &&
      field.secret === true &&
      field.predicate === 'https://vocab.xpod.dev/credential#apiKey')).toBe(true);
  });

  it('builds public and private schema apply plans from the same model registrations', () => {
    const privatePlan = buildModelSchemaDdlPlan({ podRoot });
    const publicPlan = buildModelSchemaDdlPlan({ podRoot, scope: 'public', scopeSource: 'operator_override' });

    expect(privatePlan.scope).toBe('private');
    expect(privatePlan.scopeSource).toBe('default_private');
    expect(privatePlan.typeIndexUrl).toBe('https://pod.example/alice/settings/privateTypeIndex.ttl');
    expect(publicPlan.scope).toBe('public');
    expect(publicPlan.scopeSource).toBe('operator_override');
    expect(publicPlan.typeIndexUrl).toBe('https://pod.example/alice/settings/publicTypeIndex.ttl');
    expect(publicPlan.typeIndexJsonLd['foaf:name']).toBe('Public Type Index');
    expect(publicPlan.typeIndexJsonLd['@type']).toContain('solid:ListedDocument');
    expect(privatePlan.typeIndexJsonLd['@type']).toContain('solid:UnlistedDocument');
    expect(publicPlan.registrations).toEqual(privatePlan.registrations);
    expect(JSON.stringify(publicPlan.typeIndexJsonLd)).not.toContain('xpod:');
  });

  it('serializes both private and public profile TypeIndex links when requested', () => {
    const sparql = buildProfileTypeIndexInsertData({
      webId,
      podRoot,
      privateTypeIndex: 'https://pod.example/alice/settings/privateTypeIndex.ttl',
      publicTypeIndex: 'https://pod.example/alice/settings/publicTypeIndex.ttl',
    });

    expect(sparql).toContain('<http://www.w3.org/ns/solid/terms#privateTypeIndex>');
    expect(sparql).toContain('<http://www.w3.org/ns/solid/terms#publicTypeIndex>');
    expect(sparql).toContain('<http://www.w3.org/ns/solid/terms#storage>');
  });

  it('parses profile links and TypeIndex registrations for diffing', () => {
    const profileTurtle = `
      @prefix solid: <http://www.w3.org/ns/solid/terms#>.
      <${webId}> solid:privateTypeIndex <https://pod.example/alice/settings/privateTypeIndex.ttl>;
        solid:publicTypeIndex <https://pod.example/alice/settings/publicTypeIndex.ttl>;
        solid:storage <${podRoot}>.
    `;
    const links = parseProfileTypeIndexLinks(profileTurtle, 'https://pod.example/alice/profile/card', webId);
    expect(links).toEqual({
      privateTypeIndex: [ 'https://pod.example/alice/settings/privateTypeIndex.ttl' ],
      publicTypeIndex: [ 'https://pod.example/alice/settings/publicTypeIndex.ttl' ],
      storage: [ podRoot ],
    });

    const expected = buildModelTypeIndexEntries(podRoot);
    const observed = parseModelTypeIndexRegistrations(
      renderModelTypeIndexTurtle(expected),
      'https://pod.example/alice/settings/privateTypeIndex.ttl',
    );
    const diff = diffModelTypeIndexRegistrations(expected, observed);
    expect(diff.ok).toBe(true);
    expect(diff.missing).toHaveLength(0);
    expect(diff.matchingCount).toBe(expected.length);
  });

  it('reports missing registrations without treating extra registrations as destructive work', () => {
    const expected = buildModelTypeIndexEntries(podRoot);
    const diff = diffModelTypeIndexRegistrations(expected, [
      {
        subject: 'https://pod.example/alice/settings/privateTypeIndex.ttl#custom',
        rdfClass: 'https://example.com/ns#Custom',
        instanceContainer: 'https://pod.example/alice/custom/',
      },
    ]);

    expect(diff.ok).toBe(false);
    expect(diff.missing).toHaveLength(expected.length);
    expect(diff.extra).toHaveLength(1);
  });

  it('keeps migrations model-owned when the installed models package has no migration API', () => {
    const plan = buildModelSchemaMigrationPlan(podRoot);

    expect(plan.supported).toBe(false);
    expect(plan.operations).toEqual([]);
    expect(plan.directive).toContain('@undefineds.co/models');
  });
});
