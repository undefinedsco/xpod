import { drizzle } from '@undefineds.co/drizzle-solid';
import { messageResource, MessageRole, MessageStatus } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { Store } from 'n3';
import { describe, expect, it } from 'vitest';

const podUrl = 'https://pod.example/alice/';
const at = '2026-10-03T00:00:00.000Z';
function insertion(createdAt: string) {
  const db = drizzle({ info: { isLoggedIn: true, webId: `${podUrl}profile/card#me`, podUrl },
    fetch: async() => { throw new Error('Compilation must not perform HTTP'); },
  } as never, { disableInteropDiscovery: true });
  return db.insert(messageResource).values({
    id: 'chat/datetime/2026/10/03/messages.ttl#one', parent: `${podUrl}.data/chat/datetime/index.ttl#this`,
    role: MessageRole.USER, status: MessageStatus.SENT, content: 'date example', createdAt, updatedAt: createdAt,
  }).toSPARQL().query;
}

describe('public SPARQL datetime insertion', () => {
  it.each([at, '2026-10-03T08:00:00+08:00'])('persists %s datetime columns as normalized RDF dateTime terms', async input => {
    const graph = new Store();
    await new QueryEngine().queryVoid(insertion(input), { sources: [graph], destination: graph });
    for (const predicate of ['http://purl.org/dc/terms/created', 'http://purl.org/dc/terms/modified']) {
      const terms = graph.getQuads(null, predicate, null, null).map(quad => quad.object);
      expect(terms).toHaveLength(1);
      expect(terms[0].termType).toBe('Literal');
      expect((terms[0] as { datatype: { value: string } }).datatype.value)
        .toBe('http://www.w3.org/2001/XMLSchema#dateTime');
      expect(terms[0].value).toBe(at);
    }
  });

  it('rejects invalid datetime input before generating a write', () => {
    expect(() => insertion('not-a-date')).toThrow();
  });
});
