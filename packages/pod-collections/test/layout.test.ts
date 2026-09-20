import { describe, expect, it } from 'vitest';
import { credentialDescriptor } from '@undefineds.co/models';
import type { PodModelDescriptor } from '@undefineds.co/models';
import {
  documentKeyOf,
  documentOfIri,
  resolveTableDocument,
  resourceIdForRow,
  rowBelongsToDocument,
  rowKeyOf,
  rowKeyVariable,
  subjectIriForRow,
} from '../src/layout.js';
import { PodCollectionError } from '../src/types.js';

/**
 * §2.3 的三种 topic 形状 + §2.7 的键取法（键取行标识，不取 `uniqueBy`）。
 */

const POD_URL = 'https://pod.test/alice/';
const NS = 'https://example.test/ns#';

function descriptorWith(
  storage: { base: string; resourceIdPattern: string },
  fields: Record<string, { type: 'string' | 'uri'; predicate: string }> = {
    id: { type: 'string', predicate: `${NS}id` },
  },
): PodModelDescriptor {
  return {
    uri: `${NS}Thing`,
    version: '1.0.0',
    source: 'developer',
    trustLevel: 'low',
    namespace: NS,
    class: `${NS}Thing`,
    resourceKind: 'thing',
    description: 'test',
    storage,
    fields,
    uniqueBy: ['id'],
    writableFields: [],
    mergePolicy: 'upsert',
    examples: [],
  };
}

describe('topic derivation (§2.3)', () => {
  it('derives the document from storage.base when base is a document (shape 1)', () => {
    const document = resolveTableDocument(credentialDescriptor, { podUrl: POD_URL });
    expect(document).toBe(`${POD_URL}settings/credentials.ttl`);
    expect(documentKeyOf(credentialDescriptor, document, POD_URL)).toBe('credentials.ttl');
  });

  it('accepts an explicit document, absolute or relative to podUrl', () => {
    expect(resolveTableDocument(credentialDescriptor, { podUrl: POD_URL, document: 'settings/other.ttl' }))
      .toBe(`${POD_URL}settings/other.ttl`);
    expect(resolveTableDocument(credentialDescriptor, {
      podUrl: POD_URL,
      document: 'https://other.test/x.ttl',
    })).toBe('https://other.test/x.ttl');
  });

  it('names the document from the row key when the pattern is {key}.ttl (shape 2)', () => {
    const provider = descriptorWith({ base: '/settings/providers/', resourceIdPattern: '{key}.ttl' });
    expect(resolveTableDocument(provider, { podUrl: POD_URL, scope: { provider: 'openai' } }))
      .toBe(`${POD_URL}settings/providers/openai.ttl`);
    expect(() => resolveTableDocument(provider, { podUrl: POD_URL }))
      .toThrowError(/pass document or scope/u);
  });

  it('requires an explicit document when the document comes from a template variable (shape 3)', () => {
    const model = descriptorWith({ base: '/settings/providers/', resourceIdPattern: '{isProvidedBy.doc}#{key}' });
    expect(() => resolveTableDocument(model, { podUrl: POD_URL })).toThrowError(PodCollectionError);
    const document = resolveTableDocument(model, {
      podUrl: POD_URL,
      document: `${POD_URL}settings/providers/openai.ttl`,
    });
    expect(document).toBe(`${POD_URL}settings/providers/openai.ttl`);
    // scope 推不出 shape 3 的文档变量：不猜布局。
    expect(() => resolveTableDocument(model, { podUrl: POD_URL, scope: { provider: 'openai' } }))
      .toThrowError(/pass document explicitly/u);
  });

  it('rejects a descriptor without storage layout', () => {
    const broken = { ...descriptorWith({ base: '', resourceIdPattern: '' }) };
    expect(() => resolveTableDocument(broken, { podUrl: POD_URL }))
      .toThrowError(/has no storage/u);
  });
});

describe('row key ↔ IRI (§2.7)', () => {
  it('takes the key from the row identity, not from uniqueBy', () => {
    const descriptor = credentialDescriptor;
    // 0.2.57 起 `uniqueBy` 是真实列 `['id']`（旧值是引用非列的
    // `['service','providerId','secretType']`）。键仍然取 `resourceIdPattern` 的键 slot：
    // 那是**存储布局**的事实，而 `uniqueBy` 是语义唯一键的声明，两者不保证同形
    // （`aiModelDescriptor` 就是 `uniqueBy: ['id']` 但键 slot 叫 `key`）。
    expect(descriptor.uniqueBy).toEqual(['id']);
    // 两条凭据各有各的 id：即使 provider / service 相同也是两个 key。
    const first = rowKeyOf(descriptor, { id: 'credentials.ttl#openai-1' });
    const second = rowKeyOf(descriptor, { id: 'credentials.ttl#openai-2' });
    expect(first).toBe('openai-1');
    expect(second).toBe('openai-2');
    expect(rowKeyVariable(descriptor.storage.resourceIdPattern)).toBe('id');
  });

  it('builds the resource id and subject IRI the ORM uses for exact operations', () => {
    const document = resolveTableDocument(credentialDescriptor, { podUrl: POD_URL });
    expect(resourceIdForRow(credentialDescriptor, document, POD_URL, 'openai-1'))
      .toBe('credentials.ttl#openai-1');
    expect(subjectIriForRow(credentialDescriptor, document, 'openai-1'))
      .toBe(`${POD_URL}settings/credentials.ttl#openai-1`);
  });

  it('handles the per-document shapes', () => {
    const provider = descriptorWith({ base: '/settings/providers/', resourceIdPattern: '{key}.ttl' });
    const document = resolveTableDocument(provider, { podUrl: POD_URL, scope: { provider: 'openai' } });
    expect(rowKeyOf(provider, { id: 'openai.ttl' })).toBe('openai');
    expect(resourceIdForRow(provider, document, POD_URL, 'openai')).toBe('openai.ttl');
    expect(subjectIriForRow(provider, document, 'openai')).toBe(document);

    const model = descriptorWith({ base: '/settings/providers/', resourceIdPattern: '{isProvidedBy.doc}#{key}' });
    expect(rowKeyOf(model, { id: 'openai.ttl#gpt-5' })).toBe('gpt-5');
  });

  it('handles date-bucketed patterns with more than one template variable', () => {
    const bucketed = descriptorWith(
      { base: '/data/', resourceIdPattern: '{yyyy}/{MM}/{dd}.ttl#{id}' },
    );
    expect(rowKeyOf(bucketed, { id: '2026/05/07.ttl#entry-1' })).toBe('entry-1');
    expect(() => resolveTableDocument(bucketed, { podUrl: POD_URL }))
      .toThrowError(/pass document explicitly/u);
  });

  it('scopes rows by document', () => {
    const document = resolveTableDocument(credentialDescriptor, { podUrl: POD_URL });
    expect(rowBelongsToDocument(credentialDescriptor, document, POD_URL, {
      id: 'credentials.ttl#a',
      '@id': `${document}#a`,
    })).toBe(true);
    expect(rowBelongsToDocument(credentialDescriptor, document, POD_URL, {
      id: 'providers/openai.ttl#this',
      '@id': `${POD_URL}settings/providers/openai.ttl#this`,
    })).toBe(false);
    expect(documentOfIri(`${document}#a`)).toBe(document);
  });
});
