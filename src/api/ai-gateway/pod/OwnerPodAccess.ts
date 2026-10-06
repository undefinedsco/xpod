import { buildAuthenticatedFetch } from '@inrupt/solid-client-authn-core';
import { getLoggerFor } from 'global-logger-factory';
import { hasSolidClientCredentialsAuthority, type AuthContext } from '../../auth/AuthContext';
import { SolidSessionError, type SolidSession, type SolidSessionFactory, type SolidClientCredential } from '../../auth/SolidSessionFactory';
import {
  CALLER_DPOP_REPLAY_UNSUPPORTED,
  CALLER_OWNER_MISMATCH,
  CALLER_POD_ACCESS_UNAVAILABLE,
  createCallerAuthenticatedPodFetch,
} from '../auth/CallerPodAccess';
import { createHostedPodRouteTransport, type HostedPodRoute } from './HostedPodRoute';
import type { PodInterfaceCredential } from './PodInterfaceKeyStore';

/** No usable Pod credential is on file for this owner; the user has to grant one. */
export const POD_INTERFACE_KEY_MISSING = 'pod_interface_key_missing';
/** The owner's stored credential was refused by the Pod; it has to be granted again. */
export const POD_INTERFACE_KEY_REJECTED = 'pod_interface_key_rejected';

export interface PodAccessRequestContext {
  /** The authenticated caller, when the request carries one. */
  auth?: AuthContext;
  /** Physical Pod root when the identity WebID is hosted by a separate IdP. */
  podBaseUrl?: string;
  /**
   * Work that runs without a caller takes its credential from the task layer.
   *
   * `ownerGrant` asks for the owner's active grant; `credentialRef` names one grant, optionally
   * frozen at the `version` its binding recorded. Setting this means the request may not borrow
   * the API's stored key: an unusable grant fails the call so the caller reports why.
   */
  taskCredential?: {
    credentialRef?: string;
    version?: number;
    ownerGrant?: true;
  };
}

/** A credential the task layer holds for an owner, with the grant it came from. */
export interface TaskPodCredential extends PodInterfaceCredential {
  credentialRef: string;
  version: number;
}

/**
 * The task layer's credentials, as this component needs them.
 *
 * Kept as an interface so Pod access depends on "a grant the task layer vouches for" rather than
 * on the task layer's storage.
 */
export interface TaskCredentialSource {
  /** The owner's active grant for this deployment, if the owner made one. */
  activeFor(ownerWebId: string): Promise<TaskPodCredential | undefined>;
  /** One named grant, checked for its owner and version. */
  forRef(input: { credentialRef: string; ownerWebId: string; version?: number }): Promise<TaskPodCredential | undefined>;
}

/**
 * Source of a fetch that reaches an owner's Pod through its standard interface.
 *
 * `undefined` means no credential is on file, which is a state the caller reports to the user
 * rather than papers over.
 */
export interface PodAccessFetchProvider {
  getPodFetch(owner: string, context?: PodAccessRequestContext): Promise<typeof fetch | undefined>;
}

export interface OwnerPodAccessOptions {
  /**
   * Shared Solid session factory. The caller's own credential was already exchanged while
   * authenticating the request, so reaching the Pod reuses that session and its DPoP key
   * instead of exchanging the same credential a second time.
   */
  sessions: SolidSessionFactory;
  /**
   * Task-layer credentials for work that runs without a caller. Absent means such work can only
   * use the deployment's stored key, which is the pre-migration behaviour.
   */
  taskCredentials?: TaskCredentialSource;
  /** Route this deployment exposes for its own hosted Pods, when one is needed. */
  route?: HostedPodRoute;
  fetch?: typeof fetch;
}

/**
 * Reaches a Pod as its owner over the standard Solid interface.
 *
 * Three credentials can prove the owner, and all three are the owner's own interface key:
 * the caller's key, when the caller presented one; the caller's reusable token, when it holds
 * one; and the key the owner granted this deployment for work no caller is attached to.
 *
 * What never happens is asking the Solid server to trust the caller's network position. Every
 * request carries a credential for the owner and addresses the Pod's own URLs, so the Pod's own
 * authorization decides - exactly as it does for the browser.
 */
export class OwnerPodAccess implements PodAccessFetchProvider {
  private readonly logger = getLoggerFor(this);
  private readonly sessions: SolidSessionFactory;
  private readonly taskCredentials?: TaskCredentialSource;
  private readonly fetchImpl: typeof fetch;
  private readonly route?: HostedPodRoute;
  private transport?: Promise<typeof fetch>;

  public constructor(options: OwnerPodAccessOptions) {
    this.sessions = options.sessions;
    this.taskCredentials = options.taskCredentials;
    this.fetchImpl = options.fetch ?? fetch;
    this.route = options.route;
  }

  public async getPodFetch(
    owner: string,
    context: PodAccessRequestContext = {},
  ): Promise<typeof fetch | undefined> {
    const auth = context.auth;
    if (auth?.type === 'solid' && auth.webId !== owner) {
      // A caller authenticated as somebody else never borrows this owner's credential.
      return undefined;
    }
    if (context.taskCredential) {
      return await this.taskCredentialFetch(owner, context.taskCredential);
    }
    if (hasSolidClientCredentialsAuthority(auth)) {
      // The caller's own interface key, already exchanged while authenticating this request: the
      // session factory hands back that same token together with the key it is bound to.
      return await this.credentialFetch(
        owner,
        { clientId: auth.clientId, clientSecret: auth.clientSecret },
      );
    }
    // Only the caller's own credential opens the Pod. A deployment-held key would make "this
    // request was authorized" indistinguishable from "somebody registered once".
    return createCallerAuthenticatedPodFetch(owner, auth, this.fetchImpl, this.route);
  }

  /**
   * Reach the Pod with a task-layer grant. There is no fallback on purpose: falling back to the
   * API's stored key would make "this task was authorized" indistinguishable from "somebody
   * registered once".
   */
  private async taskCredentialFetch(
    owner: string,
    request: NonNullable<PodAccessRequestContext['taskCredential']>,
  ): Promise<typeof fetch | undefined> {
    if (!this.taskCredentials) {
      return undefined;
    }
    const credential = request.credentialRef
      ? await this.taskCredentials.forRef({
        credentialRef: request.credentialRef,
        ownerWebId: owner,
        ...(request.version !== undefined ? { version: request.version } : {}),
      })
      : await this.taskCredentials.activeFor(owner);
    if (!credential) {
      return undefined;
    }
    const sessionCredential: SolidClientCredential = { ...credential, version: String(credential.version) };
    return await this.credentialFetch(owner, sessionCredential, async () => {
      const current = await this.taskCredentials!.forRef({
        credentialRef: credential.credentialRef,
        ownerWebId: owner,
        version: credential.version,
      });
      if (!current || current.credentialRef !== credential.credentialRef || current.version !== credential.version
        || current.clientId !== credential.clientId || current.clientSecret !== credential.clientSecret) {
        this.sessions.invalidate(sessionCredential);
        throw new Error(`${POD_INTERFACE_KEY_REJECTED}:task_grant_unusable`);
      }
    });
  }

  private async credentialFetch(
    owner: string,
    credential: SolidClientCredential,
    assertAuthorized?: () => Promise<void>,
  ): Promise<typeof fetch> {
    const currentSession = async (): Promise<SolidSession> => {
      try {
        const session = await this.sessions.session(credential);
        if (!sameWebIdOwner(session.webId, owner)) {
          this.sessions.invalidate(credential, session);
          throw new SolidSessionError('token_owner_mismatch');
        }
        return session;
      } catch (error) {
        const status = error instanceof SolidSessionError ? error.status : undefined;
        this.logger.warn(`Pod interface key refused for ${owner}: ${String(error)}`);
        throw new Error(`${POD_INTERFACE_KEY_REJECTED}:${status ?? 'invalid_response'}`);
      }
    };
    // Preserve immediate credential validation at getPodFetch, then check again per request.
    let session = await currentSession();
    const transport = await (this.transport ??= createHostedPodRouteTransport(this.fetchImpl, this.route));
    const authenticatedFor = (value: SolidSession): typeof fetch => buildAuthenticatedFetch(value.accessToken, {
      ...(value.dpopKey ? { dpopKey: value.dpopKey } : {}),
      fetch: transport,
    });
    let authenticated = authenticatedFor(session);
    return async (input, init) => {
      await assertAuthorized?.();
      const requestSession = await currentSession();
      // Recheck a task grant after a possibly slow exchange, before dispatching its token.
      await assertAuthorized?.();
      if (session !== requestSession) {
        session = requestSession;
        authenticated = authenticatedFor(session);
      }
      const response = await authenticated(input, init);
      if (response.status === 401) {
        // Return the original rejection; writes are never replayed to try another token.
        this.sessions.invalidate(credential, requestSession);
      }
      return response;
    };
  }
}

/**
 * Whether an exchanged token names the owner it was requested for.
 *
 * A WebID is a full URI, so identity is the exact URI, fragment included: two fragments on the
 * same document (`#alice` and `#bob`) are different principals, and a fragmentless document is a
 * different URI from its `#me` principal. The token must name exactly the owner that was asked for.
 * Any normalization belongs at the authoritative claim/provisioning/fixture source, never here.
 */
function sameWebIdOwner(sessionWebId: string | undefined, owner: string): boolean {
  if (!sessionWebId) {
    return true;
  }
  return sessionWebId === owner;
}

/**
 * Reason an owner's Pod is out of reach, as a stable code the caller and the UI can act on.
 *
 * A same-owner caller is the ordinary case: Xpod knows who the user is, but holds nothing it can
 * present to the Pod on the user's behalf. A browser session explains why its own credential was
 * not enough - its proof is bound to the URL it was made for - while a bearer session simply has
 * no Pod credential at all. Either way the fix is the same: grant the interface key.
 *
 * One cause is not covered by that fix: a principal Xpod authenticated for itself (a gateway
 * access key, or a runtime invocation token) is not a Pod principal, so it reports the missing
 * key even though the caller's remedy is to present a Pod credential. Splitting that into its
 * own reason is tracked in `docs/pod-interface-key.md` decision 4.
 */
export function podAccessError(owner: string, auth?: AuthContext): string {
  if (!auth || auth.type !== 'solid') {
    return CALLER_POD_ACCESS_UNAVAILABLE;
  }
  if (auth.webId !== owner) {
    return CALLER_OWNER_MISMATCH;
  }
  if (auth.tokenType === 'DPoP' || typeof auth.dpopProof === 'string') {
    return CALLER_DPOP_REPLAY_UNSUPPORTED;
  }
  return POD_INTERFACE_KEY_MISSING;
}

/**
 * Whether a failure means Xpod had no usable way into the owner's Pod.
 *
 * The stable wire code for this is `service_access_missing`, which callers already report; the
 * codes below are the reason behind it, kept distinct so the UI can ask for the right fix.
 */
export function isPodAccessFailure(message: string): boolean {
  return message === 'service_access_missing'
    || message === 'Authoritative Pod storage binding ambiguous'
    || message === 'Authoritative Pod credential binding changed on cached context'
    || message === 'Authoritative Pod credential binding changed while opening database'
    || message === 'Authoritative Pod storage binding changed on cached context'
    || message === 'Authoritative Pod storage binding conflicts with request'
    || message.startsWith(POD_INTERFACE_KEY_MISSING)
    || message.startsWith(POD_INTERFACE_KEY_REJECTED)
    || message.startsWith(CALLER_DPOP_REPLAY_UNSUPPORTED)
    || message.startsWith(CALLER_OWNER_MISMATCH)
    || message.startsWith(CALLER_POD_ACCESS_UNAVAILABLE);
}

