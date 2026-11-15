/** Real Bun install transitions in a fresh owned workspace; no synthetic package versions. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { satisfies } from 'semver'
import { restoreRootDependencies } from '../../scripts/restore-root-dependencies'

const scratch = process.argv[2]
if (!scratch || !path.isAbsolute(scratch)) throw new Error('An absolute owned scratch directory is required')
mkdirSync(scratch, { recursive: true })
const root = mkdtempSync(path.join(scratch, 'root-restore-real-'))
const rootRange = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .devDependencies.typescript as string
const apiRange = JSON.parse(readFileSync(new URL('../../packages/ai-connections/package.json', import.meta.url), 'utf8'))
  .devDependencies.typescript as string
const rootTs = (): string | undefined => {
  const manifest = path.join(root, 'node_modules/typescript/package.json')
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : undefined
}
const lockHash = () => createHash('sha256').update(readFileSync(path.join(root, 'bun.lock'))).digest('hex')
const run = (args: string[]) => execFileSync('bun', args, { cwd: root, stdio: 'inherit' })
try {
  mkdirSync(path.join(root, 'packages/child'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'restore-real-root', private: true,
    workspaces: ['packages/*'], devDependencies: { typescript: rootRange } }))
  writeFileSync(path.join(root, 'packages/child/package.json'), JSON.stringify({ name: 'restore-real-child',
    version: '1.0.0', devDependencies: { typescript: apiRange } }))
  run(['install'])
  const original = rootTs()
  const originalLock = lockHash()
  if (!original || !satisfies(original, rootRange)) throw new Error('Initial compiler differs from root range')
  rmSync(path.join(root, 'node_modules'), { recursive: true })
  run(['install', '--frozen-lockfile', '--filter=restore-real-child', '--filter=!restore-real-root'])
  const filtered = rootTs()
  const childRequire = createRequire(path.join(root, 'packages/child/package.json'))
  const childVersion = JSON.parse(readFileSync(childRequire.resolve('typescript/package.json'), 'utf8')).version as string
  if ((filtered && satisfies(filtered, rootRange)) || !satisfies(childVersion, apiRange)) {
    throw new Error('The real filtered install did not reproduce the loss of the root compiler')
  }
  let fixtureCheckRan = false
  const result = restoreRootDependencies(root, {
    run: (_command, args) => {
      if (args[0] === 'install') run(args)
      else {
        // This tiny workspace has no Xpod patches or package builds. Check its
        // actual compiler and immutable lock; the real Xpod checker is run separately.
        if (!rootTs() || !satisfies(rootTs()!, rootRange) || lockHash() !== originalLock) {
          throw new Error('Tiny-workspace dependency check failed')
        }
        fixtureCheckRan = true
      }
    },
  })
  if (!fixtureCheckRan || result.installed !== original || lockHash() !== originalLock) {
    throw new Error('Restoration differs from the original frozen install')
  }
  console.log(JSON.stringify({ ok: true, original, filteredRootCompiler: filtered ?? null, filteredWorkspaceCompiler: childVersion, restored: result.installed,
    lockUnchanged: true, install: 'real Bun registry installation',
    checkerScope: 'tiny compiler/lock; real Xpod authoritative checker is separate' }))
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
