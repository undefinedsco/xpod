/**
 * Which identity signs an event.
 *
 * The custody decision (docs/matrix-collaboration-decisions.md, "签名身份与密钥归属")
 * makes the signing subject the *participant* identity: a room can hold events from
 * several servers, and each event must be signed by the server named in its `sender`.
 * This registry is what the store consults before signing, so an event from a server
 * this deployment holds no key for fails loudly instead of being signed under
 * somebody else's name — a silently mis-signed event is worse than a refused write,
 * because a verifier cannot tell it apart from a forgery.
 */
import { EventIntegrityError } from './protocol/eventIntegrity';
import type { MatrixServiceIdentity } from './protocol/serviceIdentity';
import type { MatrixSigningIdentityProvider } from './signingKeyStore';

/** The identity for a server name, or `undefined` when this store signs nothing. */
export interface MatrixSigningIdentitySource {
  identityFor(serverName: string): Promise<MatrixServiceIdentity | undefined>;
}

export interface MatrixSigningIdentityRegistryOptions {
  /**
   * The identity this deployment itself serves, when it has one. It is registered
   * under its own server name and never answers for another name.
   */
  identity?: MatrixServiceIdentity;
  /** Key-set-backed providers, one per server name this deployment holds keys for. */
  providers?: readonly { serverName: string; provider: MatrixSigningIdentityProvider }[];
}

export class MatrixSigningIdentityRegistry implements MatrixSigningIdentitySource {
  private readonly byServerName = new Map<string, MatrixSigningIdentityProvider>();
  private readonly identity?: MatrixServiceIdentity;

  public constructor(options: MatrixSigningIdentityRegistryOptions = {}) {
    this.identity = options.identity;
    for (const entry of options.providers ?? []) {
      if (!entry.serverName.trim()) throw new EventIntegrityError('A signing identity needs a server name');
      this.byServerName.set(entry.serverName, entry.provider);
    }
    // A key-set provider registered for the deployment's own name takes precedence
    // over the static identity: that is the shape a migration onto Pod-held keys has.
  }

  /** The server names this registry can sign for. */
  public serverNames(): string[] {
    const names = new Set(this.byServerName.keys());
    if (this.identity) names.add(this.identity.serverName);
    return [ ...names ].sort();
  }

  /**
   * The identity that signs for `serverName`.
   *
   * Throws when a registry is in use and the name is unknown: the caller asked for a
   * signature it cannot produce, and falling back to another server's key would
   * attribute the event to a server that never signed it.
   */
  public async identityFor(serverName: string): Promise<MatrixServiceIdentity | undefined> {
    const provider = this.byServerName.get(serverName);
    if (provider) return provider.identity();
    if (this.identity && this.identity.serverName === serverName) return this.identity;
    throw new EventIntegrityError(`No Matrix signing identity is configured for server name ${serverName}`);
  }
}

/** A registry holding exactly one identity, or none. */
export function matrixSigningIdentityRegistry(options: MatrixSigningIdentityRegistryOptions = {}): MatrixSigningIdentityRegistry {
  return new MatrixSigningIdentityRegistry(options);
}
