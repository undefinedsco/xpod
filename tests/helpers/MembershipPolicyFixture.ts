import { DataFactory, Writer } from 'n3';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalInviteFixture } from './CanonicalInviteFixture';
import { expectedSourceDigest } from './GuardedPolicyClosureFixture';
import { MembershipLifecycle } from '../../src/api/matrix/membershipLifecycle';
import { CanonicalMembershipSource } from '../../src/api/matrix/canonicalMembershipSource';
import type { MembershipOperation } from '../../src/api/matrix/membershipOperation';
import type { MatrixEventRecord } from '../../src/api/matrix/types';
import type { MembershipRoomObservation, MembershipPolicyObservation,
  MembershipAgentReadProof, MembershipEffectiveReadProof } from '../../src/api/matrix/membershipPolicyObservation';

type CanonicalFixture = Parameters<Parameters<typeof canonicalInviteFixture>[0]>[0];
type Reply = { status: number; body?: string; links?: string; type?: string;
  before?: () => Promise<void> | void; headers?: Record<string, string>; stall?: 'headers' | 'body';
  when?: () => boolean; releaseAfterMs?: number };
const LDP = 'http://www.w3.org/ns/ldp#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const ACP = 'http://www.w3.org/ns/solid/acp#';
export const fixtureNegotiationMedia = 'application/vnd.xpod.authorization-profile-negotiation+json';

/** Runtime narrowing for this synthetic WAC fixture; this never creates or seals evidence. */
export function requireFixtureWacObservation(value: MembershipRoomObservation): MembershipPolicyObservation {
  if ('profile' in value) throw new Error('Root WAC fixture unexpectedly returned an ACP observation');
  return value;
}
export function requireFixtureWacRead(value: MembershipAgentReadProof): MembershipEffectiveReadProof {
  if (value.profile !== 'wac-effective-read-v1') throw new Error('Root WAC fixture unexpectedly returned an ACP Read proof');
  return value;
}

/** Root HTTP policy fixture uses counted headers, not real DPoP/ACL enforcement.
 * Standard policy Turtle is test data, not a shared application schema or grant proof. */
export async function membershipPolicyFixture<T>(run: (f: Awaited<ReturnType<typeof configure>>) => Promise<T>): Promise<T> {
  return await canonicalInviteFixture(async base => await run(await configure(base)));
}

/** Attach real HTTP policy discovery to an existing pending source without resetting it. */
export async function attachMembershipPolicyFixture(f: CanonicalFixture): Promise<Awaited<ReturnType<typeof configure>>> {
  return await configure(f, false);
}

async function turtle(triples: Array<[string, string, string]>): Promise<string> {
  const writer = new Writer();
  for (const [subject, predicate, object] of triples) writer.addQuad(DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate), DataFactory.namedNode(object));
  return await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
}

async function configure(f: CanonicalFixture, seedAdmission = true) {
  if (seedAdmission) {
    await f.reset({ participants: [f.owner], roles: 'empty' });
    const source = new CanonicalMembershipSource({ canonicalSource: f.source, resolver: f.resolver,
      credentials: f.credentials, podAccess: f.podAccess, issuer: f.issuer });
    const lifecycle = new MembershipLifecycle({ source, eventId: () => '$root-policy-admission', now: () => 10 });
    await lifecycle.invite(f.roomId, f.actor, f.ownerContext, async input => {
      const op: Readonly<MembershipOperation> = input.operation;
      const record: MatrixEventRecord = { eventId: op.operationId, roomId: f.roomId, type: 'm.room.member',
        sender: op.actor.webId, stateKey: op.targetWebId, originServerTs: op.event.createdAt, content: { ...op.event.content },
        event: { event_id: op.operationId, room_id: f.roomId, type: 'm.room.member', sender: op.actor.webId,
          state_key: op.targetWebId, origin_server_ts: op.event.createdAt, content: { ...op.event.content } } };
      return record;
    });
  }
  const room = new URL('./', f.documentIri).href;
  // Deliberately non-suffix policy URI: discovery cannot be replaced by `.acl` guessing.
  const roomPolicy = `${f.podUrl}policies/root-membership-policy`;
  const replies = new Map<string, Reply>();
  let guardedPost: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const closedStalls: string[] = [];
  const policyFor = (resource: string): string => `${f.podUrl}policies/${createHash('sha256').update(resource).digest('hex')}`;
  const set = (method: 'GET' | 'HEAD', url: string, reply: Reply): void => { replies.set(`${method} ${url}`, reply); };
  const discover = (resource: string, policy = policyFor(resource)): void => {
    set('HEAD', resource, { status: 200, links: `<${policy}>; rel="acl"` });
    if (!replies.has(`GET ${policy}`)) set('GET', policy, { status: 404 });
  };
  const container = async(resource: string, children: string[]): Promise<void> => {
    discover(resource);
    set('GET', resource, { status: 200, body: await turtle([
      [resource, `${RDF}type`, `${LDP}BasicContainer`],
      ...children.map(child => [resource, `${LDP}contains`, child] as [string, string, string]),
    ]) });
  };
  const historyDocuments: string[] = [];
  const days = ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-09-28', '2026-09-29', '2026-09-30'];
  for (const day of days) {
    const bucket = `${room}${day}/`;
    const document = `${bucket}messages.ttl`;
    historyDocuments.push(document);
    await container(bucket, [document]); discover(document);
    // Any body read is a test failure; the observer needs policy discovery, not messages.
    set('GET', document, { status: 500, body: 'History body must not be read for topology' });
  }
  await container(room, [f.documentIri, ...days.map(day => `${room}${day}/`)]);
  discover(f.documentIri); discover(room, roomPolicy);
  let parent = new URL('../', room).href;
  while (parent.startsWith(f.podUrl)) {
    discover(parent);
    if (parent === f.podUrl) break;
    parent = new URL('../', parent).href;
  }
  const wac = async(): Promise<void> => {
    const node = `${roomPolicy}#owner`;
    set('GET', roomPolicy, { status: 200, body: await turtle([
      [node, `${RDF}type`, `${ACL}Authorization`], [node, `${ACL}agent`, f.owner],
      [node, `${ACL}accessTo`, room], [node, `${ACL}default`, room],
      [node, `${ACL}mode`, `${ACL}Read`], [node, `${ACL}mode`, `${ACL}Write`], [node, `${ACL}mode`, `${ACL}Control`],
    ]) });
  };
  const acp = async(): Promise<void> => {
    const acr = roomPolicy;
    const access = `${roomPolicy}#member`;
    const policy = `${roomPolicy}#owner-policy`;
    const matcher = `${roomPolicy}#owner-matcher`;
    set('GET', roomPolicy, { status: 200, links: `<${ACP}AccessControlResource>; rel="type"`, body: await turtle([
      [acr, `${RDF}type`, `${ACP}AccessControlResource`], [acr, `${ACP}accessControl`, access],
      [acr, `${ACP}memberAccessControl`, access], [access, `${RDF}type`, `${ACP}AccessControl`],
      [access, `${ACP}apply`, policy], [policy, `${RDF}type`, `${ACP}Policy`],
      [policy, `${ACP}allow`, `${ACP}Read`], [policy, `${ACP}allow`, `${ACP}Write`],
      [policy, `${ACP}allow`, `${ACP}Control`], [policy, `${ACP}anyOf`, matcher],
      [matcher, `${RDF}type`, `${ACP}Matcher`], [matcher, `${ACP}agent`, f.owner],
    ]) });
  };
  await wac();
  f.additionalRequest(async(request, response, url) => {
    if (request.method === 'POST' && url === f.endpoint
      && request.headers['content-type']?.split(';')[0] === fixtureNegotiationMedia) {
      // This synthetic WAC transport supports legacy traversal regression. The separate
      // actual CSS fixture proves real capability qualification; this does not certify a
      // custom server or mint a Read proof. The declaration only opens the strict traversal.
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { response.writeHead(400); response.end(); return true; }
      const keys = ['version', 'profile', 'sourceIri', 'expectedSourceDigest', 'targetWebId', 'contextDigest', 'challenge'];
      if (!body || typeof body !== 'object' || Object.keys(body).length !== keys.length
        || keys.some(key => !Object.prototype.hasOwnProperty.call(body, key)) || body.version !== 1
        || body.profile !== 'a2-profile-negotiation-v1' || body.sourceIri !== f.sourceIri
        || typeof body.targetWebId !== 'string' || ![f.actor, f.owner, f.target].includes(body.targetWebId)
        || typeof body.contextDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(body.contextDigest)
        || typeof body.challenge !== 'string' || !/^[a-f0-9]{32}$/u.test(body.challenge)) {
        response.writeHead(400); response.end(); return true;
      }
      if (request.headers['x-root-fixture-principal'] !== f.owner) {
        response.writeHead(403); response.end(); return true;
      }
      const sourceDigest = expectedSourceDigest(f.sourceIri, f.documentIri,
        // Match the complete physical Turtle GET, including fixture default-graph
        // metadata. Hashing only named-graph rows silently omits retained triples.
        f.graph.getQuads(null, null, null, null)
          .filter(quad => quad.graph.termType === 'DefaultGraph' || quad.graph.value === f.documentIri)
          .map(quad => DataFactory.quad(quad.subject, quad.predicate, quad.object)));
      if (body.expectedSourceDigest !== sourceDigest) {
        response.writeHead(409); response.end(); return true;
      }
      response.writeHead(200, { 'Content-Type': 'application/vnd.xpod.authorization-profile+json' });
      response.end(JSON.stringify({ version: 1, profile: 'a2-profile-declaration-v1', guardedPolicyProfile: 'wac-ground-v1',
        requesterWebId: f.owner, targetWebId: body.targetWebId, sourceIri: f.sourceIri,
        sourceDigest, contextDigest: body.contextDigest, challenge: body.challenge }));
      return true;
    }
    if (request.method === 'POST' && url === f.endpoint && guardedPost) {
      await guardedPost(request, response); return true;
    }
    const reply = replies.get(`${request.method} ${url}`);
    if (!reply || (reply.when && !reply.when())) return false;
    await reply.before?.();
    if (reply.stall) {
      // Actual socket lifetime also works with Bun's node:http compatibility layer.
      request.socket.once('close', () => closedStalls.push(url));
      if (reply.releaseAfterMs) {
        const watchdog = setTimeout(() => request.socket.destroy(), reply.releaseAfterMs);
        watchdog.unref(); request.socket.once('close', () => clearTimeout(watchdog));
      }
    }
    if (reply.stall === 'headers') return true;
    response.writeHead(reply.status, { 'Content-Type': reply.type ?? 'text/turtle',
      ...(reply.links ? { Link: reply.links } : {}), ...reply.headers });
    if (reply.stall === 'body') { response.write('<incomplete'); return true; }
    response.end(request.method === 'HEAD' ? '' : (reply.body ?? ''));
    return true;
  });
  if (seedAdmission) f.requests.length = 0;
  return { ...f, room, roomPolicy, historyDocuments, replies, closedStalls, set, discover, container, policyFor, wac, acp,
    onGuardedPost: (handler: typeof guardedPost) => { guardedPost = handler; },
    observationOptions: { canonicalSource: f.source, resolver: f.resolver, credentials: f.credentials,
      podAccess: f.podAccess, issuer: f.issuer } };
}
