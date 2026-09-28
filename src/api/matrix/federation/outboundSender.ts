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
} from './outboundTransaction';
import type { MatrixSigningIdentitySource } from '../identityRegistry';
import type { FederationFetchTarget } from './federationFetch';
import type { MatrixResolvedServer } from './serverNameResolution';

export interface MatrixOutboundSenderOptions {
  /** Signing identities by server name; the origin's identity signs its transactions. */
  identities: MatrixSigningIdentitySource;
  resolve: (serverName: string) => Promise<MatrixResolvedServer | undefined>;
  /**
   * Where a destination's native endpoint is. Defaults to the name itself on ordinary HTTPS;
   * a test injects its own address.
   */
  resolveNative?: (serverName: string) => Promise<MatrixResolvedServer | undefined>;
  fetch: typeof fetch;
  /** Transport that can present a delegated server name; see `federationFetch.ts`. */
  fetchTarget?: FederationFetchTarget;
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
}

/** How long a destination's answer about the native transport is trusted before asking again. */
export const NATIVE_SUPPORT_TTL_MS = 10 * 60_000;

export class MatrixOutboundSender {
  private readonly identities: MatrixSigningIdentitySource;
  private readonly clients = new Map<string, MatrixFederationClient>();
  /**
   * Whether a destination speaks the native transport, and when that was learned.
   *
   * A local accelerator, rebuilt on restart: a peer that has no native endpoint would otherwise
   * pay a 404 on every batch, and a peer that gains one would never be noticed. Neither answer is
   * authority for anything — it only chooses which request to send first.
   */
  private readonly nativeSupport = new Map<string, { speaks: boolean; checkedAt: number }>();
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
      ...(this.options.policy === undefined ? {} : { policy: this.options.policy }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
    };

    if (this.speaksNative(input.destination)) {
      const native = await client.deliverNativeTransaction(delivery);
      if (native.transport === 'native') {
        this.rememberNative(input.destination, true);
        return native.outcome;
      }
      // The peer answered "no such route": remember that, and reach for the transport it does
      // speak. The same batch, under the same transaction id — a peer that never saw it dedups
      // nothing, and a peer that did see it answers from the record it already wrote.
      this.rememberNative(input.destination, false);
    }
    const result = await client.deliverTransaction(delivery);
    return result.outcome;
  }

  /**
   * Whether to try the native transport first.
   *
   * Unknown destinations try it: Xpod-to-Xpod is the case this exists for, and one 404 is a cheap
   * way to find out. A destination that answered "no" is believed for a while, so Matrix-only peers
   * are not asked again on every batch.
   */
  private speaksNative(destination: string): boolean {
    const remembered = this.nativeSupport.get(destination);
    if (!remembered) return true;
    if (remembered.checkedAt + NATIVE_SUPPORT_TTL_MS <= this.now()) return true;
    return remembered.speaks;
  }

  private rememberNative(destination: string, speaks: boolean): void {
    this.nativeSupport.set(destination, { speaks, checkedAt: this.now() });
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
      ...(this.options.resolveNative === undefined ? {} : { resolveNative: this.options.resolveNative }),
      fetch: this.options.fetch,
      ...(this.options.fetchTarget === undefined ? {} : { fetchTarget: this.options.fetchTarget }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.random === undefined ? {} : { random: this.options.random }),
    });
    this.clients.set(origin, client);
    return client;
  }
}
