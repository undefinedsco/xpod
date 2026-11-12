/**
 * Produce and then CONSUME the packaged `api` capability for the desktop bundle.
 *
 * Two distinct steps, because the canonical producer requires a CLEAN checkout and
 * the desktop build rewrites versions before staging the runtime:
 *
 *   1. `prepareApiCapability()` runs ONCE, before any version rewrite, and drives
 *      the ONE existing producer in `scripts/api-module-producer.py` (which runs
 *      the normal `packages/xpod-api` entrypoints: build, controlled Inngest
 *      original materials, native-material, notices, `stage`, `pack`). Only
 *      `packPhysicalModule()` writes `xpodModule`. The result is written to a
 *      canonical derived path keyed by the source SHA.
 *
 *   2. `consumeApiCapability()` runs later, from a possibly dirty tree. It NEVER
 *      re-runs or re-installs anything: it re-verifies the recorded receipt, the
 *      actual checkout SHA, the archive bytes, and the manifest binding, then
 *      returns the unpacked package root.
 *
 * The public CI CLI cannot be reused verbatim (it requires an exact Actions
 * `GITHUB_WORKFLOW_REF`), and it deliberately has NO environment bypass. The
 * desktop therefore goes through a dedicated programmatic entry that accepts an
 * explicit identity as structured input.
 *
 * A prepared product is `controlled-preview`: NOT a public module release
 * qualification. The desktop release gate qualifies the archive separately.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { t as listTar, x as extractTar } from 'tar'

export interface PreparedApiCapability {
  id: 'api'
  /** Canonical derived directory: `<repo>/.test-data/api-capability-<sourceSha>`. */
  outputDir: string
  /** Unpacked package root containing `package.json` with the real `xpodModule`. */
  packageRoot: string
  /** Version read from the produced manifest — never a caller guess. */
  version: string
  /** The exact produced archive. */
  archive: string
  archiveSha256: string
  /** Source SHA the product is bound to. */
  sourceSha: string
  receipt: string
}

export interface PrepareApiCapabilityOptions {
  repoRoot: string
  /** Defaults to the canonical `<repo>/.test-data/api-capability-<sourceSha>`. */
  outputDir?: string
  sourceKind?: 'xpod-controlled-inngest-build-v1'
  workspaceRecipe?: 'global-v1' | 'api-ui-root-minimal-v2'
  /** Test seam: replaces the producer child process. Never used in production. */
  runProducer?: (request: LocalProducerRequest) => ProducerRun
}

interface LocalProducerRequest {
  repo: string
  output: string
  target: string
  identity: { kind: 'local-desktop-build'; actualCheckoutSha: string }
  sourceKind: string
  workspaceRecipe: string
}

interface ProducerRun {
  status: number | null
  stdout: string
  stderr?: string
}

const CONTROLLED_SOURCE_KIND = 'xpod-controlled-inngest-build-v1'
const DEFAULT_WORKSPACE_RECIPE = 'api-ui-root-minimal-v2'
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/u

/** The canonical derived path for one source checkout. No user configuration. */
export function apiCapabilityPath(repoRoot: string, sourceSha: string): string {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('API capability path requires the actual source SHA')
  return path.join(path.resolve(repoRoot), '.test-data', `api-capability-${sourceSha}`)
}

/**
 * Run the canonical producer once and materialize the produced package tree.
 *
 * Must be called with a CLEAN checkout, before any version rewrite.
 */
export function prepareApiCapability(options: PrepareApiCapabilityOptions): PreparedApiCapability {
  const repoRoot = path.resolve(options.repoRoot)
  const sourceSha = actualHead(repoRoot)
  const outputDir = path.resolve(options.outputDir ?? apiCapabilityPath(repoRoot, sourceSha))
  requireOwnedOutput(repoRoot, outputDir)
  if (existsSync(outputDir)) throw new Error('API capability output directory must be fresh')
  // The canonical producer creates the fresh output itself.
  mkdirSync(path.dirname(outputDir), { recursive: true, mode: 0o700 })

  const request: LocalProducerRequest = {
    repo: repoRoot,
    output: outputDir,
    target: `${process.platform}-${process.arch}`,
    // The producer re-reads HEAD and refuses a dirty tree; this cannot be forged.
    identity: { kind: 'local-desktop-build', actualCheckoutSha: sourceSha },
    sourceKind: options.sourceKind ?? CONTROLLED_SOURCE_KIND,
    workspaceRecipe: options.workspaceRecipe ?? DEFAULT_WORKSPACE_RECIPE,
  }
  const run = options.runProducer ?? runLocalProducer
  const result = run(request)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ')
    throw new Error(`API capability production failed: ${detail.slice(0, 800)}`)
  }
  return readBack(repoRoot, outputDir, sourceSha)
}

/**
 * Re-verify a previously prepared product and return its package root.
 *
 * Performs NO production work: no build, no install, no pack. Safe to call from a
 * dirty tree because it never claims to re-derive the source.
 */
export function consumeApiCapability(options: {
  repoRoot: string; outputDir?: string; expectedSourceSha?: string;
}): PreparedApiCapability {
  const repoRoot = path.resolve(options.repoRoot)
  const sourceSha = actualHead(repoRoot)
  if (options.expectedSourceSha !== undefined && options.expectedSourceSha !== sourceSha) {
    throw new Error('API capability expected source differs from the actual checkout')
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('API capability consumption requires the actual source SHA')
  const outputDir = path.resolve(options.outputDir ?? apiCapabilityPath(repoRoot, sourceSha))
  requireOwnedOutput(repoRoot, outputDir)
  return readBack(repoRoot, outputDir, sourceSha)
}

function requireOwnedOutput(repoRoot: string, outputDir: string): void {
  const owned = path.join(repoRoot, '.test-data')
  if (path.dirname(outputDir) !== owned) throw new Error('API capability output must live directly under .test-data')
  const name = path.basename(outputDir)
  if (!name.startsWith('api-capability-')) throw new Error('API capability output must be an api-capability-* directory')
}

function actualHead(repoRoot: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  const sha = (result.stdout ?? '').trim()
  if (result.status !== 0 || !/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error('API capability requires the actual repository HEAD')
  }
  return sha
}

function runLocalProducer(request: LocalProducerRequest): ProducerRun {
  const script = path.join(path.resolve(request.repo), 'scripts', 'api-module-producer.py')
  const result = spawnSync('python3', ['-I', '-S', '-B', script, '--local-request', '-'], {
    cwd: path.resolve(request.repo),
    encoding: 'utf8',
    // Structured stdin, not GITHUB_* variables: this cannot masquerade as CI.
    input: JSON.stringify(request),
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Verify a prepared product and unpack it.
 *
 * Trusts nothing by path or status: the receipt must describe `status:
 * 'controlled-preview-materials'` for THIS source and THIS archive, the archive
 * bytes must hash to the recorded digest, and the unpacked manifest must be the
 * exact `api` capability for this target.
 */
function readBack(repoRoot: string, outputDir: string, sourceSha: string): PreparedApiCapability {
  const receiptPath = path.join(outputDir, 'producer.receipt.json')
  if (!existsSync(receiptPath)) throw new Error('API producer receipt is missing')
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    status?: unknown;
    sourceBefore?: { sha?: unknown };
    sourceAfter?: { sha?: unknown };
    context?: { actualCheckoutSha?: unknown; kind?: unknown };
    archive?: { path?: unknown; sha256?: unknown; bytes?: unknown };
  }
  if (receipt.status !== 'controlled-preview-materials') {
    throw new Error('API producer receipt is not a successful controlled-preview product')
  }
  if (receipt.sourceBefore?.sha !== sourceSha || receipt.sourceAfter?.sha !== sourceSha
    || receipt.context?.actualCheckoutSha !== sourceSha) {
    throw new Error('API capability receipt was produced from a different source')
  }
  if (receipt.context?.kind !== 'local-desktop-build') {
    throw new Error('API capability receipt was not produced by the local desktop build')
  }

  const relative = typeof receipt.archive?.path === 'string' ? receipt.archive.path : undefined
  const recordedSha = typeof receipt.archive?.sha256 === 'string' ? receipt.archive.sha256 : undefined
  const recordedSize = receipt.archive?.bytes
  if (!relative || !recordedSha || !/^[a-f0-9]{64}$/u.test(recordedSha)
    || typeof recordedSize !== 'number' || !Number.isSafeInteger(recordedSize) || recordedSize < 1) {
    throw new Error('API producer receipt does not bind an archive digest')
  }
  const archive = path.resolve(outputDir, relative)
  // The archive must stay inside the owned output; a receipt cannot point elsewhere.
  const escaped = path.relative(outputDir, archive)
  if (escaped.startsWith('..') || path.isAbsolute(escaped)) {
    throw new Error('API capability archive path escapes the owned output')
  }
  if (!existsSync(archive)) throw new Error('API capability archive is missing')
  const bytes = readFileSync(archive)
  if (bytes.length !== recordedSize) {
    throw new Error('API capability archive size differs from its receipt')
  }
  const actualSha = createHash('sha256').update(bytes).digest('hex')
  if (actualSha !== recordedSha) throw new Error('API capability archive bytes differ from the receipt')

  const packageRoot = unpackArchive(outputDir, archive)
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name?: unknown; version?: unknown; xpodModule?: { id?: unknown; entry?: unknown; files?: unknown };
  }
  const expectedName = `@undefineds.co/xpod-api-${process.platform}-${process.arch}`
  if (manifest.name !== expectedName) throw new Error('API capability archive is not the api module for this target')
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
    throw new Error('API capability archive declares no valid module version')
  }
  if (manifest.xpodModule?.id !== 'api' || manifest.xpodModule?.entry !== 'entry.mjs'
    || !Array.isArray(manifest.xpodModule?.files) || manifest.xpodModule!.files!.length === 0) {
    throw new Error('API capability archive has no complete xpodModule inventory')
  }
  return {
    id: 'api', outputDir, packageRoot, version: manifest.version, archive,
    archiveSha256: actualSha, sourceSha, receipt: receiptPath,
  }
}

/**
 * Extract the produced archive (members are `package/*`) into an owned directory.
 *
 * Rejects links, non-regular members, absolute/`..` paths and duplicate entries,
 * mirroring the writer's own guarantees, then returns `<unpacked>/package`.
 */
function unpackArchive(outputDir: string, archive: string): string {
  const unpacked = path.join(outputDir, 'unpacked')
  // Validate archive members BEFORE extraction; an on-disk walk cannot discover
  // that a traversal member already wrote outside the owned destination.
  const members = new Set<string>()
  let invalid = false
  listTar({ file: archive, sync: true, strict: true, onReadEntry: entry => {
    const name = entry.path.replace(/\/$/u, '')
    if (!['File', 'Directory'].includes(entry.type) || !name || name.includes('\\')
      || path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')
      || !(name === 'package' || name.startsWith('package/')) || members.has(name)) invalid = true
    members.add(name)
  } })
  if (invalid) throw new Error('API capability archive contains an unsafe or duplicate member')
  // The archive is the authority. An earlier decoded cache may have changed
  // since preparation; materialize these verified bytes instead of trusting it.
  if (existsSync(unpacked)) {
    const previous = lstatSync(unpacked)
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('API capability unpack directory is invalid')
    rmSync(unpacked, { recursive: true })
  }
  mkdirSync(unpacked, { recursive: true, mode: 0o700 })
  extractTar({ file: archive, cwd: unpacked, sync: true, strict: true, noMtime: true })
  verifyExtractedTree(unpacked)
  const packageRoot = path.join(unpacked, 'package')
  if (!existsSync(path.join(packageRoot, 'package.json'))) {
    throw new Error('API capability archive does not contain package/package.json')
  }
  return packageRoot
}

/** Reject links, non-regular members, unsafe paths and duplicate names. */
function verifyExtractedTree(unpacked: string): void {
  const seen = new Set<string>()
  const walk = (relative = ''): void => {
    for (const entry of readdirSync(path.join(unpacked, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error('API capability archive contains a link')
      if (entry.isDirectory()) { walk(name); continue }
      if (!entry.isFile()) throw new Error('API capability archive contains a non-regular member')
      if (name.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('API capability archive contains an unsafe path')
      }
      if (seen.has(name)) throw new Error('API capability archive contains a duplicate member')
      seen.add(name)
    }
  }
  walk()
}
