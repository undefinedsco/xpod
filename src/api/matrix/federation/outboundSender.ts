/**
 * Sending as whichever server the transaction is from.
 *
 * Each participant is their own Matrix server, so the origin of a transaction is not the
 * deployment: it is the participant whose event is travelling, and the transaction has to
 * be signed with *that* identity's key. A deployment that signed everything with one
 * deployment key would make every participant's events attributable to the deployment —
 * exactly the mis-signing the custody decision forbids.
 *
 * This is the join between the signing identities a deployment holds and the federation
 * client: one client per origin (the client carries the signer), created on first use and
 * reused. An origin this deployment holds no key for is refused with a `rejected`
 * outcome — never retried, and never signed with somebody else's key, because a verifier
 * could not tell that apart from a forgery.
 */
import {
  MatrixFederationClient,
  type FederationEventsOutcome,
  type MatrixDeliveryOutcome,
  type MatrixDeliveryPolicy,
  type MatrixFederationActor,
} from './outboundTransaction';
import type { MatrixSigningIdentitySource } from '../identityRegistry';
import type { FederationFetchTarget } from './federationFetch';
import type { MatrixResolvedServer } from './serverNameResolution';

export interface MatrixOutboundSenderOptions {
  /** Signing identities by server name; the origin's identity signs its transactions. */
  identities: MatrixSigningIdentitySource;
  resolve: (serverName: string) => Promise<MatrixResolvedServer | undefined>;
  fetch: typeof fetch;
  /** Transport that can present a delegated server name; see `federationFetch.ts`. */
  fetchTarget?: FederationFetchTarget;
  /**
   * Resolve the participant's authenticated fetch at send time (O1). Absent means actor-bearing
   * sends are refused by the client rather than falling back to a signed deployment identity.
   */
  actorFetch?: (actor: MatrixFederationActor) => Promise<typeof fetch | undefined>;
  now?: () => number;
  random?: () => number;
  /** How hard one attempt tries before the transaction is handed back to the queue. */
  policy?: MatrixDeliveryPolicy;
  /** Injectable so delivery policy is testable without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SendAsInput {
  origin: string;
  destination: string;
  txnId: string;
  pdus: readonly unknown[];
  edus?: readonly unknown[];
  /** The participant whose authority sends this transaction (O1); absent keeps the signed path. */
  actor?: MatrixFederationActor;
}

export class MatrixOutboundSender {
  private readonly identities: MatrixSigningIdentitySource;
  private readonly clients = new Map<string, MatrixFederationClient>();
  private readonly options: MatrixOutboundSenderOptions;

  public constructor(options: MatrixOutboundSenderOptions) {
    this.identities = options.identities;
    this.options = options;
  }

  /**
   * Send one transaction as `origin`, spending the configured retry budget. The outcome
   * is the queue's input: `retry` leaves the batch pending under the same id.
   */
  public async send(input: SendAsInput): Promise<MatrixDeliveryOutcome> {
    const client = await this.clientFor(input.origin);
    if (!client) {
      return {
        status: 'rejected',
        origin: input.origin,
        destination: input.destination,
        txnId: input.txnId,
        reason: `this deployment holds no signing identity for ${input.origin}`,
      };
    }
    const delivery = {
      destination: input.destination,
      txnId: input.txnId,
      pdus: input.pdus,
      ...(input.edus === undefined ? {} : { edus: input.edus }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(this.options.policy === undefined ? {} : { policy: this.options.policy }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
    };

    // One transport: the batch goes to the peer's federation endpoint under the transaction id.
    // The native endpoint this used to try first is gone with the two-path design — one shape,
    // reached the same way for every peer.
    const result = await client.deliverTransaction(delivery);
    return result.outcome;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Ask a peer for the auth chain of one event, as `origin`. Used by a receiver that has to
   * authorise an event whose auth events it does not have.
   */
  public async requestAuthChain(input: {
    origin: string;
    destination: string;
    roomId: string;
    eventId: string;
  }): Promise<FederationEventsOutcome> {
    const client = await this.clientFor(input.origin);
    if (!client) {
      return { status: 'rejected', reason: `this deployment holds no signing identity for ${input.origin}` };
    }
    return await client.getAuthChain({ destination: input.destination, roomId: input.roomId, eventId: input.eventId });
  }

  /** The client that signs as `origin`, or `undefined` when this deployment cannot. */
  /**
   * The federation client that signs as `origin`, for callers that need more than sending a
   * transaction: the membership handshake, a directory query, a state read. `undefined` when this
   * deployment holds no identity for that server name.
   */
  public async clientFor(origin: string): Promise<MatrixFederationClient | undefined> {
    const cached = this.clients.get(origin);
    if (cached) return cached;
    // A registry answers for the names it holds; anything else is not ours to sign.
    const known = this.identities.serverNames?.();
    if (known && !known.includes(origin)) return undefined;
    let identity;
    try {
      identity = await this.identities.identityFor(origin);
    } catch {
      // A registry that refuses an unknown name is saying the same thing as `undefined`.
      return undefined;
    }
    if (!identity) return undefined;
    const client = new MatrixFederationClient({
      identity,
      resolve: this.options.resolve,
      fetch: this.options.fetch,
      ...(this.options.fetchTarget === undefined ? {} : { fetchTarget: this.options.fetchTarget }),
      ...(this.options.actorFetch === undefined ? {} : { actorFetch: this.options.actorFetch }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.random === undefined ? {} : { random: this.options.random }),
    });
    this.clients.set(origin, client);
    return client;
  }
}
