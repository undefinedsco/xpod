import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { valid as validSemver } from 'semver';
const { inspectTarballBuffer, sha512Integrity } = createRequire(import.meta.url)('./workspace-package-payload.cjs');
import { MODULE_API_VERSION, MODULE_CATALOG, MODULE_TARGETS } from '../packages/xpod-cli/src/module-catalog';

export type Reference = { path: string; sha256: string };
type Product = 'client' | 'cli' | typeof MODULE_CATALOG[number]['id'];
export interface ReleaseInput {
  schemaVersion: 1;
  sourceSha: string;
  runHeadSha: string;
  checkoutSha: string;
  products: Array<{ product: Product; version: string; target?: string; archive: Reference; receipt: Reference }>;
}
/** Hash-binding envelope only. Gate files preserve existing producer schemas. */
export interface ProductInputReceipt {
  schemaVersion: 1;
  kind: 'independent-product-input';
  sourceSha: string;
  package: string;
  version: string;
  target?: string;
  archiveSHA256: string;
  integrity: string;
  gates: Partial<Record<'source' | 'native' | 'legal' | 'consumer', Reference>>;
  runtimeClient?: { version: string; evidence: Reference };
}
const shaPattern = /^[a-f0-9]{40}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
export function exactVersion(value: unknown): value is string {
  // ModuleStore accepts exact versions without build metadata. Do not normalize
  // v-prefixes, whitespace or invalid numeric prerelease identifiers silently.
  return typeof value === 'string' && !value.includes('+') && validSemver(value) === value;
}
function fail(message: string): never { throw new Error(`Independent release: ${message}`); }
function bytes(reference: Reference, root: string): Buffer {
  if (!reference || !hashPattern.test(reference.sha256) || !reference.path) fail('invalid file reference');
  const file = path.resolve(root, reference.path);
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) fail('regular original file required');
  const data = readFileSync(file);
  if (createHash('sha256').update(data).digest('hex') !== reference.sha256) fail('file hash mismatch');
  return data;
}
function json(data: Buffer): any { return JSON.parse(data.toString('utf8')); }
function dependency(value: unknown): void {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /^(?:workspace:|file:|link:|portal:|\.\.?[\\/]|\/|[A-Za-z]:|\\)/iu.test(value)
    || /@(?:workspace:|file:|link:|portal:)/iu.test(value)) fail('local/test dependency is not publishable');
}
function dependencyOverrides(value: unknown): void {
  if (typeof value === 'string') { dependency(value); return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid dependency override');
  for (const [selector, nested] of Object.entries(value)) {
    if (selector !== selector.trim() || /(?:^|@)(?:workspace:|file:|link:|portal:)/iu.test(selector)) fail('local/test override selector is not publishable');
    dependencyOverrides(nested);
  }
}
/** Validate only the publishing manifest; nested source manifests remain original material. */
export function assertPublicationDependencies(manifest: Record<string, any>): void {
  // The root is the publishing manifest. Nested distributions are original
  // material: their development metadata is not an installer dependency edge.
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const value of Object.values(manifest[field] ?? {})) {
      dependency(value);
    }
  }
  for (const field of ['overrides', 'resolutions']) {
    if (manifest[field] !== undefined) dependencyOverrides(manifest[field]);
  }
}
/** A local admission planner. It validates bound receipts, never grants legal clearance or publishes. */
export function planIndependentRelease(input: ReleaseInput, root = process.cwd()) {
  if (input?.schemaVersion !== 1 || !shaPattern.test(input.sourceSha) || !shaPattern.test(input.runHeadSha) || input.checkoutSha !== input.sourceSha || !Array.isArray(input.products) || !input.products.length) fail('exact source and products required');
  const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(import.meta.dir, '..'), encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== input.checkoutSha) fail('actual checkout source mismatch');
  const seen = new Set<string>();
  const accepted = input.products.map(item => {
    const module = MODULE_CATALOG.find(row => row.id === item.product);
    if (!module && item.product !== 'client' && item.product !== 'cli') fail('unknown product');
    if (!exactVersion(item.version)) fail('exact independent version required');
    const target = module ? MODULE_TARGETS.find(row => `${row.platform}-${row.arch}` === item.target) : undefined;
    if (module ? !target : item.target !== undefined) fail('invalid product target');
    const name = module ? `${module.packagePrefix}-${item.target}` : `@undefineds.co/xpod-${item.product}`;
    const key = module ? `${item.product}:${item.target}` : item.product;
    if (seen.has(key)) fail('duplicate product target');
    seen.add(key);
    const archiveBytes = bytes(item.archive, root);
    const inspected = inspectTarballBuffer(archiveBytes);
    const manifest = inspected.manifest;
    const integrity = sha512Integrity(archiveBytes);
    if (manifest.name !== name || manifest.version !== item.version || (manifest.private !== undefined && manifest.private !== false)) fail('publish package identity/private producer rejected');
    assertPublicationDependencies(manifest);
    if (module && (manifest.xpodModule?.id !== module.id || manifest.xpodModule?.platform !== target!.platform
      || manifest.xpodModule?.arch !== target!.arch || manifest.xpodModule?.cliApiVersion !== MODULE_API_VERSION)) fail('module target ABI mismatch');
    if (module) {
      const rows = manifest.xpodModule.files;
      const files = inspected.entries.filter((entry: any) => entry.type === 'file' && entry.path !== 'package/package.json');
      if (manifest.xpodModule.schemaVersion !== 1 || !Array.isArray(rows) || rows.length !== files.length
        || new Set(rows.map((row: any) => row.path)).size !== rows.length
        || !rows.some((row: any) => row.path === manifest.xpodModule.entry)) fail('module inventory mismatch');
      for (const file of files) {
        const row = rows.find((row: any) => 'package/' + row.path === file.path);
        if (!row || row.sha256 !== file.sha256 || row.size !== file.size || row.mode !== file.mode) fail('module inventory mismatch');
      }
    }
    const receipt = json(bytes(item.receipt, root));
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'independent-product-input' || receipt.sourceSha !== input.sourceSha
      || receipt.package !== name || receipt.version !== item.version || receipt.target !== item.target
      || receipt.archiveSHA256 !== item.archive.sha256 || receipt.integrity !== integrity) fail('receipt identity mismatch');
    const gates = module ? ['source', 'native', 'legal', 'consumer'] : ['source', 'legal', 'consumer'];
    const blockers: Array<{ gate: string; reason: string }> = [];
    const runtimeClosureMaterials = inspected.entries.filter((entry: any) => entry.type === 'file'
      && (entry.path === 'package/provenance/identity-dedup.json'
        || /^package\/provenance\/packages\/[^/]+\.json$/u.test(entry.path)
        || /^package\/provenance\/(?:cli-producer-materials|module-source-kit)\.json$/u.test(entry.path)))
      .map((entry: any) => ({ path: entry.path, sha256: entry.sha256 }));
    if (module) blockers.push({ gate: 'runtime-closure', reason: 'physical-runtime-closure-unverified: inventory binds original bytes; a standalone producer dependency-graph/runtime-resolution admission verifier is still required' });
    const evidenceFiles: Array<{ gate: string; reference: Reference; schemaVersion: unknown; kind: unknown; status: unknown }> = [];
    for (const gate of gates) {
      const reference = receipt.gates?.[gate];
      if (!reference) { blockers.push({ gate, reason: 'Required product admission evidence is missing' }); continue; }
      const evidence = json(bytes(reference, root));
      evidenceFiles.push({ gate, reference, schemaVersion: evidence.schemaVersion, kind: evidence.kind, status: evidence.status });
      // These are existing producer material formats, not release approvals. Never
      // interpret arbitrary passed/legalAccepted/nativeAccepted booleans as authority.
      if (gate === 'source' && evidence.sourceAuthority) {
        if (evidence.sourceAuthority.sourceCommit !== input.sourceSha || evidence.sourceAuthority.dirty !== false) fail('source authority mismatch');
      }
      if (gate === 'legal' && evidence.schemaVersion === 1 && evidence.status === 'original-material-collection'
        && evidence.legalClearance === false) {
        blockers.push({ gate, reason: 'Original terms inventory explicitly does not confer legal clearance' });
      } else if (gate === 'native' && evidence.status === 'material-integrity-verified' && evidence.externalAdmission === 'pending') {
        blockers.push({ gate, reason: 'Native materials are internally bound; external admission remains pending' });
      } else {
        blockers.push({ gate, reason: 'No authoritative independent release admission verifier exists for this evidence format' });
      }
    }
    return { key, name, item, manifest, receipt, blockers, evidenceFiles, integrity, runtimeClosureMaterials };
  });
  const client = accepted.find(row => row.key === 'client');
  const cli = accepted.find(row => row.key === 'cli');
  if (cli && !exactVersion(cli.manifest.dependencies?.['@undefineds.co/xpod-client'])) fail('CLI requires exact runtime client version');
  if (cli && cli.manifest.dependencies?.['@undefineds.co/xpod-client'] !== (client?.item.version ?? cli.receipt.runtimeClient?.version)) fail('CLI requires exact runtime client version');
  if (cli && !client) {
    const existing = json(bytes(cli.receipt.runtimeClient?.evidence, root));
    if (existing.status !== 'passed' || existing.package !== '@undefineds.co/xpod-client' || existing.version !== cli.manifest.dependencies['@undefineds.co/xpod-client']
      || existing.transport !== 'registry' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(existing.integrity ?? '')) fail('existing registry client evidence required');
  }
  return {
    schemaVersion: 1, kind: 'independent-release-plan', sourceSha: input.sourceSha, checkoutSha: input.checkoutSha, runHeadSha: input.runHeadSha,
    status: 'blocked', published: false, releaseQualified: false,
    buildDag: [
      { id: 'cli-build-tools', needs: [] },
      { id: 'client-build', needs: ['cli-build-tools'] },
      { id: 'cli-build-and-producer-materials', needs: ['client-build'] },
      { id: 'afs-client-build', needs: ['cli-build-and-producer-materials'] },
      { id: 'css-producer', needs: ['afs-client-build'] },
      { id: 'api-producer', needs: ['afs-client-build'] },
      { id: 'afs-producer', needs: ['cli-build-and-producer-materials'] },
    ],
    // Build artifacts can feed module producers before any registry mutation.
    products: accepted.map(row => ({ id: row.key, package: row.name, version: row.item.version,
      target: row.item.target, archive: row.item.archive, integrity: row.integrity, receipt: row.item.receipt,
      status: 'blocked', blockers: row.blockers, evidence: row.evidenceFiles, runtimeClosureMaterials: row.runtimeClosureMaterials,
      needs: row.key === 'cli' && client ? ['client'] : [],
      acceptance: { transport: 'registry', version: row.item.version },
      stages: ['publish-immutable-version', 'verify-registry-integrity', 'verify-exact-consumer', 'promote-product-tag'],
    })),
    limitations: ['Input receipt is a hash binding envelope, not an admission authority. Existing producer receipts are retained as evidence only.',
      'Formal independent source/native/legal/consumer admission adapters remain required; this plan cannot authorize publication.',
      'No publication, tag mutation, root-service release or shared RC action is executed.'],
  };
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) fail('one input JSON path required');
    const file = path.resolve(process.argv[2]);
    process.stdout.write(JSON.stringify(planIndependentRelease(json(readFileSync(file)), path.dirname(file)), null, 2) + '\n');
  } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
