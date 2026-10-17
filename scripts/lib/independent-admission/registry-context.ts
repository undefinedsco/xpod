import { verifyRegistryProduct } from '../../verify-registry-product';
import { collectedArtifactView } from './artifact-collector';
import type { CollectedArtifactIdentity } from './artifact-contract';

declare const registryObservationBrand: unique symbol;
export interface RegistryArtifactObservation { readonly [registryObservationBrand]: true }
export interface RegistryArtifactView {
  readonly identity: Readonly<CollectedArtifactIdentity>;
  readonly registry: 'https://registry.npmjs.org/';
  readonly observedAt: string;
  readonly metadata: Readonly<{ bytes: number; sha256: string }>;
  readonly archive: Readonly<{ bytes: number; sha256: string; integrity: string }>;
}
const observations = new WeakMap<object, RegistryArtifactView>();

/** Fixed GET-only production transport. An injectable test readback report,
 * serialized approval, or registry supplied by a candidate cannot issue this
 * capability. This proves registry byte identity, never consumer or clearance. */
export async function observeRegistryArtifactIfPublished(artifact: unknown): Promise<RegistryArtifactObservation | undefined> {
  const collected = collectedArtifactView(artifact);
  if (!collected) throw new Error('Registry observation requires a collected artifact capability');
  const identity = collected.identity;
  if (identity.target !== undefined || !['@undefineds.co/xpod-client', '@undefineds.co/xpod-cli'].includes(identity.package)
    || identity.archiveBytes > 8 * 1024 ** 2) throw new Error('Registry observation product or budget unsupported');
  const result = await verifyRegistryProduct({ registry: 'https://registry.npmjs.org/', package: identity.package,
    version: identity.version, expected: { sha256: identity.archiveSha256, integrity: identity.integrity, bytes: identity.archiveBytes } },
  { timeoutMs: 30_000, limits: { packedBytes: 8 * 1024 ** 2, expandedBytes: 16 * 1024 ** 2, members: 20000 } });
  if (result.status === 'not-published-blocked') return undefined;
  const capability = Object.freeze({}) as RegistryArtifactObservation;
  observations.set(capability, Object.freeze({ identity: Object.freeze({ ...identity }), registry: 'https://registry.npmjs.org/',
    observedAt: new Date().toISOString(), metadata: Object.freeze({ ...result.metadata }), archive: Object.freeze({ ...result.archive }) }));
  return capability;
}

export async function observeRegistryArtifact(artifact: unknown): Promise<RegistryArtifactObservation> {
  const observation = await observeRegistryArtifactIfPublished(artifact);
  if (!observation) throw new Error('Exact artifact version is not published');
  return observation;
}

export function registryArtifactView(value: unknown): RegistryArtifactView | undefined {
  return value !== null && typeof value === 'object' ? observations.get(value) : undefined;
}
