import path from 'node:path';
import { inspectBunHelperPrefix } from './legal-bun-helpers';
import { createHash } from 'node:crypto';
import type { CollectedArtifactView } from './artifact-contract';
import { registryLegalOriginalView } from './legal-registry-originals';
function fail(message: string): never { throw Error('Legal bundle materials: ' + message); }
const safe = (name: unknown): name is string => typeof name === 'string' && Boolean(name) && !name.startsWith('/')
  && !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..');

/** Real bundle notice indices share the existing javascript-notices format.
 * Object retention, prefix bytes and original inputs are checked separately
 * from the producer authority needed to attest graph completeness. */
export function inspectBundleLegalMaterials(artifact: CollectedArtifactView, originals: readonly unknown[] = []): { pending: string[]; indices: number } {
  const members = new Map(artifact.members.map(member => [member.path, member]));
  const pending: string[] = []; let indices = 0;
  const resolveObject = (indexPath: string, row: any) => {
    if (!row || typeof row.object !== 'string' || row.object.includes('\\') || row.object.startsWith('/')
      || typeof row.sourcePath !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)) fail('invalid notice object');
    const name = path.posix.normalize(path.posix.join(path.posix.dirname(indexPath), row.object));
    if (!safe(name)) fail('notice object outside archive');
    const member = members.get(name);
    if (!member || (!member.bytes && row.sourcePath !== 'generated-prefix.js') || member.sha256 !== row.sha256) fail('retained original object differs: ' + name);
  };
  const indicesToRead = artifact.members.filter(row => /(?:^|\/)licenses\/(?:[^/]+\/)*index\.json$/u.test(row.path));
  if (indicesToRead.length > 128) fail('bundle index count budget exceeded');
  for (const member of indicesToRead) {
    const index = JSON.parse(artifact.readMember(member.path, 1024 * 1024).toString());
    if (index.schemaVersion !== 1 || !Array.isArray(index.inputs) || !Array.isArray(index.packages) || !index.cliSha256) continue;
    indices++;
    if (!/^[a-f0-9]{64}$/u.test(index.cliSha256) || index.inputs.length > 20000 || index.packages.length > 20000) fail('invalid bundle inventory');
    const output = artifact.members.find(row => row.sha256 === index.cliSha256);
    if (!output) fail('actual bundle digest absent');
    const packages = new Map<string, any>();
    for (const pkg of index.packages) {
      if (!safe(pkg.root) || packages.has(pkg.root) || typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || !Array.isArray(pkg.files)) fail('invalid bundle package');
      packages.set(pkg.root, pkg);
      for (const row of pkg.files) resolveObject(member.path, row);
      if (pkg.sourceAuthority) resolveObject(member.path, pkg.sourceAuthority);
      const original = originals.map(registryLegalOriginalView).find(view => view?.sourceSha === artifact.identity.sourceSha && view.name === pkg.name && view.version === pkg.version);
      if (!original) pending.push('Immutable original issuer required for bundle package: ' + pkg.name + '@' + pkg.version);
      else {
        const manifest = original.members.find(row => row.path === 'package.json');
        if (manifest?.sha256 !== pkg.packageJsonSha256) pending.push('Bundled package manifest differs from registry original: ' + pkg.name + '@' + pkg.version);
        for (const input of index.inputs.filter((row: any) => row.packageRoot === pkg.root)) {
          if (!safe(input.path) || !input.path.startsWith(pkg.root + '/')) fail('bundle input outside owner');
          const upstream = original.members.find(row => row.path === input.path.slice(pkg.root.length + 1));
          if (!upstream || upstream.sha256 !== input.sha256 || upstream.bytes !== input.bytes) pending.push('Bundle input differs from original: ' + input.path);
        }
      }
    }
    const seen = new Set<string>();
    for (const input of index.inputs) {
      if (!safe(input.path) || seen.has(input.path) || !/^[a-f0-9]{64}$/u.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0
        || !Number.isFinite(input.bytesInOutput) || input.bytesInOutput < 0 || (input.packageRoot && !packages.has(input.packageRoot))) fail('invalid or uncovered bundle input');
      seen.add(input.path);
    }
    if (index.generated) {
      const generated = index.generated;
      if (!Array.isArray(generated.files) || !Number.isSafeInteger(generated.prefixBytes) || generated.prefixBytes < 0 || generated.prefixBytes > output.bytes
        || !/^[a-f0-9]{64}$/u.test(generated.prefixSha256)) fail('invalid generated prefix');
      for (const row of generated.files) resolveObject(member.path, row);
      const prefix = generated.files.find((row: any) => row.sourcePath === 'generated-prefix.js');
      if (!prefix || prefix.sha256 !== generated.prefixSha256) fail('generated prefix original binding differs');
      if (!artifact.readMemberRange) pending.push('Bounded actual bundle prefix reader required: ' + output.path);
      else {
        const hash = createHash('sha256');
        for (let offset = 0; offset < generated.prefixBytes; offset += 65536) {
          const length = Math.min(65536, generated.prefixBytes - offset), bytes = artifact.readMemberRange(output.path, offset, length);
          if (bytes.length !== length) fail('truncated bundle prefix'); hash.update(bytes);
        }
        if (hash.digest('hex') !== generated.prefixSha256) fail('actual generated bundle prefix differs');
      }
      if (generated.prefixBytes > 65536 || !artifact.readMemberRange) pending.push('Bounded Bun helper mapping prefix required: ' + output.path);
      else pending.push(...inspectBunHelperPrefix(artifact, member.path, generated, artifact.readMemberRange(output.path, 0, generated.prefixBytes), originals).pending);
    }
    pending.push('Observed complete bundle input graph and scoped grant coverage required: ' + output.path);
  }
  return { pending: [...new Set(pending)], indices };
}
