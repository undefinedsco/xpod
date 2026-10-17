/** Shared contract for the central collector and capability-axis verifiers.
 * These types cannot issue authority. The collector must own the runtime
 * capability store; serialized manifests and caller assertions are not issuers. */
import type { NativeFile, NativeMaterialIndex } from '../physical-module-native';
import type { GitHubOriginObservation } from './github-origin';

type ReadonlyMaterial<T> = T extends readonly (infer Item)[] ? readonly ReadonlyMaterial<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyMaterial<T[Key]> } : T;

/** Custody belongs to the central collector. A copied stage JSON or arbitrary
 * local raw directory cannot construct any of these in an issued material view. */
export type NativeOriginalCustody = {
  readonly original: Readonly<NativeFile>;
  readonly observation: GitHubOriginObservation;
} & (
  { readonly kind: 'artifact-archive' }
  | { readonly kind: 'artifact-member'; readonly memberPath: string }
  | { readonly kind: 'job-log'; readonly endpoint: string }
);

/** References to the actual accept.py final/metadata/stage originals. Loader,
 * glibc, SDK and runtime semantics are checked from these bytes by the adapter,
 * never represented as an abiPassed assertion. Missing mac observations remain
 * missing; an architecture header is not a substitute for this record. */
export interface NativeRuntimeAbiMaterials {
  readonly binary: Readonly<NativeFile>;
  readonly target: string;
  readonly final: Readonly<NativeFile>;
  readonly metadata: Readonly<NativeFile>;
  readonly stages: readonly {
    readonly name: string;
    readonly receipt: Readonly<NativeFile>;
    readonly raw: Readonly<NativeFile>;
  }[];
  readonly originalCustody: readonly NativeOriginalCustody[];
}

/** Existing native schema is authoritative. Native stage source revisions are
 * independent of the containing module product source revision. */
export interface NativeAdmissionMaterials {
  readonly index: ReadonlyMaterial<NativeMaterialIndex>;
  readonly officialOrigins: readonly {
    readonly binary: Readonly<NativeFile>;
    readonly stage: 'input-observation' | 'build' | 'test';
    readonly observation: GitHubOriginObservation;
  }[];
  readonly runtimeAbi?: readonly NativeRuntimeAbiMaterials[];
  /** Only index/source-kit registered references may be read. Implementations
   * bound size, reject links/escapes and recheck original hashes on every read. */
  readProductOriginal(reference: Readonly<NativeFile>, maximumBytes: number): Buffer;
  readStageOriginal(reference: Readonly<NativeFile>, maximumBytes: number): Buffer;
  readSourceOriginal(sourceRoot: string, reference: Readonly<NativeFile>, maximumBytes: number): Buffer;
}

declare const collectedArtifactBrand: unique symbol;
export interface CollectedArtifactCapability { readonly [collectedArtifactBrand]: true }
declare const derivedSourceBrand: unique symbol;
export interface DerivedSourceCapability { readonly [derivedSourceBrand]: true }
export interface DerivedSourceView {
  readonly sourceSha: string;
  readonly trackedPaths: readonly string[];
  readTracked(path: string): Buffer;
}
declare const nativeMaterialBrand: unique symbol;
export interface NativeMaterialCapability { readonly [nativeMaterialBrand]: true }
export interface NativeMaterialView {
  readonly identity: CollectedArtifactIdentity;
  readonly productRoot: string;
  readonly materialsRoot: string;
  readonly indexPath: string;
  readonly indexSha256: string;
  readonly status: 'material-integrity-verified';
  readonly externalAdmission: 'pending';
  /** Absent until the central collector binds registered original readers and
   * independently observed native producer capabilities. Never from JSON. */
  readonly admissionMaterials?: NativeAdmissionMaterials;
}
export interface CollectedArtifactIdentity {
  readonly sourceSha: string;
  readonly package: string;
  readonly version: string;
  readonly target?: string;
  readonly archiveSha256: string;
  readonly integrity: string;
  readonly archiveBytes: number;
}
export interface CollectedArtifactMember {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
}
export interface CollectedArtifactView {
  readonly identity: CollectedArtifactIdentity;
  readonly members: readonly CollectedArtifactMember[];
  readonly producerOriginals: readonly CollectedArtifactMember[];
  /** Rechecks the member's bound bytes and returns a copy; no path guessing. */
  readMember(path: string, maximumBytes: number): Buffer;
  /** Bounded random access to the same fully hashed immutable member. This
   * carries custody only; format and ABI policy remain in their shared adapters. */
  readMemberRange?(path: string, offset: number, length: number): Buffer;
  /** Original producer evidence selected from the observed outer ZIP. */
  readProducerOriginal(path: string, maximumBytes: number): Buffer;
}
/** Metadata for the exact archive issued by the central collector. Persisting
 * this view does not persist its private publication/material authority. */
export interface PublicationMaterialView {
  readonly origin: GitHubOriginObservation;
  readonly identity: CollectedArtifactIdentity;
  readonly producer: Readonly<{
    sourceSha: string; runHeadSha: string; event: string; headBranch: string;
    workflowPath: string; workflowSourceSha256: string;
    runId: number; runAttempt: number; artifactId: number; artifactSha256: string; jobId: number;
  }>;
  readonly producerReceipt: CollectedArtifactMember;
  readonly originals: readonly CollectedArtifactMember[];
  readonly archive: Readonly<{ bytes: number; sha256: string; integrity: string }>;
  readOriginal(path: string, maximumBytes: number): Buffer;
}

export interface RuntimeClosureFacts {
  readonly physicalInventoryVerified: boolean;
  readonly runtimeImportsVerified: boolean;
  readonly dataAndNativeResolutionVerified: boolean;
  readonly packageIdentityDeduplicated: boolean;
  readonly artifactCustodyVerified: boolean;
  readonly runtimeClosureVerified: boolean;
}
export interface RuntimeClosureResult {
  readonly status: 'pending' | 'verified';
  readonly reason: string;
  readonly pending: readonly string[];
  readonly facts: RuntimeClosureFacts;
}
