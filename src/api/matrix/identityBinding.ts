/**
 * The identity binding: which Pod holds a participant's Matrix data, under which
 * server name, at which version.
 *
 * The service contract (§2.2) asks for this to be persisted in the Pod the user
 * chose, because the thing that actually needs it is a *move*: when a participant
 * switches Pods, an in-flight write must not land on the old one, a reader must be
 * able to tell the two apart, and a half-finished switch must be recoverable. Those
 * are the rules this module owns. Where the record is stored is a separate decision —
 * no schema in `@undefineds.co/models` has a per-user document with an opaque
 * `metadata` column today, and inventing one locally would put a shared model in the
 * wrong repository — so the codec and the state machine are here, and the carrier is
 * chosen separately.
 *
 * Confirmation is deliberately explicit: a binding only becomes active once the new
 * Pod is observed to hold the facts, so a switch cannot silently point the service at
 * a Pod that never received them.
 */
export interface MatrixIdentityBinding {
  /** The participant's WebID. */
  webId: string;
  /** The MXID derived for this WebID under `serverName`. */
  matrixUserId: string;
  /** The server whose identity signs this participant's events. */
  serverName: string;
  /** The Pod that holds this participant's Matrix data. */
  podUrl: string;
  /** Monotonic per identity: a switch increments it so a concurrent reader can tell. */
  version: number;
  /** `pending` while a switch has not been confirmed by the new Pod's contents. */
  status: 'active' | 'pending';
  /** The grant the service writes to that Pod with, when it is not the caller. */
  serviceAuthorization?: string;
  updatedAt: string;
}

export interface CreateMatrixIdentityBindingInput {
  webId: string;
  matrixUserId: string;
  serverName: string;
  podUrl: string;
  now?: () => number;
  serviceAuthorization?: string;
}

export function createMatrixIdentityBinding(input: CreateMatrixIdentityBindingInput): MatrixIdentityBinding {
  assertIdentity(input.webId, 'WebID');
  assertIdentity(input.matrixUserId, 'MXID');
  assertIdentity(input.serverName, 'server name');
  assertIdentity(input.podUrl, 'Pod URL');
  return {
    webId: input.webId,
    matrixUserId: input.matrixUserId,
    serverName: input.serverName,
    podUrl: normalizePodUrl(input.podUrl),
    version: 1,
    status: 'active',
    ...(input.serviceAuthorization === undefined ? {} : { serviceAuthorization: input.serviceAuthorization }),
    updatedAt: new Date((input.now ?? Date.now)()).toISOString(),
  };
}

/**
 * Bind this identity to a Pod. Binding to the Pod it already uses — and the same
 * server name — is a no-op, so calling it on every start does not churn versions.
 */
export function bindMatrixIdentity(
  existing: MatrixIdentityBinding | undefined,
  input: CreateMatrixIdentityBindingInput,
): MatrixIdentityBinding {
  if (!existing) return createMatrixIdentityBinding(input);
  assertSameIdentity(existing, input);
  if (normalizePodUrl(existing.podUrl) === normalizePodUrl(input.podUrl) && existing.serverName === input.serverName) {
    return existing;
  }
  return {
    ...existing,
    podUrl: normalizePodUrl(input.podUrl),
    serverName: input.serverName,
    matrixUserId: input.matrixUserId,
    version: existing.version + 1,
    status: 'pending',
    ...(input.serviceAuthorization === undefined
      ? (existing.serviceAuthorization === undefined ? {} : { serviceAuthorization: existing.serviceAuthorization })
      : { serviceAuthorization: input.serviceAuthorization }),
    updatedAt: new Date((input.now ?? Date.now)()).toISOString(),
  };
}

/**
 * Confirm a switch once the Pod it points at is observed to hold this identity's
 * facts. A binding that is already active is returned unchanged, and a confirmation
 * that names a different Pod than the pending binding is refused: it would confirm a
 * move that was never started.
 */
export function confirmMatrixIdentityBinding(
  binding: MatrixIdentityBinding,
  input: { podUrl: string; now?: () => number },
): MatrixIdentityBinding {
  if (binding.status === 'active') return binding;
  if (normalizePodUrl(binding.podUrl) !== normalizePodUrl(input.podUrl)) {
    throw new Error(`Cannot confirm binding version ${binding.version}: it points at ${binding.podUrl}, not ${input.podUrl}`);
  }
  return { ...binding, status: 'active', updatedAt: new Date((input.now ?? Date.now)()).toISOString() };
}

/**
 * Which binding a reader should trust when it sees two: the higher version wins, and a
 * pending one is only trusted for the Pod it names — the previous Pod keeps serving
 * reads until the switch is confirmed.
 */
export function freshestMatrixIdentityBinding(
  left: MatrixIdentityBinding | undefined,
  right: MatrixIdentityBinding | undefined,
): MatrixIdentityBinding | undefined {
  if (!left) return right;
  if (!right) return left;
  assertSameIdentity(left, right);
  return right.version > left.version ? right : left;
}

/**
 * Whether a writer that holds `held` may write, given the binding that is current in
 * the Pod (`current`). A writer whose version is behind must refresh instead of
 * writing to the Pod it remembers: that is how a concurrent switch stays safe.
 */
export function bindingAllowsWrites(held: MatrixIdentityBinding, current: MatrixIdentityBinding): boolean {
  assertSameIdentity(held, current);
  return !isStaleBinding(held, current);
}

/** A binding is stale when a newer version exists, or the Pod it names is not the current one. */
export function isStaleBinding(held: MatrixIdentityBinding, current: MatrixIdentityBinding): boolean {
  assertSameIdentity(held, current);
  return held.version < current.version || normalizePodUrl(held.podUrl) !== normalizePodUrl(current.podUrl);
}

export function encodeMatrixIdentityBinding(binding: MatrixIdentityBinding): string {
  assertBinding(binding);
  return JSON.stringify(binding);
}

export function decodeMatrixIdentityBinding(json: string): MatrixIdentityBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Stored Matrix identity binding is not valid JSON');
  }
  assertBinding(parsed);
  return parsed;
}

export function assertBinding(value: unknown): asserts value is MatrixIdentityBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Matrix identity binding must be an object');
  }
  const binding = value as Record<string, unknown>;
  for (const field of [ 'webId', 'matrixUserId', 'serverName', 'podUrl', 'updatedAt' ]) {
    if (typeof binding[field] !== 'string' || !(binding[field] as string).trim()) {
      throw new Error(`Matrix identity binding needs a non-empty ${field}`);
    }
  }
  if (!Number.isSafeInteger(binding.version) || (binding.version as number) < 1) {
    throw new Error('Matrix identity binding needs a positive integer version');
  }
  if (binding.status !== 'active' && binding.status !== 'pending') {
    throw new Error(`Matrix identity binding has an unknown status: ${String(binding.status)}`);
  }
  if (binding.serviceAuthorization !== undefined && typeof binding.serviceAuthorization !== 'string') {
    throw new Error('Matrix identity binding serviceAuthorization must be a string');
  }
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Matrix identity binding needs a ${label}`);
}

/** Two bindings are about the same participant, or one of them is a corruption. */
function assertSameIdentity(left: MatrixIdentityBinding, right: { webId: string; matrixUserId: string }): void {
  if (left.webId !== right.webId) {
    throw new Error(`Matrix identity binding is for ${left.webId}, not ${right.webId}`);
  }
  if (left.matrixUserId !== right.matrixUserId) {
    throw new Error(`Matrix identity binding MXID ${left.matrixUserId} does not match ${right.matrixUserId}`);
  }
}

function normalizePodUrl(podUrl: string): string {
  return podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
}
