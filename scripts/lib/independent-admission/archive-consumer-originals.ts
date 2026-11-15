import type { ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
import type { CollectedArtifactIdentity, CollectedArtifactMember } from './artifact-contract';
import type { ClientConsumerObservation } from './consumer-context';
import { registryConsumerArtifactName } from './registry-consumer-originals';
/** Separate byte transport for matching-host, exact collected archive consumers.
 * This is not the postpublish registry schema and contains no recoverable cap. */
export interface ArchiveProductConsumerOriginalManifest {
  readonly schemaVersion: 1;
  readonly kind: 'archive-product-consumer-originals';
  readonly stage: 'prepublish';
  readonly transport: 'collected-product-archives';
  readonly product: Readonly<CollectedArtifactIdentity>;
  readonly sourceSha: string;
  readonly consumer: Readonly<{runHeadSha:string;runId:number;runAttempt:number;target?:string}>;
  readonly tools: readonly Readonly<CollectedArtifactIdentity>[];
  readonly result: Readonly<CollectedArtifactMember>;
  readonly originals: readonly Readonly<CollectedArtifactMember>[];
}
export interface ArchiveInstalledProductConsumerInput {
  readonly artifact: unknown;
  readonly client?: unknown;
  readonly peers?: readonly unknown[];
  readonly dependencies?: readonly unknown[];
  readonly peerPlan?: unknown;
  readonly stage: 'prepublish';
  readonly evidenceDirectory: string;
}
export interface GitHubArchiveProductConsumerInput {
  readonly artifact: unknown;
  readonly consumerRun: ArtifactAcquisitionInput;
  readonly client?: unknown;
  readonly peers?: readonly unknown[];
  readonly dependencies?: readonly unknown[];
  readonly peerPlan?: unknown;
  readonly evidenceDirectory: string;
  readonly token?: string;
}
/** Implementations must use the existing consumer WeakMap issuer after actual
 * archive installation, full fixed Node/Bun probes, closure and cleanup. They
 * issue stage=prepublish, registryInstallVerified=false; metadata cannot mint it. */
export interface ArchiveProductConsumerObservers {
  preflightArchiveInstalledProductConsumer(input:Omit<ArchiveInstalledProductConsumerInput,'stage'|'evidenceDirectory'>):Readonly<{maximumDurationMs:number}>;
  observeArchiveInstalledProductConsumer(input:ArchiveInstalledProductConsumerInput):Promise<ClientConsumerObservation>;
  observeGitHubArchiveProductConsumer(input:GitHubArchiveProductConsumerInput):Promise<ClientConsumerObservation>;
}
export function archiveConsumerArtifactName(input:Parameters<typeof registryConsumerArtifactName>[0]):string {
  return registryConsumerArtifactName(input).replace(/^xpod-registry-consumer-/u,'xpod-archive-consumer-');
}
