import { portableSourceMaterialView } from './source-execution';
import { collectedArtifactView } from './artifact-collector';
import type { CollectedArtifactMember, DerivedSourceView } from './artifact-contract';
import { moduleSourceMaterialView } from './module-source-admission';
import { registryLegalLockEntries } from './legal-registry-originals';

/** Original bytes observed before and after the controlled immutable-lock build.
 * This scope does not attest an upstream registry archive or its contents. */
export interface InstalledLegalOriginalView {
  readonly scope: 'observed-installed-source';
  readonly sourceSha: string;
  readonly root: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly members: readonly CollectedArtifactMember[];
  readMember(name: string): Buffer;
  readMemberRange(name: string, offset: number, length: number): Buffer;
}

/** No public issuer or callback: only the operational source issuer's private
 * capability can supply installed bytes, and Git supplies the immutable lock. */
export function installedLegalOriginalViews(source: DerivedSourceView, capability: unknown, artifactCapability?: unknown): readonly InstalledLegalOriginalView[] {
  const module = moduleSourceMaterialView(capability);
  const artifact = collectedArtifactView(artifactCapability), portable = portableSourceMaterialView(artifactCapability);
  const boundPortable = artifact && portable && portable.identity.sourceSha === source.sourceSha
    && portable.identity.archiveSha256 === artifact.identity.archiveSha256
    && portable.identity.package === artifact.identity.package && portable.identity.version === artifact.identity.version;
  const material = module?.sourceSha === source.sourceSha ? module : boundPortable ? portable.dependencyOriginals : undefined;
  if (!material || !source.trackedPaths.includes('bun.lock')) return [];
  const locks = registryLegalLockEntries(source.readTracked('bun.lock'));
  const rows = material.dependencyRows;
  const result: InstalledLegalOriginalView[] = [];
  for (const row of rows) {
    if (row.kind !== 'file' || !row.path.endsWith('/package.json') || !row.path.startsWith('node_modules/')) continue;
    if (row.bytes === undefined || row.bytes > 65536) continue;
    const root = row.path.slice(0, -'/package.json'.length);
    // A manifest directly within a package root, never an arbitrary nested fixture.
    const leaf = root.slice(root.lastIndexOf('/node_modules/') + '/node_modules/'.length);
    if (root.includes('/node_modules/') ? !/^(@[^/]+\/)?[^/]+$/u.test(leaf) : !/^node_modules\/(?:@[^/]+\/)?[^/]+$/u.test(root)) continue;
    let manifest: { name?: unknown; version?: unknown };
    try { manifest = JSON.parse(material.readDependencyOriginal(row.path, 65536).toString('utf8')); } catch { continue; }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
    const packageLeaf = root.includes('/node_modules/') ? leaf : root.slice('node_modules/'.length);
    if (manifest.name !== packageLeaf) continue;
    const integrity = locks.get(manifest.name + '@' + manifest.version);
    if (!integrity) continue;
    const members: CollectedArtifactMember[] = [];
    for (const file of rows) {
      if (file.kind !== 'file' || !file.path.startsWith(root + '/')) continue;
      const relative = file.path.slice(root.length + 1);
      if (relative.split('/').includes('node_modules') || file.bytes === undefined || file.mode === undefined || !file.sha256) continue;
      members.push({ path: relative, bytes: file.bytes, sha256: file.sha256, mode: file.mode });
    }
    const names = new Set(members.map(file => file.path));
    result.push(Object.freeze({ scope: 'observed-installed-source' as const, sourceSha: source.sourceSha,
      root, name: manifest.name, version: manifest.version, integrity, members: Object.freeze(members),
      readMember(name: string) { if (!names.has(name)) throw Error('Unknown installed original'); return material.readDependencyOriginal(root + '/' + name, 1024 * 1024); },
      readMemberRange(name: string, offset: number, length: number) { if (!names.has(name)) throw Error('Unknown installed original'); return material.readDependencyOriginalRange(root + '/' + name, offset, length); },
    }));
  }
  return Object.freeze(result);
}
