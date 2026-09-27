/**
 * Composing the outbound path: resolving a destination, signing as its origin, queueing.
 *
 * The three pieces exist separately and each is tested on its own — `serverNameResolution`
 * decides where a server name is reached, `outboundSender` picks the identity that signs,
 * `outboundQueue` owns what is still owed. This is where a deployment assembles them, so the
 * container has one thing to register and a test can assemble the same thing without a live
 * container.
 *
 * Delivery needs an origin it can sign as. A deployment with no identity of its own cannot
 * sign anything, so the caller gets `undefined` rather than a queue whose every batch would
 * be abandoned.
 */
import { MatrixOutbox, InMemoryMatrixOutboundStore, type MatrixOutboxOptions } from './outboundQueue';
import { MatrixOutboundSender } from './outboundSender';
import { MatrixServerNameResolver, type MatrixSrvRecord } from './serverNameResolution';
import type { MatrixSigningIdentitySource } from '../identityRegistry';

export interface MatrixOutboundDelivery {
  resolver: MatrixServerNameResolver;
  sender: MatrixOutboundSender;
  outbox: MatrixOutbox;
}

export interface MatrixOutboundDeliveryOptions {
  identities: MatrixSigningIdentitySource;
  fetch: typeof fetch;
  /**
   * A resolver the deployment already built. Sharing one keeps its cache warm across everything
   * that reaches a peer — delivery and key fetching resolve the same names — instead of each
   * asking `.well-known` for itself.
   */
  resolver?: MatrixServerNameResolver;
  /** SRV lookup, consulted only when `.well-known` is unavailable. */
  resolveSrv?: (name: string) => Promise<readonly MatrixSrvRecord[] | undefined>;
  now?: () => number;
  random?: () => number;
  /** Passed through to the queue, mostly so tests can retry without waiting. */
  retryRefused?: MatrixOutboxOptions['retryRefused'];
}

export function createMatrixOutboundDelivery(options: MatrixOutboundDeliveryOptions): MatrixOutboundDelivery {
  const resolver = options.resolver ?? new MatrixServerNameResolver({
    fetch: options.fetch,
    ...(options.resolveSrv === undefined ? {} : { resolveSrv: options.resolveSrv }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  const sender = new MatrixOutboundSender({
    identities: options.identities,
    resolve: async serverName => await resolver.resolve(serverName),
    fetch: options.fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  const outbox = new MatrixOutbox({
    store: new InMemoryMatrixOutboundStore(),
    send: async input => await sender.send(input),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retryRefused === undefined ? {} : { retryRefused: options.retryRefused }),
  });
  return { resolver, sender, outbox };
}

/**
 * Adapt a `node:dns` SRV answer to the resolver's shape: Node names the target `name`,
 * while the specification's `m.server` and the resolver call it a target host.
 */
export function nodeSrvRecords(
  records: readonly { name: string; port: number; priority?: number; weight?: number }[],
): MatrixSrvRecord[] {
  return records.map(record => ({
    target: record.name,
    port: record.port,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
    ...(record.weight === undefined ? {} : { weight: record.weight }),
  }));
}
