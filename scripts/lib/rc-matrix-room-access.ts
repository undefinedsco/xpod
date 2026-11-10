/**
 * RC-only Matrix room sharing precondition.
 *
 * The RC shared-group acceptance must exercise the SAME precondition the LinX
 * product performs before inviting: the room owner grants the invitee
 * Read/Append/Write on the canonical room container AND its future descendants
 * through the access-control mechanism the Pod actually advertises (WAC or
 * ACP/ACR).
 *
 * Resolution reuses the authoritative canon: `chatResource.buildIri` from the
 * owner's canonical storage root plus the shared `matrixRoomSurfaceId` codec
 * (src/api/matrix/MatrixIdentity.ts), then `roomContainerOf`. No layout or
 * `.acl`/`.acr` name is guessed: the control URI is read from the resource's
 * own advertised `Link rel="acl"` and used verbatim.
 *
 * This module is release-gate support, never a product runtime path. See
 * docs/issues/2026-10-05-missing-target-acr-permission-broker.md for the known
 * ORM gap (no drizzle-solid ACL writer) that makes this helper necessary.
 */
import {
  addUrl,
  buildThing,
  createAclFromFallbackAcl,
  createThing,
  getResourceAcl,
  getSolidDataset,
  getSolidDatasetWithAcl,
  getThingAll,
  getUrlAll,
  hasFallbackAcl,
  hasResourceAcl,
  saveAclFor,
  saveSolidDatasetAt,
  setAgentDefaultAccess,
  setAgentResourceAccess,
  setThing,
  solidDatasetAsTurtle,
} from '@inrupt/solid-client';
import { createHash } from 'node:crypto';
import { chatResource } from '@undefineds.co/models';
import { canonicalStorageRoot, roomContainerOf } from '../../src/api/matrix/MatrixRoomDirectory';
import { matrixRoomSurfaceId } from '../../src/api/matrix/MatrixIdentity';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ACP = 'http://www.w3.org/ns/solid/acp#';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const ACP_ACCESS_CONTROL_RESOURCE = `${ACP}AccessControlResource`;
const ACP_RESOURCE = `${ACP}resource`;
const ACP_ACCESS_CONTROL_LINK = `${ACP}accessControl`;
const ACP_MEMBER_ACCESS_CONTROL = `${ACP}memberAccessControl`;
const ACP_ACCESS_CONTROL = `${ACP}AccessControl`;
const ACP_APPLY = `${ACP}apply`;
const ACP_POLICY = `${ACP}Policy`;
const ACP_ALLOW = `${ACP}allow`;
const ACP_ANY_OF = `${ACP}anyOf`;
const ACP_MATCHER = `${ACP}Matcher`;
const ACP_AGENT = `${ACP}agent`;

/** Default bound when the caller does not pass the existing RC timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Fixed, reviewable failure classes. Never include response bodies or headers. */
export type RoomAccessErrorClass =
  | 'room-container-invalid'
  | 'container-unreachable'
  | 'control-undiscoverable'
  | 'control-not-own-resource'
  | 'control-unsafe-uri'
  | 'control-mechanism-unknown'
  | 'control-concurrent-modification'
  | 'grant-failed';

export class RoomAccessError extends Error {
  public constructor(public readonly errorClass: RoomAccessErrorClass) {
    super(errorClass);
    this.name = 'RoomAccessError';
  }
}

/**
 * Canonical room container for a room id on the owner's storage root.
 *
 * Both the chat IRI and the container come from the shared models/ORM canon;
 * nothing about the Pod layout is re-derived here.
 */
export function matrixRoomContainerUri(roomId: string, storageRoot: string): string {
  const storage = canonicalStorageRoot(storageRoot);
  if (!storage) throw new RoomAccessError('room-container-invalid');
  if (typeof roomId !== 'string' || !roomId.trim()) throw new RoomAccessError('room-container-invalid');
  const chatIri = chatResource.buildIri(storage, { id: matrixRoomSurfaceId(roomId) });
  const container = roomContainerOf(chatIri);
  const parsed = new URL(container);
  const root = new URL(storage);
  if (parsed.origin !== root.origin) throw new RoomAccessError('room-container-invalid');
  if (!parsed.pathname.startsWith(root.pathname)) throw new RoomAccessError('room-container-invalid');
  // A Pod root itself is never a room container.
  if (parsed.pathname === root.pathname) throw new RoomAccessError('room-container-invalid');
  if (!parsed.pathname.endsWith('/')) throw new RoomAccessError('room-container-invalid');
  return container;
}

export interface RoomAccessGrantInput {
  /** Matrix room id; the container is re-derived from the canonical path. */
  readonly roomId: string;
  /** Canonical room container from {@link matrixRoomContainerUri}. */
  readonly roomContainerUri: string;
  /** Owner storage root; the container must live under it. */
  readonly storageRoot: string;
  /** Alice's own DPoP-authenticated fetch. Never a service or owner-key fallback. */
  readonly authFetch: typeof fetch;
  /** Invitee WebIDs. */
  readonly participants: readonly string[];
  /** Owner WebID, retained as Control and never granted to invitees. */
  readonly ownerWebId: string;
  /** Existing RC timeout. Omitted falls back to a fixed 30s bound. */
  readonly timeoutMs?: number;
}

export type RoomAccessMechanism = 'wac' | 'acp';

export interface RoomAccessGrantResult {
  readonly roomContainerUri: string;
  readonly controlUri: string;
  readonly mechanism: RoomAccessMechanism;
  readonly grantedWebIds: readonly string[];
}

function requireWebId(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RoomAccessError('grant-failed');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RoomAccessError('grant-failed');
  }
  return value;
}

function normalizeParticipants(participants: readonly string[], owner: string): string[] {
  const unique: string[] = [];
  for (const participant of participants) {
    const webId = requireWebId(participant);
    if (webId === owner || unique.includes(webId)) continue;
    unique.push(webId);
  }
  if (!unique.length) throw new RoomAccessError('grant-failed');
  return unique;
}

interface Capture {
  readonly url: string;
  /** ETag of the single GET that produced the dataset. */
  etag?: string;
}

/**
 * Wrap a fetch so every SDK transport call inherits the same bounded
 * AbortSignal, optionally capturing the ETag of the ONE GET that produced a
 * dataset.
 *
 * The capture is the point: a later HEAD would authorize replacing a dataset
 * with an ETag that never described it.
 */
function boundedFetch(authFetch: typeof fetch, timeoutMs: number, capture?: Capture): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url;
    let response: Response;
    try {
      response = await authFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new RoomAccessError('container-unreachable');
      }
      throw error;
    }
    if (capture && url === capture.url && (init?.method ?? 'GET').toUpperCase() === 'GET'
      && response.ok && capture.etag === undefined) {
      capture.etag = response.headers.get('ETag') ?? undefined;
    }
    return response;
  };
  return wrapped as typeof fetch;
}

/** Existing Xpod own-control rules: advertised URI is exactly one of these. */
function isOwnAcr(uri: string, container: string): boolean {
  return uri === `${container}.acr`;
}

function isOwnAcl(uri: string, container: string): boolean {
  return uri === `${container}.acl`;
}

/**
 * Read the resource's own advertised access-control URL.
 *
 * The server picks the URL and it is used VERBATIM. Unsafe forms (fragment,
 * embedded credentials, foreign origin, outside the container path) are
 * rejected rather than rewritten: stripping a query would fetch a different
 * document than the one advertised.
 */
async function discoverControl(
  container: string,
  authFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ uri: string; exists: boolean }> {
  let head: Response;
  try {
    head = await authFetch(container, {
      method: 'HEAD',
      headers: { Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RoomAccessError('container-unreachable');
  }
  if (head.status !== 200 && head.status !== 404) throw new RoomAccessError('container-unreachable');

  const link = head.headers.get('Link');
  const match = link?.match(/<([^>]+)>\s*;\s*rel=["']acl["']/iu);
  if (!match?.[1]) throw new RoomAccessError('control-undiscoverable');
  let advertised: URL;
  try {
    advertised = new URL(match[1], container);
  } catch {
    throw new RoomAccessError('control-undiscoverable');
  }
  if (advertised.hash) throw new RoomAccessError('control-unsafe-uri');
  if (advertised.username || advertised.password) throw new RoomAccessError('control-unsafe-uri');
  const containerUrl = new URL(container);
  if (advertised.origin !== containerUrl.origin) throw new RoomAccessError('control-not-own-resource');
  if (!advertised.pathname.startsWith(containerUrl.pathname)) {
    throw new RoomAccessError('control-not-own-resource');
  }

  let current: Response;
  try {
    current = await authFetch(advertised.toString(), {
      headers: { Accept: 'text/turtle' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RoomAccessError('control-undiscoverable');
  }
  if (current.status !== 404 && !current.ok) throw new RoomAccessError('control-undiscoverable');
  return { uri: advertised.toString(), exists: current.ok };
}

/**
 * Stable, collision-resistant ACP fragment key for one full WebID.
 *
 * Hashes the whole identifier: two WebIDs that share an issuer prefix must
 * never collapse onto the same policy nodes, or the second grant would
 * overwrite the first.
 */
function acpControlKey(prefix: string, webId: string): string {
  return `${prefix}${createHash('sha256').update(webId, 'utf8').digest('hex')}`;
}

function initialAcr(container: string, owner: string, agent: string, key: string): string {
  const iri = (value: string): string => `<${value.replace(/>/gu, '%3E')}>`;
  return [
    '@prefix acp: <http://www.w3.org/ns/solid/acp#>.',
    '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
    '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>.',
    '',
    '<#acr> a acp:AccessControlResource;',
    `  acp:resource ${iri(container)};`,
    '  acp:accessControl <#owner>, <#agent>;',
    '  acp:memberAccessControl <#owner>, <#agent>.',
    '<#owner> a acp:AccessControl; acp:apply <#ownerPolicy>.',
    '<#ownerPolicy> a acp:Policy;',
    '  acp:allow acl:Read, acl:Write, acl:Control; acp:anyOf <#ownerMatcher>.',
    `<#ownerMatcher> a acp:Matcher; acp:agent ${iri(owner)}.`,
    '<#agent> a acp:AccessControl; acp:apply <#agentPolicy>.',
    '<#agentPolicy> a acp:Policy;',
    '  acp:allow acl:Read, acl:Append, acl:Write; acp:anyOf <#agentMatcher>.',
    `<#agentMatcher> a acp:Matcher; acp:agent ${iri(agent)}.`,
    `# ${key}`,
    '',
  ].join('\n');
}

interface LoadedControl {
  readonly acp: boolean;
  readonly dataset?: Awaited<ReturnType<typeof getSolidDataset>>;
  /** ETag of the exact GET that produced `dataset`, when the server sent one. */
  readonly etag?: string;
}

/**
 * Load a control document once, capturing the ETag and body of that same GET.
 *
 * The mechanism comes from the document's own RDF (acp:AccessControlResource),
 * never from a filename suffix, so an opaque or nested advertised ACR is
 * classified correctly instead of being mistaken for WAC.
 */
async function loadControl(
  uri: string,
  authFetch: typeof fetch,
  timeoutMs: number,
): Promise<LoadedControl> {
  const capture: Capture = { url: uri };
  const fetching = boundedFetch(authFetch, timeoutMs, capture);
  let dataset: Awaited<ReturnType<typeof getSolidDataset>>;
  try {
    dataset = await getSolidDataset(uri, { fetch: fetching as never });
  } catch {
    throw new RoomAccessError('control-undiscoverable');
  }
  // Mechanism comes from the parsed control document's own RDF types, never a
  // filename suffix, so an opaque or nested ACR is classified correctly.
  const acp = getThingAll(dataset).some((thing) =>
    getUrlAll(thing, RDF_TYPE).includes(ACP_ACCESS_CONTROL_RESOURCE));
  return { acp, dataset, etag: capture.etag };
}

async function createAcr(input: {
  controlUri: string;
  container: string;
  owner: string;
  agent: string;
  authFetch: typeof fetch;
  timeoutMs: number;
}): Promise<void> {
  const key = acpControlKey('rcMatrixRoom', input.agent);
  let response: Response;
  try {
    response = await input.authFetch(input.controlUri, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle', 'If-None-Match': '*' },
      body: initialAcr(input.container, input.owner, input.agent, key),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    throw new RoomAccessError('grant-failed');
  }
  if (response.ok) return;
  if (response.status === 412) throw new RoomAccessError('control-concurrent-modification');
  throw new RoomAccessError('grant-failed');
}

async function grantAcp(input: {
  controlUri: string;
  container: string;
  agent: string;
  authFetch: typeof fetch;
  timeoutMs: number;
  /** Dataset AND ETag from the SAME single GET, never re-fetched. */
  loaded: LoadedControl;
}): Promise<void> {
  const loaded = input.loaded;
  if (!loaded.dataset) throw new RoomAccessError('control-undiscoverable');
  if (!loaded.acp) throw new RoomAccessError('control-mechanism-unknown');

  const acr = loaded.dataset;
  const root = getThingAll(acr).find((thing) =>
    getUrlAll(thing, RDF_TYPE).includes(ACP_ACCESS_CONTROL_RESOURCE));
  if (!root) throw new RoomAccessError('control-mechanism-unknown');
  // The ACR must describe THIS resource; mutating an inherited/parent ACR is refused.
  if (!getUrlAll(root, ACP_RESOURCE).includes(input.container)) {
    throw new RoomAccessError('control-not-own-resource');
  }

  const key = acpControlKey('rcMatrixRoom', input.agent);
  const controlUrl = `${input.controlUri}#${key}Access`;
  const policyUrl = `${input.controlUri}#${key}Policy`;
  const matcherUrl = `${input.controlUri}#${key}Matcher`;
  let updated = addUrl(root, ACP_ACCESS_CONTROL_LINK, controlUrl);
  updated = addUrl(updated, ACP_MEMBER_ACCESS_CONTROL, controlUrl);
  let next = setThing(acr, updated);
  next = setThing(next, buildThing(createThing({ url: controlUrl }))
    .addUrl(RDF_TYPE, ACP_ACCESS_CONTROL)
    .addUrl(ACP_APPLY, policyUrl)
    .build());
  next = setThing(next, buildThing(createThing({ url: policyUrl }))
    .addUrl(RDF_TYPE, ACP_POLICY)
    .addUrl(ACP_ALLOW, `${ACL}Read`)
    .addUrl(ACP_ALLOW, `${ACL}Append`)
    .addUrl(ACP_ALLOW, `${ACL}Write`)
    .addUrl(ACP_ANY_OF, matcherUrl)
    .build());
  next = setThing(next, buildThing(createThing({ url: matcherUrl }))
    .addUrl(RDF_TYPE, ACP_MATCHER)
    .addUrl(ACP_AGENT, input.agent)
    .build());

  try {
    await saveSolidDatasetAt(input.controlUri, next, {
      fetch: boundedFetch(input.authFetch, input.timeoutMs) as never,
    });
    return;
  } catch {
    // Fall back ONLY with the ETag captured from the GET that produced this
    // dataset. Without it, refuse: a fresh HEAD would authorize overwriting a
    // concurrent writer's change.
    if (!loaded.etag) throw new RoomAccessError('control-concurrent-modification');
  }

  let turtle: string;
  try {
    turtle = await solidDatasetAsTurtle(next);
  } catch {
    throw new RoomAccessError('grant-failed');
  }
  let put: Response;
  try {
    put = await input.authFetch(input.controlUri, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle', 'If-Match': loaded.etag },
      body: turtle,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    throw new RoomAccessError('grant-failed');
  }
  if (put.status === 412) throw new RoomAccessError('control-concurrent-modification');
  if (!put.ok) throw new RoomAccessError('grant-failed');
}

async function grantWac(input: {
  container: string;
  agent: string;
  authFetch: typeof fetch;
  timeoutMs: number;
}): Promise<void> {
  // solid-client's ACL helpers are typed against its own internal dataset
  // brands; the runtime accepts the values, so the casts stay local here.
  const fetching = boundedFetch(input.authFetch, input.timeoutMs);
  let resource;
  try {
    resource = await getSolidDatasetWithAcl(input.container, { fetch: fetching as never });
  } catch {
    throw new RoomAccessError('control-undiscoverable');
  }
  let acl: Awaited<ReturnType<typeof createAclFromFallbackAcl>>;
  if (hasResourceAcl(resource)) {
    acl = getResourceAcl(resource) as Awaited<ReturnType<typeof createAclFromFallbackAcl>>;
  } else if (hasFallbackAcl(resource)) {
    acl = createAclFromFallbackAcl(resource as Parameters<typeof createAclFromFallbackAcl>[0]);
  } else {
    throw new RoomAccessError('control-undiscoverable');
  }
  // Resource ACL for the container plus default ACL for future descendants.
  // WAC: acl:Write already implies append capability, so the library emits
  // Read+Write for {read, append, write}. Control is never requested.
  const access = { read: true, append: true, write: true, control: false } as const;
  acl = setAgentResourceAccess(acl as never, input.agent, access as never) as typeof acl;
  acl = setAgentDefaultAccess(acl as never, input.agent, access as never) as typeof acl;
  try {
    await saveAclFor(resource as Parameters<typeof saveAclFor>[0], acl as never, {
      fetch: fetching as never,
    });
  } catch (error) {
    if (error instanceof RoomAccessError) throw error;
    throw new RoomAccessError('grant-failed');
  }
}

/**
 * Grant every invitee Read/Append/Write on the room container and descendants.
 *
 * Must run BEFORE the Matrix invite so a grant failure fails the acceptance
 * check without inviting anyone.
 */
export async function grantMatrixRoomAccess(input: RoomAccessGrantInput): Promise<RoomAccessGrantResult> {
  const storage = canonicalStorageRoot(input.storageRoot);
  if (!storage) throw new RoomAccessError('room-container-invalid');
  const expected = matrixRoomContainerUri(input.roomId, storage);
  if (input.roomContainerUri !== expected) throw new RoomAccessError('room-container-invalid');
  const container = expected;
  const owner = requireWebId(input.ownerWebId);
  const participants = normalizeParticipants(input.participants, owner);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RoomAccessError('grant-failed');

  const control = await discoverControl(container, input.authFetch, timeoutMs);

  // Missing control document. Only an exact own-control suffix may be
  // initialized, and ACP may only be created at the ACR; a missing WAC .acl
  // must be satisfied through the WAC path (resource/fallback ACL), never by
  // writing ACP content into a .acl document.
  if (!control.exists) {
    if (isOwnAcl(control.uri, container)) {
      for (const agent of participants) {
        await grantWac({ container, agent, authFetch: input.authFetch, timeoutMs });
      }
      return Object.freeze({
        roomContainerUri: container,
        controlUri: control.uri,
        mechanism: 'wac',
        grantedWebIds: Object.freeze(participants),
      });
    }
    if (!isOwnAcr(control.uri, container)) {
      throw new RoomAccessError('control-mechanism-unknown');
    }
    // First agent creates the ACR; every later agent re-loads the latest
    // actual document and merges, so prior grants can never be dropped.
    await createAcr({
      controlUri: control.uri, container, owner, agent: participants[0]!,
      authFetch: input.authFetch, timeoutMs,
    });
    for (const agent of participants.slice(1)) {
      const latest = await loadControl(control.uri, input.authFetch, timeoutMs);
      await grantAcp({
        controlUri: control.uri, container, agent,
        authFetch: input.authFetch, timeoutMs, loaded: latest,
      });
    }
    return Object.freeze({
      roomContainerUri: container,
      controlUri: control.uri,
      mechanism: 'acp',
      grantedWebIds: Object.freeze(participants),
    });
  }

  // Existing document: decide the mechanism from its own RDF once, but load
  // the LATEST document per agent so each grant merges into the current state
  // with that GET's ETag.
  const initial = await loadControl(control.uri, input.authFetch, timeoutMs);
  const mechanism: RoomAccessMechanism = initial.acp ? 'acp' : 'wac';
  if (mechanism === 'acp' && !initial.dataset) throw new RoomAccessError('control-undiscoverable');

  if (mechanism === 'wac') {
    for (const agent of participants) {
      await grantWac({ container, agent, authFetch: input.authFetch, timeoutMs });
    }
    return Object.freeze({
      roomContainerUri: container,
      controlUri: control.uri,
      mechanism,
      grantedWebIds: Object.freeze(participants),
    });
  }

  for (const [index, agent] of participants.entries()) {
    const loaded = index === 0 ? initial : await loadControl(control.uri, input.authFetch, timeoutMs);
    await grantAcp({
      controlUri: control.uri, container, agent,
      authFetch: input.authFetch, timeoutMs, loaded,
    });
  }

  return Object.freeze({
    roomContainerUri: container,
    controlUri: control.uri,
    mechanism,
    grantedWebIds: Object.freeze(participants),
  });
}
