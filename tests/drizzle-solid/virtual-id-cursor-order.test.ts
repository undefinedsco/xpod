import { alias, and, asc, desc, drizzle, eq, gt, lt, or } from '@undefineds.co/drizzle-solid';
import { messageResource } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { Parser, Store } from 'n3';
import { describe, expect, it } from 'vitest';

const podUrl = 'https://pod.example/alice/';
const document = `${podUrl}.data/chat/team/2026/10/03/messages.ttl`;
const at = new Date('2026-10-03T00:00:00.000Z');
const subjects = Array.from({ length: 20 }, (_, index) => `${document}#msg-${String(index).padStart(2, '0')}`);

describe('public virtual-ID cursor ordering over RDF', () => {
  it.each([0, 1, 3, 7, 10, 647, 648, 651, 999])('compares adjacent exact milliseconds %s without collapsing cursor boundaries', async milliseconds => {
    const left = new Date(new Date('2026-10-02T19:49:07.000Z').getTime() + milliseconds).toISOString();
    const right = new Date(new Date(left).getTime() + 1).toISOString();
    const engine = new QueryEngine();
    const literal = (value: string): string => `"${value}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
    expect(await engine.queryBoolean(`ASK { FILTER(${literal(left)} < ${literal(right)} &&
      ${literal(right)} > ${literal(left)} && !(${literal(left)} = ${literal(right)})) }`)).toBe(true);
  });

  it.each([
    ['00.13999999999999999', '00.139'],
    ['00.0009999999999999998', '00.000'],
    ['07.6486', '07.648'],
    ['59.9996', '59.999'],
  ])('retains existing submillisecond truncation for %s', async(seconds, truncated) => {
    const engine = new QueryEngine();
    expect(await engine.queryBoolean(`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      ASK { FILTER("2026-10-02T19:49:${seconds}Z"^^xsd:dateTime =
        "2026-10-02T19:49:${truncated}Z"^^xsd:dateTime) }`)).toBe(true);
  });

  it('preserves the instant when an adjacent datetime uses a timezone offset', async() => {
    const engine = new QueryEngine();
    expect(await engine.queryBoolean(`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      ASK { FILTER("2026-10-03T03:49:07.648+08:00"^^xsd:dateTime = "2026-10-02T19:49:07.648Z"^^xsd:dateTime &&
        "2026-10-03T03:49:07.647+08:00"^^xsd:dateTime < "2026-10-02T19:49:07.648Z"^^xsd:dateTime) }`)).toBe(true);
  });
  it.each([1, 7, 20])('reads every tied resource exactly once with limit %s', async limit => {
    await verifyPages(limit, false);
  });

  it('uses the same identity ordering for descending pages on a scoped alias', async() => {
    await verifyPages(7, true);
  });

  it('preserves descending identity ties across ascending datetime groups', async() => {
    await verifyPages(3, true, true);
  });

  it.each([1, 7, 20])('keeps millisecond datetime groups ahead of reverse identity ties with limit %s', async limit => {
    await verifyPages(limit, true, true, 1, new Date('2026-10-02T19:49:07.647Z'));
  });

  it('finds the latest exact key and paginates backwards across millisecond groups', async() => {
    await verifyPages(3, true, true, 1, new Date('2026-10-02T19:49:07.647Z'), false);
  });
});

async function verifyPages(limit: number, descending: boolean, mixed = false, dateStep = 1_000, origin = at, ascendingGroups = true): Promise<void> {
  const db = drizzle({ info: { isLoggedIn: true, webId: `${podUrl}profile/card#me`, podUrl },
    fetch: async() => { throw new Error('Compilation must not perform HTTP'); },
  } as never, { disableInteropDiscovery: true });
  const table = alias(messageResource, 'cursor_messages').$schema.table('cursor_messages', {
    base: document, resourceMode: 'sparql', sparqlEndpoint: `${document}/-/sparql`, autoRegister: false,
  });
  const graph = new Store();
  // Insertion order differs from IRI order, so an unbound identity sort cannot accidentally pass.
  for (const index of [0, 19, 8, 2, 17, 4, 15, 6, 13, 10, 11, 12, 7, 14, 5, 16, 3, 18, 1, 9]) {
    const createdAt = new Date(origin.getTime() + (mixed ? Math.floor(index / 5) * dateStep : 0));
    const turtle = `<${subjects[index]}> a <${messageResource.getType()}>;
      <http://rdfs.org/sioc/ns#has_parent> <${podUrl}.data/chat/team/index.ttl#this>;
      <https://undefineds.co/ns#messageType> "user";
      <http://rdfs.org/sioc/ns#content> "message-${index}";
      <https://undefineds.co/ns#messageStatus> "sent";
      <http://purl.org/dc/terms/created> "${createdAt.toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>.`;
    // A document endpoint exposes its document as the default graph.
    graph.addQuads(new Parser().parse(turtle));
  }
  const engine = new QueryEngine();
  const compare = descending ? lt : gt;
  const order = descending ? desc : asc;
  const compareDate = mixed && ascendingGroups ? gt : compare;
  const orderDate = mixed && ascendingGroups ? asc : order;
  const observed: string[] = [];
  let last: string | undefined;
  let lastDate = origin;
  for (let page = 0; page <= subjects.length; page++) {
    const query = db.select().from(table);
    if (last) query.whereCursor(or(compareDate(table.createdAt, lastDate), and(eq(table.createdAt, lastDate), compare(table.id, last))));
    const sparql = query.orderBy(orderDate('createdAt'), order('id')).limit(limit).toSparql().query;
    expect(sparql).not.toMatch(/ORDER BY[^\n]*\?id\b/);
    const bindings = await (await engine.queryBindings(sparql, { sources: [graph] })).toArray();
    expect(bindings.length).toBeLessThanOrEqual(limit);
    if (!bindings.length) break;
    const iris = bindings.map(binding => binding.get('subject')!.value);
    observed.push(...iris);
    last = iris[iris.length - 1];
    lastDate = new Date(bindings[bindings.length - 1].get('createdAt')!.value);
  }
  const groups = Array.from({ length: 4 }, (_, group) => subjects.slice(group * 5, (group + 1) * 5).reverse());
  const expected = mixed
    ? (ascendingGroups ? groups : groups.reverse()).flat()
    : descending ? [...subjects].reverse() : subjects;
  expect(observed).toEqual(expected);
  expect(new Set(observed).size).toBe(subjects.length);
}
