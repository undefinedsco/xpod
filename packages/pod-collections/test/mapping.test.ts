import { describe, expect, it } from 'vitest';
import { drizzle, podTable, id, uri, string } from '@undefineds.co/drizzle-solid';
import { aiProviderResource, credentialDescriptor, credentialResource } from '@undefineds.co/models';
// Exercise the installed ORM's real RDF boundary; its public entry omits handlers.
import { UriHandler } from '../../../node_modules/@undefineds.co/drizzle-solid/dist/core/triple/handlers/uri.js';
import { projectionCovers, projectionHash } from '../src/diff.js';
import { createPendingWrites, reconcilePendingWrites } from '../src/mutations.js';
import {
  assertDescriptorTableAlignment,
  coerceFieldValue,
  descriptorFieldsWithoutColumn,
  descriptorRowToColumnValues,
  fieldBindings,
  isUriArrayField,
  mapSubjectRows,
  normalizeMutationRow,
  projectionFieldOrder,
  tableColumnPredicates,
  tableColumnsWithoutDescriptorField,
  uriArrayFields,
  valueToTerm,
  valuesToTerms,
} from '../src/mapping.js';
import { createWidgetTable, widgetDescriptor } from './helpers/harness.js';
import type { WidgetRow } from './helpers/harness.js';
import { PodCollectionError } from '../src/types.js';

/**
 * §2.4 的 RDF ↔ 行映射：字段→列按谓词、类型只按 descriptor 声明、datatype 与
 * drizzle-solid 的 SPARQL helper 一致；往返（值 → term → 值）不丢类型。
 */

const POD_URL = 'https://pod.test/alice/';
const NS = 'https://example.test/ns#';

const typeAssert = <T>(value: T): T => value;

describe('descriptor ↔ table column binding (§2.4)', () => {
  it('binds fields to columns by predicate, not by field name', () => {
    const bindings = fieldBindings(widgetDescriptor, createWidgetTable());
    expect(bindings.get('providerId')?.column).toBe('provider');
    expect(bindings.get('label')?.column).toBe('label');
    expect(bindings.get('secretType')?.column).toBeUndefined();
    expect(descriptorFieldsWithoutColumn(widgetDescriptor, createWidgetTable())).toEqual(['secretType']);
    expect(tableColumnPredicates(createWidgetTable()).get('hasModel')).toBe(`${NS}hasModel`);
  });

  it('reports table columns the descriptor does not declare', () => {
    const table = createWidgetTable();
    expect(tableColumnsWithoutDescriptorField(widgetDescriptor, table)).toEqual([]);
    expect(projectionFieldOrder(widgetDescriptor)).toContain('hasModel');
    // 顺序按谓词，不按声明顺序：`#hasModel` < `#home`，而声明顺序与之相反。
    const order = projectionFieldOrder(widgetDescriptor);
    const declared = Object.keys(widgetDescriptor.fields);
    expect(order.indexOf('hasModel')).toBeLessThan(order.indexOf('home'));
    expect(declared.indexOf('home')).toBeLessThan(declared.indexOf('hasModel'));
  });

  it('refuses a table whose rdf class differs from the descriptor class', () => {
    const table = createWidgetTable();
    const foreign = {
      ...(table as unknown as Record<string, unknown>),
      getType: () => `${NS}Other`,
    } as never;
    expect(() => assertDescriptorTableAlignment(widgetDescriptor, foreign))
      .toThrowError(PodCollectionError);
  });

  it('flags the array+uri field that must bypass the ORM', () => {
    expect(uriArrayFields(widgetDescriptor)).toEqual(['hasModel']);
    expect(isUriArrayField(widgetDescriptor.fields.hasModel)).toBe(true);
    expect(isUriArrayField(widgetDescriptor.fields.scopes)).toBe(false);
  });
});

describe('subject rows → collection rows', () => {
  const subjects = [
    {
      id: 'widgets.ttl#w1',
      '@id': `${POD_URL}settings/widgets.ttl#w1`,
      label: 'First',
      provider: `${NS}openai`,
      apiKey: 'sk-secret',
      scopes: 'models.read',
      expiresAt: '2027-01-01T00:00:00.000Z',
      enabled: true,
      priority: 3,
      metadata: '{"priority":7}',
      home: 'https://example.test/home',
      hasModel: [`${POD_URL}settings/models/a.ttl#a`],
    },
  ];

  it('projects descriptor fields, drops secrets and keeps arrays/typed values', () => {
    const rows = mapSubjectRows(widgetDescriptor, createWidgetTable(), subjects);
    expect(rows).toHaveLength(1);
    const row = rows[0] as WidgetRow;
    expect(row.id).toBe('w1');
    expect(row['@id']).toBe(`${POD_URL}settings/widgets.ttl#w1`);
    expect(row.label).toBe('First');
    expect(row.providerId).toBe(`${NS}openai`);
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect(row.enabled).toBe(true);
    expect(row.priority).toBe(3);
    // 单个值也按 array 字段归一成数组（§2.4：每元素一条三元组）。
    expect(row.scopes).toEqual(['models.read']);
    // `secret: true` 与「表里没有该列」的字段都不出现在行里。
    expect('apiKey' in row).toBe(false);
    expect('secretType' in row).toBe(false);
    // `string` 字段的值即使是 URL 也保持字符串（§2.4 边界 1：不靠 term 反推类型）。
    expect(typeof row.home).toBe('string');
    // json 的序列化细节属于 drizzle-solid：非 term 输入原样透传。
    expect(row.metadata).toBe('{"priority":7}');
  });

  it('skips subjects without a resource id', () => {
    const rows = mapSubjectRows(widgetDescriptor, createWidgetTable(), [{ label: 'no id' }]);
    expect(rows).toEqual([]);
  });
});

describe('value ↔ RDF term (§2.4)', () => {
  const fields = widgetDescriptor.fields;

  it('uses the datatypes drizzle-solid uses', () => {
    expect(valueToTerm(fields.priority, 7)).toEqual({
      termType: 'Literal',
      value: '7',
      datatype: 'http://www.w3.org/2001/XMLSchema#integer',
    });
    expect(valueToTerm(fields.priority, 7.5)).toMatchObject({
      datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
    });
    expect(valueToTerm(fields.enabled, false)).toEqual({
      termType: 'Literal',
      value: 'false',
      datatype: 'http://www.w3.org/2001/XMLSchema#boolean',
    });
    expect(valueToTerm(fields.expiresAt, new Date('2027-01-01T00:00:00.000Z'))).toEqual({
      termType: 'Literal',
      value: '2027-01-01T00:00:00.000Z',
      datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
    });
    expect(valueToTerm(fields.home, 'https://example.test/home')).toEqual({
      termType: 'NamedNode',
      value: 'https://example.test/home',
    });
    expect(valueToTerm(fields.label, 'plain')).toEqual({ termType: 'Literal', value: 'plain' });
    // §2.4 边界 1：`string` 字段以 http(s):// 开头时写成 named node。
    expect(valueToTerm(fields.label, 'https://example.test/thing')?.termType).toBe('NamedNode');
    expect(valueToTerm(fields.metadata, { priority: 7 })).toEqual({
      termType: 'Literal',
      value: '{"priority":7}',
    });
  });

  it('round-trips values through terms', () => {
    const roundTrip = (field: Parameters<typeof valueToTerm>[0], value: unknown): unknown =>
      coerceFieldValue(field, valueToTerm(field, value));
    expect(roundTrip(fields.priority, 7)).toBe(7);
    expect(roundTrip(fields.priority, 7.5)).toBe(7.5);
    expect(roundTrip(fields.enabled, true)).toBe(true);
    expect(roundTrip(fields.label, 'plain')).toBe('plain');
    expect(roundTrip(fields.home, 'https://example.test/home')).toBe('https://example.test/home');
    expect(roundTrip(fields.metadata, { priority: 7 })).toEqual({ priority: 7 });
    const date = new Date('2027-01-01T00:00:00.000Z');
    expect(roundTrip(fields.expiresAt, date)).toEqual(date);
    expect(valuesToTerms(fields.hasModel, [`${POD_URL}a`, `${POD_URL}b`]).map((term) => term.value))
      .toEqual([`${POD_URL}a`, `${POD_URL}b`]);
  });

  it('coerces ORM-decoded values by descriptor declaration only', () => {
    expect(coerceFieldValue(fields.expiresAt, '2027-01-01T00:00:00.000Z')).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
    expect(coerceFieldValue(fields.priority, '3')).toBe(3);
    expect(coerceFieldValue(fields.enabled, 'true')).toBe(true);
    expect(coerceFieldValue(fields.scopes, 'single')).toEqual(['single']);
    expect(coerceFieldValue(fields.scopes, ['a', undefined, 'b'])).toEqual(['a', 'b']);
    expect(coerceFieldValue(fields.label, '')).toBeUndefined();
    // 空值不产生字段值（null/undefined/空串）。
    expect(coerceFieldValue(fields.label, undefined)).toBeUndefined();
  });
});

describe('write payload', () => {
  it('maps descriptor fields to drizzle column values and always carries the row id', () => {
    const values = descriptorRowToColumnValues(
      widgetDescriptor,
      createWidgetTable(),
      typeAssert<Record<string, unknown>>({ id: 'w1', label: 'x', providerId: `${NS}openai`, secretType: 'api-key' }),
      { resourceId: 'widgets.ttl#w1' },
    );
    expect(values).toEqual({
      id: 'widgets.ttl#w1',
      label: 'x',
      provider: `${NS}openai`,
    });
  });

  it('can exclude the array+uri field that goes through the PATCH bypass', () => {
    const values = descriptorRowToColumnValues(
      widgetDescriptor,
      createWidgetTable(),
      { id: 'w1', label: 'x', hasModel: [`${POD_URL}a`] },
      { resourceId: 'widgets.ttl#w1', includeField: (field) => field !== 'hasModel' },
    );
    expect(values).toEqual({ id: 'widgets.ttl#w1', label: 'x' });
  });
});

describe('credential URI confirmation through installed ORM RDF roundtrip', () => {
  const intent = {
    id: 'credential-roundtrip',
    provider: aiProviderResource.buildId({ id: 'openai' }),
    label: 'Roundtrip fixture',
  };
  const database = drizzle({
    info: { isLoggedIn: true, webId: `${POD_URL}profile/card#me` },
    fetch: async () => { throw new Error('roundtrip must not perform network I/O'); },
  }, { podUrl: POD_URL, schema: { credential: credentialResource, aiProvider: aiProviderResource } });
  const roundtrip = () => {
    const column = credentialResource.columns.provider;
    const handler = new UriHandler();
    const resolver = database.getDialect().getUriResolver();
    const term = handler.formatValue(intent.provider, column, {
      resolveInlineChildUri: (...args) => resolver.resolveInlineChild(...args),
      getNamespaceUri: () => credentialDescriptor.namespace,
      baseUri: POD_URL,
      currentTable: credentialResource,
      tableNameRegistry: new Map([['aiProvider', aiProviderResource]]),
      uriResolver: resolver,
    });
    expect(term.termType).toBe('NamedNode');
    const values = descriptorRowToColumnValues(credentialDescriptor, credentialResource, intent, {
      resourceId: credentialResource.buildId({ id: intent.id }),
    });
    const [server] = mapSubjectRows(credentialDescriptor, credentialResource, [{
      ...values,
      provider: handler.parseValue(term, column),
    }]);
    expect(server).toBeDefined();
    return { server: server!, normalized: normalizeMutationRow(credentialDescriptor, credentialResource, intent, {
      database, podUrl: POD_URL, document: `${POD_URL}settings/credentials.ttl`, resourceId: credentialResource.buildId({ id: intent.id }),
    }) };
  };

  it('confirms the real credential provider relation after URI write/read normalization', () => {
    const { server, normalized } = roundtrip();
    // Failure output contains field names/types only, never row values or secrets.
    const differences = Object.entries(normalized)
      .filter(([field, value]) => server[field as keyof typeof intent] !== value)
      .map(([field, value]) => ({ field, intentType: typeof value, readType: typeof server[field as keyof typeof intent] }));
    expect(differences).toEqual([]);
    expect(projectionCovers(server, normalized)).toBe(true);
  });

  it('preserves absolute external IRIs and non-URI fields', () => {
    const row = { id: 'external', provider: 'https://other.test/providers/custom#this', baseUrl: 'https://api.test/v1', label: 'unchanged' };
    expect(normalizeMutationRow(credentialDescriptor, credentialResource, row, {
      database, podUrl: POD_URL, document: `${POD_URL}settings/credentials.ttl`, resourceId: 'credentials.ttl#external',
    })).toEqual(row);
  });

  it('normalizes URI arrays with the same document base as the PATCH writer', () => {
    const table = podTable('widget', {
      id: id('id'),
      label: string('label').predicate(widgetDescriptor.fields.label.predicate),
      hasModel: uri('hasModel').array().predicate(widgetDescriptor.fields.hasModel.predicate),
    }, { base: '/settings/', type: widgetDescriptor.class });
    const row = { id: 'array', label: 'https://literal.test/value', hasModel: ['models/a.ttl#a', 'https://other.test/model#this'] };
    const normalized = normalizeMutationRow(widgetDescriptor, table, row, {
      database, podUrl: POD_URL, document: `${POD_URL}settings/widgets.ttl`, resourceId: 'widgets.ttl#array',
    });
    expect(normalized.hasModel).toEqual([`${POD_URL}settings/models/a.ttl#a`, 'https://other.test/model#this']);
    expect(normalized.label).toBe(row.label);
  });

  it('preserves absolute URI lexical identity in arrays while resolving only relative entries', () => {
    const table = podTable('widget', {
      id: id('id'),
      hasModel: uri('hasModel').array().predicate(widgetDescriptor.fields.hasModel.predicate),
    }, { base: '/settings/', type: widgetDescriptor.class });
    const external = ['https://external.test', 'https://EXTERNAL.test/model#this', 'https://external.test/a/../model#this'];
    const normalized = normalizeMutationRow(widgetDescriptor, table, { id: 'lexical-array', hasModel: [...external, 'models/c.ttl#c'] }, {
      database, podUrl: POD_URL, document: `${POD_URL}settings/widgets.ttl`, resourceId: 'widgets.ttl#lexical-array',
    });
    expect(normalized.hasModel).toEqual([...external, `${POD_URL}settings/models/c.ttl#c`]);
  });

  it('still rejects a genuinely different provider after normalization', () => {
    const { normalized, server } = roundtrip();
    const foreign = { ...server, provider: `${POD_URL}settings/providers/other.ttl` };
    expect(projectionCovers(foreign, normalized)).toBe(false);
    const pending = createPendingWrites<typeof normalized>();
    pending.register({ key: intent.id, intent: normalized, localRow: normalized, beforeHash: undefined });
    reconcilePendingWrites(pending, new Map([[intent.id, foreign]]),
      row => projectionHash(row, projectionFieldOrder(credentialDescriptor)));
    expect((pending.entries.get(intent.id)?.error as PodCollectionError)?.code).toBe('write_conflict');
  });

  it('settles that same URI roundtrip without a spurious insert conflict', () => {
    const { server, normalized } = roundtrip();
    const pending = createPendingWrites<typeof normalized>();
    pending.register({ key: intent.id, intent: normalized, localRow: normalized, beforeHash: undefined });
    reconcilePendingWrites(pending, new Map([[intent.id, server]]),
      row => projectionHash(row, projectionFieldOrder(credentialDescriptor)));
    const entry = pending.entries.get(intent.id)!;
    expect({ settled: entry.settled, code: entry.error instanceof PodCollectionError ? entry.error.code : undefined })
      .toEqual({ settled: true, code: undefined });
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

/** 类型级断言（由 `bun run typecheck` 的 `tsconfig.test.json` 检查）。 */
type _ExpiresAtIsDate = Expect<Equal<WidgetRow['expiresAt'], Date>>;
type _HasModelIsArray = Expect<Equal<WidgetRow['hasModel'], string[]>>;
type _EnabledIsBoolean = Expect<Equal<WidgetRow['enabled'], boolean>>;
type _PriorityIsNumber = Expect<Equal<WidgetRow['priority'], number>>;
type _LabelIsString = Expect<Equal<WidgetRow['label'], string>>;
type _IdIsString = Expect<Equal<WidgetRow['id'], string>>;

export type { _ExpiresAtIsDate, _HasModelIsArray, _EnabledIsBoolean, _PriorityIsNumber, _LabelIsString, _IdIsString };
