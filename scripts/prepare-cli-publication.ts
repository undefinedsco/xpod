import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertPublicationDependencies, exactVersion } from './independent-release-plan';
const { inspectTarballBuffer, sha512Integrity } = createRequire(import.meta.url)('./workspace-package-payload.cjs');

type Original = { path: string; sha256: string };
type Archive = Original & { integrity: string };
export interface PublicationInput {
  schemaVersion: 1;
  client: Archive;
  cli: Archive;
  sourceManifests: { client: Original; cli: Original };
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Repository source tool only. Not copied by check-cli-package or shipped as an npm CLI command.
 * Read-only preparation of normal Bun workspace pack originals, never publication authority. */
export function preparePublication(input: PublicationInput, inputRoot = process.cwd()) {
  if (input?.schemaVersion !== 1 || !input.sourceManifests) throw new Error('Exact publication inputs required');
  const originals: Array<{ path: string; sha256: string }> = [];
  const read = (reference: Original): Buffer => {
    if (!reference || typeof reference.path !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Invalid original reference');
    const file = path.resolve(inputRoot, reference.path), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Regular original required');
    const bytes = readFileSync(file);
    if (sha256(bytes) !== reference.sha256) throw new Error('Original digest mismatch');
    originals.push({ path: file, sha256: reference.sha256 });
    return bytes;
  };
  const archive = (reference: Archive, name: string) => {
    const bytes = read(reference), integrity = sha512Integrity(bytes);
    if (integrity !== reference.integrity) throw new Error('Original archive SRI mismatch');
    const inspected = inspectTarballBuffer(bytes), manifest = inspected.manifest;
    if (manifest.name !== name || !exactVersion(manifest.version) || (manifest.private !== undefined && manifest.private !== false)) throw new Error('Invalid publication package identity/version');
    assertPublicationDependencies(manifest);
    return { manifest, members: inspected.entries as Array<{ path: string; type: string; content: Buffer; size: number; sha256: string }>, archive: { path: path.resolve(inputRoot, reference.path), sha256: reference.sha256, integrity, bytes: bytes.length },
      files: inspected.entries.filter((entry: { type: string }) => entry.type === 'file').map((entry: { path: string; size: number; mode: number; sha256: string }) => ({ path: entry.path, bytes: entry.size, mode: entry.mode, sha256: entry.sha256 })) };
  };
  const client = archive(input.client, '@undefineds.co/xpod-client');
  const cli = archive(input.cli, '@undefineds.co/xpod-cli');
  const clientSourceBytes = read(input.sourceManifests.client), cliSourceBytes = read(input.sourceManifests.cli);
  const clientSource = JSON.parse(clientSourceBytes.toString('utf8'));
  const cliSource = JSON.parse(cliSourceBytes.toString('utf8'));
  if (clientSource.name !== client.manifest.name || clientSource.version !== client.manifest.version
    || cliSource.name !== cli.manifest.name || cliSource.version !== cli.manifest.version) throw new Error('Source/publication identity mismatch');
  const edge = cli.manifest.dependencies?.[client.manifest.name];
  if (!exactVersion(edge) || edge !== client.manifest.version) throw new Error('CLI requires the exact supplied runtime client version');
  if (typeof cliSource.dependencies?.[client.manifest.name] !== 'string') throw new Error('Original CLI runtime client edge missing');
  const indexExport = cli.manifest.exports?.['./producer-materials'];
  if (typeof indexExport !== 'string' || !indexExport.startsWith('./')) throw new Error('CLI embedded client publication index missing');
  const member = (name: string) => {
    const entry = cli.members.find(entry => entry.path === name && entry.type === 'file');
    if (!entry) throw new Error('CLI embedded client publication member missing');
    return entry;
  };
  const indexEntry = member('package/' + indexExport.slice(2));
  const index = JSON.parse(indexEntry.content.toString('utf8'));
  if (index.schemaVersion !== 1 || index.producer?.name !== cli.manifest.name || index.producer?.version !== cli.manifest.version
    || !Array.isArray(index.runtimeClients) || !Array.isArray(index.files)) throw new Error('Invalid CLI producer index');
  const rows = index.runtimeClients.filter((row: any) => row.name === client.manifest.name);
  if (rows.length !== 1 || rows[0].version !== client.manifest.version) throw new Error('CLI embedded client identity mismatch');
  const indexed = (relative: unknown) => {
    if (typeof relative !== 'string' || !relative) throw new Error('Invalid embedded publication reference');
    // Exact lookup in the already validated tar: no path normalization or traversal fallback.
    const entry = member(path.posix.dirname(indexEntry.path) + '/' + relative);
    const declarations = index.files.filter((row: any) => row.path === relative);
    if (declarations.length !== 1 || declarations[0].sha256 !== entry.sha256 || declarations[0].bytes !== entry.size) throw new Error('CLI producer inventory binding mismatch');
    return entry;
  };
  const embedded = indexed(rows[0].publication?.archive), inventoryEntry = indexed(rows[0].publication?.inventory);
  if (embedded.sha256 !== client.archive.sha256 || sha512Integrity(embedded.content) !== client.archive.integrity) throw new Error('CLI embedded client bytes differ from supplied client archive');
  const publishedInventory = JSON.parse(inventoryEntry.content.toString('utf8'));
  const verifyFiles = (files: any, relative: boolean) => {
    if (!Array.isArray(files) || files.length !== client.files.length || new Set(files.map((row: any) => row.path)).size !== files.length) throw new Error('Embedded client file inventory mismatch');
    for (const row of files) {
      const actual = client.files.find((file: { path: string }) => file.path === (relative ? 'package/' + row.path : row.path));
      if (!actual || actual.sha256 !== row.sha256 || actual.bytes !== row.bytes) throw new Error('Embedded client file inventory mismatch');
    }
  };
  if (publishedInventory.schemaVersion !== 1) throw new Error('Invalid embedded client publication inventory');
  verifyFiles(publishedInventory.files, false); verifyFiles(rows[0].files, true);
  const embeddedClient = { index: { path: indexEntry.path, sha256: indexEntry.sha256 },
    archive: { path: embedded.path, sha256: embedded.sha256, integrity: client.archive.integrity },
    inventory: { path: inventoryEntry.path, sha256: inventoryEntry.sha256 } };

  // Preserve and recheck original bytes; source workspace protocols are evidence, not installer edges.
  for (const original of originals) if (sha256(readFileSync(original.path)) !== original.sha256) throw new Error('Original changed during preparation');
  return { schemaVersion: 1, kind: 'cli-publication-preparation', toolScope: 'repository-only; not an installed npm CLI command', status: 'prepared-not-published',
    embeddedClientIdentityVerified: true,
    client: { name: client.manifest.name, version: client.manifest.version, archive: client.archive, files: client.files },
    cli: { name: cli.manifest.name, version: cli.manifest.version, archive: cli.archive, files: cli.files, embeddedClient,
      runtimeClient: { name: client.manifest.name, version: edge, archiveSha256: client.archive.sha256, integrity: client.archive.integrity } },
    sourceManifests: { client: { path: path.resolve(inputRoot, input.sourceManifests.client.path), sha256: input.sourceManifests.client.sha256, originalBytesBase64: clientSourceBytes.toString('base64'), original: clientSource },
      cli: { path: path.resolve(inputRoot, input.sourceManifests.cli.path), sha256: input.sourceManifests.cli.sha256, originalBytesBase64: cliSourceBytes.toString('base64'), original: cliSource } },
    inputContract: 'Supply normal package-manager workspace pack originals; this tool performs no manifest normalization or archive rewrite',
    limitations: ['Manifest and original-byte bindings only; full source/build provenance and registry readback require their separate evidence.'],
    published: false, legalQualified: false, nativeQualified: false, releaseQualified: false };
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage (repository source tool only): bun scripts/prepare-cli-publication.ts <bound-original-input.json>');
    const file = path.resolve(process.argv[2]);
    process.stdout.write(JSON.stringify(preparePublication(JSON.parse(readFileSync(file, 'utf8')), path.dirname(file)), null, 2) + '\n');
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
