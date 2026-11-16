/**
 * Read-only metadata view of a packaged desktop ZIP's bundled runtime.
 *
 * There is exactly ONE layout authority for the packaged runtime: the product's
 * own `resolveRuntimeLaunchCommand` from `desktop/src/runtime-manager.ts`. This
 * module borrows that function and swaps its `pathExists` probe for an archive
 * member listing, so the virtual paths it resolves are the SAME paths the real
 * RuntimeManager resolves on disk. No second layout table is maintained here.
 *
 * Everything is metadata or bytes read from the ZIP. Nothing in the archive is
 * executed, imported or extracted, so verifying an untrusted artifact cannot run
 * artifact code.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { resolveRuntimeLaunchCommand } from '../../desktop/src/runtime-manager'

/** The packaged CLI carries its own package version, independent of the desktop
 * candidate (`@undefineds.co/xpod-cli` uses `0.1.0-preview.N`). Both are strict. */
const CLI_NAME = '@undefineds.co/xpod-cli'
const CLI_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u
const SHA256 = /^[a-f0-9]{64}$/u
const DESKTOP_VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+(?:\.\d+)?)?$/u

export interface DesktopArchiveRuntime {
  /** `Xpod.app/Contents/Resources`, the path the product resolver is given. */
  resourcesPath: string
  /** Bundled launcher the product resolver selected (e.g. runtime/bin/bun). */
  launcherMember: string
  /** Bundled CLI entry the product resolver selected (dist/xpod.mjs). */
  cliEntryMember: string
  /** The CLI manifest shipped beside that entry. */
  cliManifestMember: string
  cliPackageName: string
  /** INDEPENDENT expectation for the launcher's `--version`, read from the
   * archive's own CLI manifest — never from a running process' output. */
  cliVersion: string
  /** sha256 of the actual bundled launcher bytes. */
  launcherSha256: string
  launcherSize: number
  /** Desktop candidate version from the bundle's Info.plist, for cross-checking
   * that the top-level evidence version really is the desktop version. */
  desktopVersion?: string
}

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // A member that exceeds the bound is killed, and `close` still fires after
    // the kill; `settled` makes sure only the first outcome is reported.
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    child.once('error', () => fail(`archive metadata tool failed: ${command}`))
    child.once('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) {
        fail('archive metadata tool failed')
        return
      }
      settled = true
      resolve(Buffer.concat(chunks))
    })
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return
      chunks.push(chunk)
      size += chunk.length
      // The only members read wholesale are small manifests; the launcher and
      // the archive LISTING are streamed separately, so a bound here keeps a
      // hostile archive cheap instead of buffering it into memory.
      if (size > MANIFEST_BOUND_BYTES) {
        child.kill()
        fail('archive member exceeds metadata bound')
      }
    })
  })
}

/**
 * Bounded memory budgets for the two DIFFERENT things this module reads.
 *
 * `MANIFEST_BOUND_BYTES` guards a single small manifest/plist member, read
 * whole. `INVENTORY_BOUND_BYTES` guards the complete member-NAME inventory,
 * which is genuinely needed in full (duplicate detection, single-app-root
 * detection, and the resolver's membership probe). They are deliberately not
 * the same number: a manifest is kilobytes, an inventory for a real published
 * bundle is ~12MB. Neither is unbounded, and the small budget is never raised to
 * accommodate a listing.
 */
const MANIFEST_BOUND_BYTES = 8 * 1024 * 1024
const INVENTORY_BOUND_BYTES = 32 * 1024 * 1024

/**
 * The largest single unterminated line this module will hold.
 *
 * A line is only ever accumulated between newlines, so this caps the transient
 * buffer for a hostile stream that never emits one. It is sized far above the
 * longest real member path and far below the inventory budget.
 */
const MAX_PENDING_LINE_BYTES = 1024 * 1024

/**
 * The ONE streaming line reader shared by both listings.
 *
 * Spawns `command args`, decodes stdout with a `StringDecoder` so a multibyte
 * UTF-8 character split across chunk boundaries is reassembled rather than
 * corrupted, splits on newlines, and hands each COMPLETE line to `collect`.
 * A trailing line without a newline is delivered at EOF.
 *
 * `collect` may throw; the failure is propagated and the child is killed, so a
 * parser error can never be mistaken for a successful read. Reaching
 * `boundBytes` of total output, or `MAX_PENDING_LINE_BYTES` in one partial line,
 * kills the child and fails closed. Child `error`/`close`/kill handling and the
 * single-settlement guard live here once, not in each caller.
 */
function streamLines(
  command: string,
  args: readonly string[],
  options: { boundBytes: number; collect: (line: string) => void },
): Promise<void> {
  const { boundBytes, collect } = options
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(message))
    }
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let bytes = 0
    child.once('error', () => fail(`archive metadata tool failed: ${command}`))
    child.once('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) {
        fail('archive metadata tool failed')
        return
      }
      // Flush the decoder, then deliver any final line that had no newline.
      pending += decoder.end()
      try {
        if (pending) collect(pending)
      } catch (error) {
        fail(error instanceof Error ? error.message : 'archive listing unparsable')
        return
      }
      settled = true
      resolve()
    })
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > boundBytes) {
        fail('archive member exceeds metadata bound')
        return
      }
      pending += decoder.write(chunk)
      let index = pending.indexOf('\n')
      while (index !== -1) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        try {
          if (line) collect(line)
        } catch (error) {
          fail(error instanceof Error ? error.message : 'archive listing unparsable')
          return
        }
        if (settled) return
        index = pending.indexOf('\n')
      }
      if (pending.length > MAX_PENDING_LINE_BYTES) {
        fail('archive listing line exceeds bound')
      }
    })
  })
}

/** Complete member-name inventory, streamed; every name is retained. */
async function streamMemberNames(archive: string): Promise<string[]> {
  const names: string[] = []
  await streamLines('unzip', ['-Z1', '--', archive], {
    boundBytes: INVENTORY_BOUND_BYTES,
    collect: (line) => { names.push(line) },
  })
  return names
}

/**
 * Stream a `unzip` long listing, retaining ONLY the lines whose trailing field is
 * one of `wanted`. The full line is kept because the caller parses its mode field.
 */
async function streamListing(
  command: string,
  args: readonly string[],
  wanted: readonly string[],
): Promise<string[]> {
  const matched: string[] = []
  await streamLines(command, args, {
    boundBytes: INVENTORY_BOUND_BYTES,
    collect: (line) => { if (wanted.some(name => line.endsWith(` ${name}`))) matched.push(line) },
  })
  return matched
}

/** Bounded read one small manifest member whole; never used for a listing. */
function readMember(archive: string, member: string): Promise<Buffer> {
  return run('unzip', ['-p', '--', archive, member])
}

/** Streams a member through sha256 without holding it in memory. */
async function hashMember(archive: string, member: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }
    const child = spawn('unzip', ['-p', '--', archive, member], { stdio: ['ignore', 'pipe', 'ignore'] })
    const sha256 = createHash('sha256')
    let size = 0
    child.once('error', () => fail('archive hashing tool failed'))
    child.once('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) {
        fail('archive member unavailable')
        return
      }
      settled = true
      resolve({ sha256: sha256.digest('hex'), size })
    })
    // Streamed: the launcher is tens of MB, so its bytes are never buffered.
    child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; sha256.update(chunk) })
  })
}

/**
 * ZIP stores symlinks as members whose "content" is the link target, so
 * `unzip -p` would hand back a short PATH STRING rather than the file bytes and
 * we would happily hash the wrong thing. Only regular files may be read, so the
 * mode character from the long listing is checked first and anything else fails
 * closed. Names are matched as whole trailing fields, so a member containing
 * spaces stays unambiguous.
 */
async function memberModes(archive: string, wanted: readonly string[]): Promise<Map<string, string>> {
  // The long listing for a real bundle is many MiB (tens of thousands of
  // members), so it is streamed and only the WANTED lines are retained. The
  // per-line mode/name parsing is unchanged.
  const matched = await streamListing('unzip', ['-Z', '--', archive], wanted)
  const modes = new Map<string, string>()
  for (const line of matched) {
    const match = /^(\S{10})\s.*?\s(\S+)$/u.exec(line)
    if (!match) continue
    const [, mode, name] = match as unknown as [string, string, string]
    if (wanted.includes(name) && !modes.has(name)) modes.set(name, mode)
  }
  return modes
}

function occurrenceCount(members: readonly string[], member: string): number {
  let count = 0
  for (const value of members) if (value === member) count += 1
  return count
}

/** The single top-level `.app` directory of the bundle; ambiguity fails closed. */
function appRoots(members: readonly string[]): string[] {
  const roots = new Set<string>()
  for (const member of members) {
    const match = /^([^/]+\.app)\//u.exec(member)
    if (match) roots.add(match[1]!)
  }
  return [...roots]
}

/** Duplicate member names make every later read ambiguous, so reject upfront. */
function duplicates(members: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const member of members) {
    if (seen.has(member)) repeated.add(member)
    else seen.add(member)
  }
  return [...repeated]
}

function plistString(plist: string, key: string): string | undefined {
  const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'u')
  return pattern.exec(plist)?.[1]
}

/**
 * Resolves the packaged runtime members for `archive` using the product's own
 * resolver, then reads the CLI manifest that ships beside the resolved entry.
 *
 * Fails closed on: a missing/ambiguous app root, a resolver answer that is not
 * an exact archive member, an ambiguous CLI manifest, or a manifest whose name
 * or version is not the strict packaged CLI contract.
 */
export async function readDesktopArchiveRuntime(archive: string): Promise<DesktopArchiveRuntime> {
  const listing = await streamMemberNames(archive)
  if (listing.length === 0) throw new Error('desktop archive has no members')

  const repeated = duplicates(listing)
  if (repeated.length > 0) throw new Error('desktop archive contains duplicate members')
  const roots = appRoots(listing)
  if (roots.length !== 1) throw new Error('desktop archive must contain exactly one application bundle')

  const members = new Set(listing)
  const resourcesPath = `${roots[0]}/Contents/Resources`

  // The product resolver is the layout authority; its `pathExists` becomes a ZIP
  // membership probe so the answer is about THIS archive, not the host disk.
  const launch = resolveRuntimeLaunchCommand({
    env: {},
    packaged: true,
    resourcesPath,
    pathExists: value => members.has(value),
    resolveBunCommand: () => undefined,
  })
  if (!launch) throw new Error('bundled runtime launcher is missing from the archive')

  const entryArg = launch.args.find(value => !value.startsWith('-'))
  if (!entryArg) throw new Error('bundled runtime entry is missing from the archive')
  const cliEntryMember = entryArg
  // The package root is the entry's own `dist` parent; derive it from the entry
  // rather than assuming a fixed depth below the entry.
  const cliManifestMember = `${path.posix.dirname(path.posix.dirname(cliEntryMember))}/package.json`

  for (const [label, member] of [['launcher', launch.command], ['entry', cliEntryMember],
    ['cli manifest', cliManifestMember]] as const) {
    if (!members.has(member)) throw new Error(`bundled ${label} is not an archive member`)
    if (occurrenceCount(listing, member) !== 1) throw new Error(`bundled ${label} is ambiguous in the archive`)
    // Every member we read must be a regular file inside the single app bundle.
    // A directory, symlink or device would yield something that is not the bytes
    // we think we are hashing.
    if (!member.startsWith(`${roots[0]}/`)) throw new Error(`bundled ${label} escapes the application bundle`)
    if (/\/(?:\.\.?)(?:\/|$)/u.test(member) || member.includes('\\')) {
      throw new Error(`bundled ${label} is not a normalized archive path`)
    }
  }

  const modes = await memberModes(archive, [launch.command, cliEntryMember, cliManifestMember])
  for (const [label, member] of [['launcher', launch.command], ['entry', cliEntryMember],
    ['cli manifest', cliManifestMember]] as const) {
    const mode = modes.get(member)
    if (mode === undefined) throw new Error(`bundled ${label} has no archive mode`)
    if (mode[0] !== '-') throw new Error(`bundled ${label} is not a regular file`)
  }

  const manifest = JSON.parse((await readMember(archive, cliManifestMember)).toString('utf8')) as {
    name?: unknown; version?: unknown
  }
  if (manifest.name !== CLI_NAME) throw new Error('bundled CLI package name is not the packaged CLI')
  if (typeof manifest.version !== 'string' || !CLI_VERSION.test(manifest.version)) {
    throw new Error('bundled CLI package version is not a valid CLI version')
  }

  const launcher = await hashMember(archive, launch.command)
  if (!SHA256.test(launcher.sha256) || launcher.size === 0) throw new Error('bundled launcher is empty')

  let desktopVersion: string | undefined
  try {
    desktopVersion = plistString((await readMember(archive, `${roots[0]}/Contents/Info.plist`)).toString('utf8'),
      'CFBundleShortVersionString')
  } catch { desktopVersion = undefined }
  if (desktopVersion !== undefined && !DESKTOP_VERSION.test(desktopVersion)) desktopVersion = undefined

  return {
    resourcesPath,
    launcherMember: launch.command,
    cliEntryMember,
    cliManifestMember,
    cliPackageName: manifest.name,
    cliVersion: manifest.version,
    launcherSha256: launcher.sha256,
    launcherSize: launcher.size,
    ...(desktopVersion === undefined ? {} : { desktopVersion }),
  }
}

// Small CLI entry so the CJS verifiers can obtain this metadata without
// depending on a TypeScript build step. It prints ONLY the metadata record;
// archive contents are never echoed. `bun` is the declared toolchain already
// required by the desktop job.
if (import.meta.main) {
  const archive = process.argv[2]
  if (!archive) {
    console.error('usage: desktop-archive-runtime <archive.zip>')
    process.exitCode = 2
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await readDesktopArchiveRuntime(archive))}\n`)
    } catch (error) {
      // Reasons raised here are rule/member-level constants written by this
      // module; no archive bytes, paths from the host, or member contents are
      // included. The CJS caller re-sanitizes before surfacing it.
      console.error(error instanceof Error ? error.message : 'desktop archive runtime metadata rejected')
      process.exitCode = 1
    }
  }
}
