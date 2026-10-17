import type { ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
import type { CollectedArtifactIdentity, CollectedArtifactMember } from './artifact-contract';
import type { ClientConsumerObservation } from './consumer-context';

/** Cross-job transport contains coordinates and original byte references only.
 * No field in this schema is an approval, permit, or restorable capability. */
export interface RegistryConsumerOriginalManifest {
  readonly schemaVersion: 1;
  readonly kind: 'registry-installed-product-consumer-originals';
  readonly product: Readonly<CollectedArtifactIdentity>;
  readonly sourceSha: string;
  readonly consumer: Readonly<{ runHeadSha: string; runId: number; runAttempt: number; target?: string }>;
  readonly tools: readonly Readonly<CollectedArtifactIdentity>[];
  readonly result: Readonly<CollectedArtifactMember>;
  readonly originals: readonly Readonly<CollectedArtifactMember>[];
}
export interface GitHubRegistryInstalledProductConsumerInput {
  readonly artifact: unknown;
  readonly consumerRun: ArtifactAcquisitionInput;
  readonly client?: unknown;
  readonly peers?: readonly unknown[];
  readonly dependencies?: readonly unknown[];
  readonly evidenceDirectory: string;
  readonly token?: string;
}
export type GitHubRegistryInstalledProductConsumerObserver =
  (input: GitHubRegistryInstalledProductConsumerInput) => Promise<ClientConsumerObservation>;

/** File/name convention shared by the fixed producer and reviewed observer.
 * Product identity must separately come from a live central collector handle. */
export function registryConsumerArtifactName(input: {
  module: 'client' | 'cli' | 'api' | 'css' | 'afs'; target?: string;
  sourceSha: string; runId: number; runAttempt: number;
}): string {
  if (!['client', 'cli', 'api', 'css', 'afs'].includes(input.module)
    || !/^[a-f0-9]{40}$/u.test(input.sourceSha) || ![input.runId, input.runAttempt].every(value => Number.isSafeInteger(value) && value > 0)
    || (['client', 'cli'].includes(input.module) ? input.target !== undefined : !/^(?:linux|darwin)-(?:x64|arm64)$/u.test(input.target ?? ''))) {
    throw Error('Exact registry consumer artifact coordinates required');
  }
  return `xpod-registry-consumer-${input.module}-${input.target ?? 'portable'}-${input.sourceSha}-${input.runId}-${input.runAttempt}`;
}
