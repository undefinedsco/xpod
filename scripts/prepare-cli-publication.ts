import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { execFileSync } from 'node:child_process';
import canonicalHostSources from '../packages/xpod-cli/scripts/canonical-host-sources.json';
import { assertPublicationDependencies, exactVersion } from './independent-release-plan';
const { inspectTarballBuffer, sha512Integrity } = createRequire(import.meta.url)('./workspace-package-payload.cjs');

type Original = { path: string; sha256: string };
type Archive = Original & { integrity: string };
export interface PublicationInput {
  schemaVersion: 1;
  canonicalSourceSha?: string;
  client: Archive;
  cli: Archive;
  sourceManifests: { client: Original; cli: Original };
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type PublicationMember = { path: string; type: string; content: Buffer };

/** Inspect parsed original members, never a producer's claimed pass flag.
 * This checks installation edges and payload shape, not arbitrary JavaScript behavior.
 * The build's canonical-input guard remains a separate required provenance check. */
export function assertCliPublicationClosure(manifest: Record<string, any>, members: PublicationMember[]): void {
  assertPublicationDependencies(manifest);
  const isCli = manifest.name === '@undefineds.co/xpod-cli';
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!(isCli && field === 'dependencies' && name === '@undefineds.co/xpod-client')
        && !(field === 'peerDependencies' && ['@undefineds.co/xpod-cli', '@undefineds.co/xpod-client'].includes(manifest.name) && name === '@inrupt/solid-client-authn-node' && manifest.peerDependenciesMeta?.[name]?.optional === true && manifest.peerDependencies[name] === '^3.1.1')) {
        throw new Error('Unexpected CLI/client runtime dependency: ' + name);
      }
    }
  }
  // These fields can inject or replace installer edges outside dependencies.
  for (const field of ['bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions']) {
    if (manifest[field] && Object.keys(manifest[field]).length) throw new Error('Unexpected publication installer field: ' + field);
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[hook]) throw new Error('Unexpected publication installation hook: ' + hook);
  }
  const files = new Map(members.filter(entry => entry.type === 'file').map(entry => [entry.path, entry]));
  const target = (value: unknown, exportTarget = true): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object') { for (const nested of Object.values(value)) target(nested, exportTarget); return; }
    if (typeof value !== 'string' || (exportTarget && !value.startsWith('./')) || /^(?:[\\/]|[a-z]+:)/iu.test(value) || value.includes('\\') || value.includes('*') || value.split('/').some(part => part === '..')
      || !files.has('package/' + value.replace(/^\.\//u, ''))) throw new Error('Publication public entry missing or unsafe');
  };
  if (manifest.browser !== undefined) throw new Error('Browser publication mappings are unsupported');
  target(manifest.exports);
  target(manifest.typesVersions, false);
  target(typeof manifest.bin === 'string' ? manifest.bin : manifest.bin ?? {}, false);
  for (const field of ['main', 'module', 'types']) if (manifest[field]) target(manifest[field], false);
  for (const entry of files.values()) {
    const magic = entry.content.subarray(0, 4).toString('hex');
    if (/\.(?:node|dll|dylib|so(?:\.\d+)*|exe)$/iu.test(entry.path)
      || /(?:^|\/)node_modules\//u.test(entry.path)
      || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)
      || entry.content.subarray(0, 2).toString() === 'MZ') throw new Error('Unexpected native or vendored runtime payload: ' + entry.path);
  }
}

/** A caller-selected Git revision is the authority, never sourceAuthority.sourceCommit.
 * No network, build or producer pass flag participates in this comparison. */
export function verifyCanonicalPublicationInputs(members: PublicationMember[], index: any, indexPath: string, sourceSha: string) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('Exact trusted canonical source revision required');
  const root = path.resolve(import.meta.dir, '..');
  const git = (file: string) => execFileSync('git', ['show', sourceSha + ':' + file], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const prefix = path.posix.dirname(indexPath) + '/';
  const bound = (relative: string) => {
    const entry = members.find(row => row.type === 'file' && row.path === prefix + relative);
    const rows = index.files.filter((row: any) => row.path === relative);
    if (!entry || rows.length !== 1 || rows[0].sha256 !== sha256(entry.content) || rows[0].bytes !== entry.content.length) throw new Error('Canonical material binding mismatch');
    return entry.content;
  };
  const declared = JSON.parse(bound('source/scripts/canonical-host-sources.json').toString());
  const trusted = JSON.parse(git('packages/xpod-cli/scripts/canonical-host-sources.json').toString());
  if (JSON.stringify(declared) !== JSON.stringify(trusted) || JSON.stringify(trusted) !== JSON.stringify(canonicalHostSources)) throw new Error('Canonical host rules differ from trusted repository');
  // Every canonical host file is compared, including files absent from this metafile.
  for (const file of trusted) {
    if (!bound('source/repository/src/' + file).equals(git('src/' + file))) throw new Error('Canonical host source differs from trusted repository');
  }
  const checks: Array<{ metafile: string; sourceInputs: number }> = [];
  for (const metafile of [index.clientMetafile, ...(index.outputMetafile ? [index.outputMetafile] : [])]) {
    if (typeof metafile !== 'string') throw new Error('Canonical metafile missing');
    const meta = JSON.parse(bound(metafile).toString());
    if (!meta.inputs || !Object.keys(meta.inputs).length || !meta.outputs) throw new Error('Canonical metafile inputs missing');
    let sourceInputs = 0;
    for (const [file, raw] of Object.entries(meta.inputs)) {
      const row = raw as any;
      if (!/^src\/(?:client|npm-entry|core|module-[^/]+|manifest)\.ts$/u.test(file) && !/^src\/(?:lib|commands)\/[^/]+\.ts$/u.test(file)) throw new Error('Unexpected canonical bundler input: ' + file);
      const content = bound('source/' + file);
      if (row.bytes !== content.length || !content.equals(git('packages/xpod-cli/' + file))) throw new Error('Bundler source differs from trusted repository');
      for (const edge of row.imports ?? []) {
        if (edge.external && !isBuiltin(edge.path) && !/^@undefineds\.co\/xpod-client(?:\/session)?$/u.test(edge.path)) throw new Error('Unexpected canonical external import');
        if (!edge.external && !Object.prototype.hasOwnProperty.call(meta.inputs, edge.path)) throw new Error('Omitted canonical bundler input');
      }
      sourceInputs++;
    }
    checks.push({ metafile, sourceInputs });
  }
  for (const [file, hash] of [['client.cjs', index.clientPayloads?.cjsSHA256], ['client.mjs', index.clientPayloads?.esmSHA256], ...(index.outputMetafile ? [['output.mjs', index.outputPayloads?.esmSHA256]] : [])]) {
    const entry = members.find(row => row.path === 'package/dist/' + file && row.type === 'file');
    if (!entry || sha256(entry.content) !== hash) throw new Error('Canonical output binding mismatch');
  }
  return { sourceSha, checks, canonicalHostFiles: trusted.length, scope: 'Git source and preserved metafile bindings; no rebuild proof; core npm-entry metafile is not preserved by current producer', completeRuntimeClosure: false };
}

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
    assertCliPublicationClosure(manifest, inspected.entries);
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
  const canonicalInputs = input.canonicalSourceSha ? verifyCanonicalPublicationInputs(cli.members, index, indexEntry.path, input.canonicalSourceSha) : null;
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
    canonicalInputs, archiveBoundaryChecked: true, registryQualified: false, sourceQualified: false,
    client: { name: client.manifest.name, version: client.manifest.version, archive: client.archive, files: client.files },
    cli: { name: cli.manifest.name, version: cli.manifest.version, archive: cli.archive, files: cli.files, embeddedClient,
      runtimeClient: { name: client.manifest.name, version: edge, archiveSha256: client.archive.sha256, integrity: client.archive.integrity } },
    sourceManifests: { client: { path: path.resolve(inputRoot, input.sourceManifests.client.path), sha256: input.sourceManifests.client.sha256, originalBytesBase64: clientSourceBytes.toString('base64'), original: clientSource },
      cli: { path: path.resolve(inputRoot, input.sourceManifests.cli.path), sha256: input.sourceManifests.cli.sha256, originalBytesBase64: cliSourceBytes.toString('base64'), original: cliSource } },
    inputContract: 'Supply normal package-manager workspace pack originals; this tool performs no manifest normalization or archive rewrite',
    limitations: ['Original archive entry, installer-edge and embedded-client bindings checked; arbitrary JavaScript behavior, full source/build provenance and registry readback require separate evidence.'],
    published: false, legalQualified: false, nativeQualified: false, releaseQualified: false };
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage (repository source tool only): bun scripts/prepare-cli-publication.ts <bound-original-input.json>');
    const file = path.resolve(process.argv[2]);
    process.stdout.write(JSON.stringify(preparePublication(JSON.parse(readFileSync(file, 'utf8')), path.dirname(file)), null, 2) + '\n');
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
