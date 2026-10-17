import type { CollectedArtifactIdentity } from './artifact-contract';
/** Agreed consumer shape only. A central source/origin observer must issue the
 * private capability and expose portableSourceMaterialView; this file provides
 * neither a registration function nor a way to restore authority from JSON. */
export interface PortableSourceGraphView {
  readonly identity: Readonly<CollectedArtifactIdentity>;
  readonly outputs: readonly {
    readonly path: string; readonly bytes: number; readonly sha256: string;
    /** Complete actual bundler input set, including zero-output contributors. */
    readonly inputs: readonly {
      readonly path: string; readonly bytes: number; readonly sha256: string;
      readonly sourcePath?: string;
      readonly packageRoot?: string;
    }[];
  }[];
}
