import { createRequire } from 'node:module';
import { collectedArtifactView } from './artifact-collector';
const { satisfies, valid } = createRequire(import.meta.url)('semver') as typeof import('semver');
const fail = (message: string): never => { throw new Error('Independent consumer profiles: ' + message); };
interface Manifest {
  exports?: unknown;
  peerDependencies?: Record<string, unknown>;
  peerDependenciesMeta?: Record<string, { optional?: unknown }>;
}

/** Pure declaration analysis only; this function grants no artifact custody or
 * consumer result. Public exports are tested conservatively as one complete set,
 * never guessed to depend on a particular optional peer. */
export function deriveConsumerProfileDeclarations(manifest: Manifest) {
  const exports = manifest.exports;
  if (!exports || Array.isArray(exports) || (typeof exports !== 'string' && typeof exports !== 'object')) return fail('public exports required');
  const keys = typeof exports === 'object' && !Array.isArray(exports) ? Object.keys(exports) : [];
  const subpaths = keys.some(key => key.startsWith('.')) ? keys : ['.'];
  if (!subpaths.includes('.') || subpaths.some(key => key !== '.' && !key.startsWith('./'))) fail('invalid public export map');
  const peers = Object.entries(manifest.peerDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, range]) => {
    if (typeof range !== 'string' || !range) return fail('invalid peer dependency range');
    return { name, range, optional: manifest.peerDependenciesMeta?.[name]?.optional === true };
  });
  return {
    peers,
    profiles: ([['base-without-optional-peers', ['.'], peers.filter(peer => !peer.optional)],
      ['all-public-exports-with-peers', subpaths.sort(), peers]] as const).map(([profile, selectedExports, selectedPeers]) => ({
      profile, exports: selectedExports, peers: selectedPeers,
      matrix: (['node', 'bun'] as const).flatMap(runtime => (['esm', 'cjs'] as const).map(module => ({ runtime, module }))),
    })),
    consumerVerified: false as const,
    scope: 'Base success does not verify all public exports or optional-peer capabilities',
  };
}

/** Reads declarations only from a real central artifact capability. Peer ranges
 * are constraints, never install specifications. Each selected exact version
 * must come from another collected artifact capability; missing pins block that
 * profile. Custody is not source/legal/consumer admission: complete peer
 * admission remains a separate prerequisite. The central collector currently
 * lacks an arbitrary-peer issuer (including independently sourced peers). */
export function planClientConsumerProfiles(clientCapability: unknown, peerCapabilities: readonly unknown[] = []) {
  const client = collectedArtifactView(clientCapability);
  if (!client || client.identity.package !== '@undefineds.co/xpod-client' || client.identity.target !== undefined) return fail('real collected client capability required');
  const manifest = JSON.parse(client.readMember('package.json', 1024 * 1024).toString());
  if (manifest.name !== client.identity.package || manifest.version !== client.identity.version) fail('client manifest identity mismatch');
  const declarations = deriveConsumerProfileDeclarations(manifest);
  const peers = new Map<string, NonNullable<ReturnType<typeof collectedArtifactView>>>();
  for (const capability of peerCapabilities) {
    const peer = collectedArtifactView(capability);
    if (!peer) return fail('real collected peer capability required');
    if (!declarations.peers.some(row => row.name === peer.identity.package)) fail('undeclared peer capability');
    if (peers.has(peer.identity.package)) fail('duplicate peer capability');
    if (!valid(peer.identity.version)) fail('peer capability requires exact semver version');
    peers.set(peer.identity.package, peer);
  }
  return {
    identity: { ...client.identity }, consumerVerified: false as const,
    scope: declarations.scope,
    profiles: declarations.profiles.map(profile => {
      const pending = profile.exports.filter(subpath => subpath.includes('*')).map(subpath => `Unexpanded public export pattern: ${subpath}`);
      const installs = profile.peers.flatMap(peer => {
        const capability = peers.get(peer.name);
        if (!capability) { pending.push(`Missing collected exact peer artifact: ${peer.name}`); return []; }
        if (!satisfies(capability.identity.version, peer.range)) return fail('peer capability version does not satisfy declared range');
        return [{ package: peer.name, version: capability.identity.version, integrity: capability.identity.integrity,
          archiveSha256: capability.identity.archiveSha256, sourceSha: capability.identity.sourceSha }];
      });
      return { ...profile, installs, pending,
        status: pending.length ? 'blocked' as const : 'planned-not-executed' as const,
        consumerVerified: false as const };
    }),
  };
}
