import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import '../../src/runtime/configure-drizzle-solid';
import { drizzle, type SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { sessionResource } from '@undefineds.co/models';

const cjsDrizzle = (createRequire(import.meta.url)('@undefineds.co/drizzle-solid') as { drizzle: typeof drizzle }).drizzle;

describe.each([['ESM', drizzle], ['CJS', cjsDrizzle]] as const)('shared Session collection inline document source (%s)', (_format, createDatabase) => {
  it.each(['', '#session'])('reads the concrete date document rather than the collection root (%s)', async fragment => {
    const podUrl = 'https://storage.example/alice/';
    const webId = 'https://identity.example/alice/card#me';
    const document = `${podUrl}.data/sessions/2026/10/04/session-one.ttl`;
    const subject = `${document}${fragment}`;
    const requests: string[] = [];
    const wire: typeof fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${url.origin}${url.pathname}`);
      if (url.pathname.endsWith('/-/sparql')) return Response.json({ head: { vars: ['subject', 'owner', 'thread', 'status'] },
        results: { bindings: [{ subject: { type: 'uri', value: subject }, owner: { type: 'uri', value: webId },
          thread: { type: 'uri', value: `${podUrl}.data/thread/index.ttl#thread` }, status: { type: 'literal', value: 'completed' } }] } });
      if (`${url.origin}${url.pathname}` === document) return new Response(`<${subject}> a <${sessionResource.config.type}> .`, {
        headers: { 'content-type': 'text/turtle' },
      });
      return new Response('', { status: 404 });
    };
    const db = createDatabase({ fetch: wire, info: { webId, isLoggedIn: true } } as SolidAuthSession, {
      podUrl, schema: { session: sessionResource }, autoConnect: false, resourcePreparation: 'off',
    });
    const rows = await db.select().from(sessionResource).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe(webId);
    expect(rows[0].status).toBe('completed');
    expect(sessionResource.buildIriForDatabase(db, rows[0])).toBe(subject);
    expect(requests).toEqual([`${podUrl}.data/sessions/-/sparql`, document]);
  });
});
