import type { GitHubOriginObservation, GitHubOriginFacts } from './github-origin';
import type { CollectedArtifactMember } from './artifact-contract';

declare const nativeOriginalsBrand: unique symbol;
/** Central original-byte custody only. This is deliberately not a normal
 * product capability and grants no native, source, ABI or legal approval. */
export interface CollectedNativeOriginalsCapability { readonly [nativeOriginalsBrand]: true }
/** Cleanup/observation timing only; this hook cannot issue or restore custody. */
export interface NativeArchiveObservationBudget {
  check(): void;
  remainingMs(): number;
}
export interface CollectedNativeOriginalsView {
  readonly origin: GitHubOriginObservation;
  readonly originFacts: GitHubOriginFacts;
  readonly members: readonly Readonly<CollectedArtifactMember>[];
  readonly archive: Readonly<{ bytes: number; sha256: string }>;
  readonly metadataOriginals: readonly Readonly<{ name: string; endpoint: string; data: Buffer }>[];
  /** Small JSON/receipt originals only. Whole native ZIPs/binaries are not read
   * through this <=8MiB compatibility surface. */
  readOriginal(path: string, maximumBytes: number): Buffer;
  /** Single range <=64KiB. Source tar readers have an independent fixed
   * <=512MiB/member budget, not the 16MiB Mach-O header observation budget. */
  readOriginalRange(path: string, offset: number, length: number): Buffer;
  withArchiveFile<T>(operation: (input: { readonly path: string; readonly identity: Readonly<{ bytes: number; sha256: string }> }) => Promise<T>, budget?: NativeArchiveObservationBudget): Promise<T>;
}
export interface NativeAdmissionOriginalCollectionInput {
  readonly githubOrigin: GitHubOriginObservation;
  readonly acquisitionRoot: string;
}
/** Signature contract only; implementations must use one private issuer and
 * reject serialized/native-product substitutions before creating projections. */
export interface NativeAdmissionOriginalCollector {
  collectNativeAdmissionOriginals(input: NativeAdmissionOriginalCollectionInput): Promise<CollectedNativeOriginalsCapability>;
  nativeOriginalsView(value: unknown): CollectedNativeOriginalsView | undefined;
}
