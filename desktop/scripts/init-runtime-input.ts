#!/usr/bin/env bun
/**
 * Initialize the explicit desktop runtime-input descriptor + authority document.
 *
 * `desktop build:runtime` requires `--runtime-input <descriptor.json>` and fails
 * closed without it. Nothing in the repository produced that descriptor, so the
 * documented `build:runtime` chain could never run. This is that one initializer.
 *
 * All identity comes from the already-reviewed Bun 1.4.2 pin: the official
 * archive URL and digest, the executable digest, the source commit and the
 * retained originals. A caller may point at a local `--archive` copy; otherwise
 * the pin's own official URL is downloaded once and cached by content digest.
 * No digest, target, version or commit is ever accepted from the caller.
 *
 * Writes go to a temporary directory inside the owned generated root and are
 * promoted only after every document is complete, so an invalid input or a
 * failed download never damages an existing good descriptor.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const BUN_VERSION = '1.4.2';
const BUN_COMMIT = '744846f844374847c902b5e7fd59b4342a51ef99';
const TARGET = 'darwin-arm64';
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Where the producer keeps its own output, relative to the desktop package. */
export const GENERATED_DIRECTORY = path.join('.test-data', 'runtime-input');
/** Checked-in canonical material policy: originals, digests, archive identity. */
export const MATERIALS_DIRECTORY = 'runtime-materials';
const DOWNLOAD_CACHE_DIRECTORY = path.join('.test-data', 'runtime-download-cache');

interface ProvenanceRecord {
  readonly sourcePath: string;
  readonly object: string;
  readonly sha256: string;
  readonly provenance?: { readonly sourceUrl?: string };
}

interface MaterialRecord {
  readonly path: string;
  readonly sha256: string;
  readonly sourceUrl: string;
  readonly kind: 'license' | 'source' | 'assessment';
}

export type RuntimeMode = 'controlled-preview' | 'release';

export interface ManifestFile {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly sourceUrl: string;
  readonly kind: MaterialRecord['kind'];
}

export interface MaterialManifest {
  readonly bunVersion: string;
  readonly target: string;
  readonly sourceCommit: string;
  readonly executableSha256: string;
  readonly fullSourceArchive: {
    readonly name: string;
    readonly sourceUrl: string;
    readonly sha256: string;
    readonly kind: 'source';
  };
  readonly files: readonly ManifestFile[];
}

export interface RuntimeInputOptions {
  readonly repoRoot: string;
  /**
   * Normally derived from the checked-in assessment: `verified` material yields
   * `release`, anything else yields `controlled-preview`. A caller may only ask
   * for `controlled-preview` explicitly; `release` is refused unless the
   * checked-in material set is itself reviewed and verified.
   */
  readonly mode?: RuntimeMode;
  /** Local copy of the official archive; omitted means download from the pin. */
  readonly archive?: string;
  readonly output?: string;
  /** Test seam only; production uses global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface RuntimeInputResult {
  readonly descriptor: string;
  readonly authority: string;
  readonly inputHash: string;
  readonly archiveSource: 'local' | 'pin-download' | 'cache';
}

export interface ReviewedPin {
  readonly provenance: {
    readonly bunCommit: string;
    readonly revision: string;
    readonly tag: string;
    readonly releaseUrl: string;
    readonly compiler: {
      readonly platform: string;
      readonly executableSha256: string;
      readonly officialArchiveUrl: string;
      readonly officialArchiveSha256: string;
    };
  };
  readonly files: readonly ProvenanceRecord[];
}

function pinRoot(repoRoot: string): string {
  return path.join(repoRoot, 'packages/xpod-cli/licenses/javascript/generated', BUN_VERSION);
}

/** Read and validate the reviewed pin; refuses any drifted provenance. */
export function readReviewedPin(repoRoot: string): ReviewedPin {
  const index = JSON.parse(readFileSync(path.join(pinRoot(repoRoot), 'index.json'), 'utf8'));
  const provenance = index?.provenance;
  const compiler = provenance?.compiler;
  if (provenance?.bunCommit !== BUN_COMMIT
    || provenance?.revision !== `${BUN_VERSION}+744846f84`
    || provenance?.tag !== `bun-v${BUN_VERSION}`
    || compiler?.platform !== TARGET
    || !/^[a-f0-9]{64}$/u.test(compiler?.officialArchiveSha256 ?? '')
    || !/^[a-f0-9]{64}$/u.test(compiler?.executableSha256 ?? '')
    || !/^https:\/\/github\.com\/oven-sh\/bun\/releases\/download\/bun-v1\.4\.2\/[A-Za-z0-9._-]+$/u
      .test(compiler?.officialArchiveUrl ?? '')) {
    throw new Error('Bun 1.4.2 provenance pin is not the reviewed identity');
  }
  if (!Array.isArray(index.files)) throw new Error('Bun 1.4.2 pin has no retained originals');
  return { provenance, files: index.files };
}

export function manifestRoot(repoRoot: string): string {
  return path.join(repoRoot, 'desktop', MATERIALS_DIRECTORY);
}

/** Read and structurally validate the checked-in material policy. */
export function readManifest(repoRoot: string): MaterialManifest {
  const manifest = JSON.parse(readFileSync(path.join(manifestRoot(repoRoot), 'manifest.json'), 'utf8'));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)
    || !/^[a-f0-9]{64}$/u.test(manifest?.fullSourceArchive?.sha256 ?? '')
    || !/^https:\/\//u.test(manifest?.fullSourceArchive?.sourceUrl ?? '')) {
    throw new Error('Runtime material manifest is malformed');
  }
  for (const file of manifest.files) {
    if (!['license', 'source', 'relink', 'assessment'].includes(file.kind)
      || !/^https:\/\//u.test(file.sourceUrl) || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error(`Invalid runtime material entry: ${file.path}`);
    }
  }
  return manifest;
}

/** Download-by-URL-and-digest with a persistent cache; the archive is a cache
 * artifact and is never written into the repository. */
async function fetchCached(
  source: { readonly name: string; readonly sourceUrl: string; readonly sha256: string },
  parent: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const cacheRoot = path.join(parent, '..', DOWNLOAD_CACHE_DIRECTORY);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const cached = path.join(cacheRoot, source.name);
  if (existsSync(cached) && sha(readFileSync(cached)) === source.sha256) return readFileSync(cached);
  const response = await fetchImpl(source.sourceUrl,
    { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Material download failed (${source.name}): HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== source.sha256) throw new Error(`Downloaded material digest mismatch: ${source.name}`);
  writeFileSync(cached, bytes, { mode: 0o600 });
  return bytes;
}

/** Fetch the reviewed official archive when no local copy is supplied. The
 * digest is verified here, so a substituted response cannot be used. */
async function fetchOfficial(pin: ReviewedPin, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(pin.provenance.compiler.officialArchiveUrl,
    { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Official Bun archive download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== pin.provenance.compiler.officialArchiveSha256) {
    throw new Error('Downloaded official Bun archive does not match the reviewed digest');
  }
  return bytes;
}

/**
 * Build the descriptor + authority. The assessment is deliberately `pending`:
 * retained originals are genuine build evidence, but qualifying the binary
 * runtime legally is a review decision this producer must never self-certify.
 */
export async function initializeRuntimeInput(options: RuntimeInputOptions): Promise<RuntimeInputResult> {
  const pin = readReviewedPin(options.repoRoot);
  const root = pinRoot(options.repoRoot);
  const compiler = pin.provenance.compiler;
  const output = path.resolve(options.output ?? path.join(options.repoRoot, 'desktop', GENERATED_DIRECTORY));
  // Fail before downloading or staging anything when the destination is not
  // ours to replace. The destination is inspected only, never modified.
  assertReplaceableOutput(output);

  let archiveBytes: Buffer;
  let archiveSource: RuntimeInputResult['archiveSource'];
  if (options.archive) {
    archiveBytes = readFileSync(options.archive);
    archiveSource = 'local';
    if (sha(archiveBytes) !== compiler.officialArchiveSha256) {
      throw new Error('Supplied archive is not the reviewed official Bun 1.4.2 asset');
    }
  } else {
    const cached = path.join(output, 'bun-darwin-aarch64.zip');
    if (existsSync(cached) && sha(readFileSync(cached)) === compiler.officialArchiveSha256) {
      archiveBytes = readFileSync(cached);
      archiveSource = 'cache';
    } else {
      archiveBytes = await fetchOfficial(pin, options.fetchImpl ?? fetch);
      archiveSource = 'pin-download';
    }
  }

  // Everything is written under one owned root, into a sibling staging dir that
  // is promoted only when complete; a failure leaves any previous good output.
  const parent = path.dirname(output);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.runtime-input.staging-${process.pid}-${Date.now()}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path.join(staging, 'bun-darwin-aarch64.zip'), archiveBytes, { mode: 0o600 });

    const materialsRoot = path.join(staging, 'materials');
    mkdirSync(materialsRoot, { recursive: true, mode: 0o700 });

    // The reviewed manifest is the single authority: it names every material, its
    // pinned source URL, its digest, and the full source archive identity.
    const manifest = readManifest(options.repoRoot);
    if (manifest.sourceCommit !== pin.provenance.bunCommit
      || manifest.executableSha256 !== compiler.executableSha256
      || manifest.target !== TARGET || manifest.bunVersion !== BUN_VERSION) {
      throw new Error('Reviewed material manifest does not match the current Bun pin');
    }
    const materials: MaterialRecord[] = [];
    for (const file of manifest.files) {
      const bytes = readFileSync(path.join(manifestRoot(options.repoRoot), file.path));
      if (sha(bytes) !== file.sha256) throw new Error(`Reviewed original digest mismatch: ${file.path}`);
      const relative = path.join('materials', path.basename(file.path));
      writeFileSync(path.join(staging, relative), bytes, { mode: 0o600 });
      materials.push({ path: relative, sha256: file.sha256, sourceUrl: file.sourceUrl, kind: file.kind });
    }

    // The FULL pinned source archive is declared as kind source. It is fetched by
    // URL+digest into the download cache and never committed to the repository.
    const sourceBytes = await fetchCached(manifest.fullSourceArchive, parent,
      options.fetchImpl ?? fetch);
    const sourceRelative = path.join('materials', manifest.fullSourceArchive.name);
    writeFileSync(path.join(staging, sourceRelative), sourceBytes, { mode: 0o600 });
    materials.push({ path: sourceRelative, sha256: manifest.fullSourceArchive.sha256,
      sourceUrl: manifest.fullSourceArchive.sourceUrl, kind: 'source' });

    const assessment = JSON.parse(readFileSync(
      path.join(manifestRoot(options.repoRoot), 'originals', 'assessment.json'), 'utf8'));

    const authority = {
      schemaVersion: 1,
      version: BUN_VERSION,
      target: TARGET,
      sourceCommit: pin.provenance.bunCommit,
      executableSha256: compiler.executableSha256,
      assessment,
      files: materials,
    };
    const authorityBytes = Buffer.from(`${JSON.stringify(authority, null, 2)}\n`);
    writeFileSync(path.join(staging, 'authority.json'), authorityBytes, { mode: 0o600 });

    // ONE checked-in policy drives the mode: a reviewed (verified) assessment
    // produces the release descriptor that stable packaging requires; an
    // unreviewed one can only produce controlled-preview. Callers may opt DOWN
    // to preview but can never assert release without the reviewed original set.
    const verified = assessment.status === 'verified' && typeof assessment.reviewer === 'string'
      && assessment.reviewer.trim() !== '';
    const requested = options.mode ?? (verified ? 'release' : 'controlled-preview');
    if (requested === 'release' && !verified) {
      throw new Error('Release mode requires a reviewed verified material assessment');
    }
    const descriptor = {
      mode: requested,
      target: TARGET,
      archive: 'bun-darwin-aarch64.zip',
      authority: 'authority.json',
      authoritySha256: sha(authorityBytes),
    };
    writeFileSync(path.join(staging, 'runtime-input.json'),
      `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });

    return promote(staging, output, parent, sha(authorityBytes), archiveSource);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Decide whether `destination` may be replaced, WITHOUT modifying it.
 *
 * A missing or empty directory may be initialized. A non-empty directory may be
 * replaced only when it is recognizably this producer's own previous output:
 * a canonical `runtime-input.json` descriptor plus `authority.json` that parse,
 * match the current pin/target, agree on the authority digest, and use the
 * expected relative paths. Anything else — user files, symlinks, foreign
 * layouts — is refused untouched. This does not hash large old materials: the
 * descriptor/authority identity is enough to recognize ownership, and stale
 * archives are re-verified by the existing pin checks when regenerated.
 */
function assertReplaceableOutput(destination: string): void {
  if (!existsSync(destination)) return;
  const stats = lstatSync(destination);
  if (stats.isSymbolicLink()) throw new Error('Refusing to replace a symlinked output directory');
  if (!stats.isDirectory()) throw new Error('Refusing to replace a non-directory output path');

  const entries = readdirSync(destination);
  if (entries.length === 0) return;

  const expected = new Set(['runtime-input.json', 'authority.json', 'bun-darwin-aarch64.zip', 'materials']);
  const foreign = entries.filter(entry => !expected.has(entry));
  if (foreign.length > 0) {
    throw new Error(`Refusing to replace unrecognized output directory (foreign entries: ${foreign.join(', ')})`);
  }
  for (const required of ['runtime-input.json', 'authority.json']) {
    if (!entries.includes(required)) {
      throw new Error(`Refusing to replace unrecognized output directory (missing ${required})`);
    }
  }
  const descriptorPath = path.join(destination, 'runtime-input.json');
  const authorityPath = path.join(destination, 'authority.json');
  if (lstatSync(descriptorPath).isSymbolicLink() || lstatSync(authorityPath).isSymbolicLink()) {
    throw new Error('Refusing to replace an output whose descriptor or authority is a symlink');
  }

  let descriptor: { mode?: unknown; target?: unknown; authority?: unknown; authoritySha256?: unknown };
  try {
    descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  } catch {
    throw new Error('Refusing to replace unrecognized output directory (unreadable descriptor)');
  }
  const authorityBytes = readFileSync(authorityPath);
  if (descriptor.target !== TARGET
    || (descriptor.mode !== 'release' && descriptor.mode !== 'controlled-preview')
    || descriptor.authority !== 'authority.json'
    || descriptor.authoritySha256 !== sha(authorityBytes)) {
    throw new Error('Refusing to replace unrecognized output directory (descriptor identity mismatch)');
  }
  let authority: { schemaVersion?: unknown; version?: unknown; target?: unknown; sourceCommit?: unknown };
  try {
    authority = JSON.parse(authorityBytes.toString());
  } catch {
    throw new Error('Refusing to replace unrecognized output directory (unreadable authority)');
  }
  if (authority.schemaVersion !== 1 || authority.version !== BUN_VERSION
    || authority.target !== TARGET || authority.sourceCommit !== BUN_COMMIT) {
    throw new Error('Refusing to replace unrecognized output directory (authority identity mismatch)');
  }
}

function promote(staging: string, output: string, parent: string, inputHash: string,
  archiveSource: RuntimeInputResult['archiveSource']): RuntimeInputResult {
  // Ownership is established BEFORE anything is renamed or deleted.
  assertReplaceableOutput(output);
  const previous = path.join(parent, `.runtime-input.previous-${process.pid}-${Date.now()}`);
  const hadPrevious = existsSync(output);
  if (hadPrevious) renameSync(output, previous);
  try {
    renameSync(staging, output);
  } catch (error) {
    if (hadPrevious) renameSync(previous, output);
    throw error;
  }
  if (hadPrevious) rmSync(previous, { recursive: true, force: true });
  return { descriptor: path.join(output, 'runtime-input.json'),
    authority: path.join(output, 'authority.json'), inputHash, archiveSource };
}

function parseCli(argv: string[]): RuntimeInputOptions {
  // Only these options exist. Anything else (including a retired option) is
  // refused rather than silently ignored.
  const allowed = new Set(['--archive', '--output', '--mode']);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !allowed.has(key) || value === undefined || value.startsWith('--')) {
      throw new Error(`usage: init-runtime-input [--archive <official.zip>] [--output <dir>] [--mode controlled-preview]${key ? ` (unknown option: ${key})` : ''}`);
    }
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const mode = values.get('--mode');
  if (mode !== undefined && mode !== 'controlled-preview' && mode !== 'release') {
    throw new Error('unknown --mode; expected controlled-preview or release');
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  return {
    repoRoot,
    archive: values.get('--archive') ? path.resolve(values.get('--archive')!) : undefined,
    output: values.get('--output') ? path.resolve(values.get('--output')!) : undefined,
    mode: mode as RuntimeMode | undefined,
  };
}

if (import.meta.main) {
  try {
    const result = await initializeRuntimeInput(parseCli(process.argv.slice(2)));
    // Path and source only: no material bytes, digests or review text echoed.
    console.log(JSON.stringify({ ok: true, descriptor: result.descriptor, archiveSource: result.archiveSource }));
  } catch (error) {
    console.error(`[init-runtime-input] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
