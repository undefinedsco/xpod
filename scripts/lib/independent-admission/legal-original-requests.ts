import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { installedLegalOriginalViews } from './legal-installed-originals';
import { registryLegalLockEntries } from './legal-registry-originals';

/** Acquisition planning only. Neither coordinates nor this list confer custody.
 * Installed physical originals are preferred; only actual packed scopes can
 * request fixed registry acquisition. No dev dependency universe is requested. */
export function requiredRegistryLegalOriginalCoordinates(input: { artifact: unknown; source: unknown; legalSourceMaterials?: unknown }): readonly { name: string; version: string }[] {
  const artifact = collectedArtifactView(input.artifact), source = derivedSourceView(input.source);
  if (!artifact || !source || source.sourceSha !== artifact.identity.sourceSha || !source.trackedPaths.includes('bun.lock')) return [];
  const locks = registryLegalLockEntries(source.readTracked('bun.lock'));
  const installed = installedLegalOriginalViews(source, input.legalSourceMaterials);
  const required = new Map<string, { name: string; version: string }>();
  const add = (name: unknown, version: unknown, physical: boolean, manifestSha?: string) => {
    if (typeof name !== 'string' || typeof version !== 'string' || !locks.has(name + '@' + version)) return;
    if (physical && installed.some(original => original.name === name && original.version === version && original.members.some(row => row.path === 'package.json' && row.sha256 === manifestSha))) return;
    required.set(name + '@' + version, { name, version });
  };
  for (const member of artifact.members) {
    if (/^provenance\/packages\/[^/]+\.json$/u.test(member.path) && member.bytes <= 1024 * 1024) {
      const row = JSON.parse(artifact.readMember(member.path, 1024 * 1024).toString());
      const manifest = artifact.members.find(member => member.path === row.path + '/package.json');
      add(row.name, row.version, true, manifest?.sha256);
    } else if (/(?:^|\/)licenses\/index\.json$/u.test(member.path) && member.bytes <= 1024 * 1024) {
      const index = JSON.parse(artifact.readMember(member.path, 1024 * 1024).toString());
      for (const row of Array.isArray(index.packages) ? index.packages : []) add(row.name, row.version, false);
    } else if (member.path === 'provenance/compiler.json' && member.bytes <= 65536) {
      const compiler = JSON.parse(artifact.readMember(member.path, 65536).toString());
      if (compiler.package === 'typescript') add('typescript', compiler.version, false);
    }
  }
  return Object.freeze([...required.values()].map(row => Object.freeze(row)));
}
