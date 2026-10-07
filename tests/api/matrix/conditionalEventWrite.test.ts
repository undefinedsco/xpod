import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource, messageResource, MessageRole, MessageStatus } from '@undefineds.co/models';
import { roomChatIri, roomDirectoryIri, roomSurfaceId } from '../../../src/api/matrix/roomResources';
import { buildConditionalEventWrite } from '../../../src/api/matrix/conditionalEventWrite';

const SCOPE = 'https://pod.example/alice/';
const ROOM_ID = '!room:pod.example';

function makeDb(calls: Array<{ url: string; method?: string; contentType: string | null; body: string }>) {
  const localFetch = async(input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get('content-type'),
      body: String(init?.body ?? ''),
    });
    return new Response(null, { status: 204 });
  };
  return drizzle(
    { fetch: localFetch as unknown as typeof fetch,
      info: { webId: `${SCOPE}profile/card#me`, isLoggedIn: true, podUrl: SCOPE } },
    { podUrl: SCOPE, schema: { chat: chatResource, message: messageResource }, resourcePreparation: 'off' },
  );
}

describe('conditional event insert bridge', () => {
  it('builds one guarded INSERT targeting the candidate day document graph', async() => {
    const calls: Array<{ url: string; method?: string; contentType: string | null; body: string }> = [];
    const db = makeDb(calls);
    const parent = roomChatIri(SCOPE, ROOM_ID);
    const resourceId = messageResource.buildId({
      id: 'event-hash',
      parent: chatResource.buildIri('https://layout.invalid/', { id: roomSurfaceId(ROOM_ID) }),
      createdAt: '2026-10-02T00:00:00.000Z',
    });
    const messageIri = messageResource.buildIri(SCOPE, { id: resourceId });
    const insert = db.insert(messageResource).values({
      id: resourceId,
      parent,
      chat: parent,
      maker: `${SCOPE}profile/card#me`,
      role: MessageRole.USER,
      status: MessageStatus.SENT,
      content: 'hello',
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
      metadata: { '@id': `${messageIri}/metadata`, protocol: 'matrix' },
    }).toSPARQL().query;

    const write = buildConditionalEventWrite({
      insertQuery: insert,
      messageIri,
      chatIri: parent,
      roomDirectory: roomDirectoryIri(SCOPE, ROOM_ID),
      chatType: String(chatResource.config.type),
      messageType: String(messageResource.config.type),
      parentPredicate: String(messageResource.parent.getPredicate(messageResource.config.namespace)),
    });

    expect(write.document).toBe(messageIri.split('#')[0]);
    expect(write.fragment).toBe(`#${messageIri.split('#')[1]}`);
    expect(write.endpoint).toBe(`${roomDirectoryIri(SCOPE, ROOM_ID)}-/sparql`);

    const q = write.query;
    expect(q).toContain(`GRAPH <${write.document}>`);
    expect(q).toContain('INSERT');
    expect(q).toContain('NOT EXISTS');
    expect(q).toContain('?existingGraph');
    expect(q).toContain(String(chatResource.config.type));
    expect(q).toContain(String(messageResource.config.type));
    expect(q).toContain(String(messageResource.parent.getPredicate(messageResource.config.namespace)));
    // The finite inventory must come from the server under its lock, not the client.
    expect(q).not.toContain('VALUES');
  });
});
