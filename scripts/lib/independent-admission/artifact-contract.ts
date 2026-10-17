/** Shared contract for the central collector and capability-axis verifiers.
 * These types cannot issue authority. The collector must own the runtime
 * capability store; serialized manifests and caller assertions are not issuers. */
import type { NativeFile, NativeMaterialIndex } from '../physical-module-native';
import type { GitHubOriginObservation } from './github-origin';

type ReadonlyMaterial<T> = T extends readonly (infer Item)[] ? readonly ReadonlyMaterial<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyMaterial<T[Key]> } : T;

/** Existing native schema is authoritative. Native stage source revisions are
 * independent of the containing module product source revision. */
export interface NativeAdmissionMaterials {
  readonly index: ReadonlyMaterial<NativeMaterialIndex>;
  readonly officialOrigins: readonly {
    readonly binary: Readonly<NativeFile>;
    readonly stage: 'input-observation' | 'build' | 'test';
    readonly observation: GitHubOriginObservation;
  }[];
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
  /** Original producer evidence selected from the observed outer ZIP. */
  readProducerOriginal(path: string, maximumBytes: number): Buffer;
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
