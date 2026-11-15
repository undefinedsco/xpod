#!/usr/bin/env bun
/** Restore the normal frozen root dependencies after filtered API production.
 * The filtered tree omits root declarations, so a subsequent root build can
 * resolve a transitive/global compiler. Preserve the old tree until installation,
 * dependency-state verification and the declared compiler check all succeed.
 * Importing this module performs no installation or filesystem mutation.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export interface RestoreResult {
  /** The TypeScript version actually installed at the root slot. */
  installed: string | undefined
  /** The root devDependency range, read from the real package.json bytes. */
  declared: string | undefined
}

export interface RestoreOptions {
  /** Runs one command; injected by tests so no real install is needed. */
  run: (command: string, args: string[], cwd: string) => void
  /** Owned scratch parent for the backup directory. */
  backupRoot?: string
}

function fail(reason: string): never {
  throw new Error(`Root dependency restore: ${reason}`)
}

/** Validate the canonical root before any mutation. */
export function assertCanonicalRoot(repoRoot: string): void {
  for (const required of ['package.json', 'bun.lock']) {
    if (!existsSync(path.join(repoRoot, required))) fail(`canonical root requires ${required}`)
  }
}

/**
 * Restore the root tree transactionally.
 *
 * Order matters: validate, move aside, install, check, then clean up. Any failure
 * after the move restores the previous tree, so a broken install can never leave
 * the repository without the dependencies it started with.
 */
export function restoreRootDependencies(repoRoot: string, options: RestoreOptions): RestoreResult {
  const root = path.resolve(repoRoot)
  assertCanonicalRoot(root)
  const declared = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }).devDependencies?.typescript
  if (!declared) fail('root manifest must declare TypeScript')
  const modules = path.join(root, 'node_modules')
  const backupParent = options.backupRoot ? path.resolve(options.backupRoot) : path.join(root, '.test-data')
  const backup = path.join(backupParent, `root-node-modules-backup-${process.pid}-${Date.now()}`)
  // Prepare the backup and move the tree aside BEFORE entering the installation
  // rollback scope. A failure here (unwritable backup parent, non-empty target)
  // must leave the original tree untouched - it is not an installation failure,
  // and no replacement tree exists yet.
  let moved = false
  if (existsSync(modules)) {
    mkdirSync(backupParent, { recursive: true })
    renameSync(modules, backup)
    moved = true
  }
  let installed: string | undefined
  try {
    options.run('bun', ['install', '--frozen-lockfile'], root)
    options.run('bun', ['scripts/check-dependency-state.ts', '--dependency-root', root], root)
    const installedManifest = path.join(modules, 'typescript', 'package.json')
    installed = existsSync(installedManifest)
      ? (JSON.parse(readFileSync(installedManifest, 'utf8')) as { version?: string }).version
      : undefined
    if (!installed) fail('install did not provide the root TypeScript')
    // Resolve the root's existing semver dependency only after its install completes.
    const { satisfies } = createRequire(path.join(root, 'package.json'))('semver') as typeof import('semver')
    if (!satisfies(installed, declared)) fail('root TypeScript does not satisfy the root manifest')
  } catch (error) {
    rmSync(modules, { recursive: true, force: true, maxRetries: 3 })
    if (moved) {
      // Roll back to the tree that was present before this run.
      renameSync(backup, modules)
    }
    throw error
  }
  // Cleanup failure must not replace a verified new tree with a partially deleted backup.
  if (moved) rmSync(backup, { recursive: true, force: true, maxRetries: 3 })
  return { installed, declared }
}

if (import.meta.main) {
  const repoRoot = path.resolve(process.argv[2] ?? process.cwd())
  const result = restoreRootDependencies(repoRoot, {
    run: (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' }),
  })
  process.stdout.write(`root-typescript=${result.installed} declared=${result.declared ?? 'unknown'}\n`)
}
