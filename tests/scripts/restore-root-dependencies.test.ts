/**
 * Unit coverage for the transactional root-dependency restore helper.
 *
 * These tests inject the command executor, so they never install, never touch the
 * real repository tree and never need the network. They prove the ORDER and the
 * ROLLBACK contract; the real frozen install is a separate, Root-run check.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  assertCanonicalRoot,
  restoreRootDependencies,
  type RestoreResult,
} from '../../scripts/restore-root-dependencies'

const base = path.resolve(import.meta.dir, '../../.test-data')

function ownedRoot(): string {
  mkdirSync(base, { recursive: true })
  return mkdtempSync(path.join(base, 'restore-root-'))
}

/** A tiny fake tree: enough shape for the helper, nothing real. */
function seed(root: string, options: { typescript?: string } = {}) {
  writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', devDependencies: { typescript: '5.5' } }))
  writeFileSync(path.join(root, 'bun.lock'), '{}\n')
  const modules = path.join(root, 'node_modules')
  mkdirSync(path.join(modules, 'typescript'), { recursive: true })
  writeFileSync(path.join(modules, 'typescript', 'package.json'),
    JSON.stringify({ name: 'typescript', version: options.typescript ?? '6.0.3' }))
  writeFileSync(path.join(modules, 'sentinel.txt'), 'previous tree')
}

/** Simulates bun installing the root compiler at a given version. */
function installer(version: string, log: string[] = []) {
  return (command: string, args: string[], cwd: string): void => {
    log.push(`${command} ${args.join(' ')}`)
    if (args[0] === 'install' || args.includes('install')) {
      const modules = path.join(cwd, 'node_modules')
      mkdirSync(path.join(modules, 'typescript'), { recursive: true })
      writeFileSync(path.join(modules, 'typescript', 'package.json'),
        JSON.stringify({ name: 'typescript', version }))
    }
  }
}

describe('restore-root-dependencies', () => {
  it('does not delete anything at import time', async () => {
    // Importing the module must be inert: no tree is touched until the exported
    // function is called, and the entry point is guarded by import.meta.main.
    const root = ownedRoot()
    try {
      seed(root)
      writeFileSync(path.join(root, 'node_modules', 'keep.txt'), 'still here')
      // A fresh process avoids the module cache and binds any accidental mutation
      // to this owned fixture, rather than the real checkout.
      const moduleUrl = new URL('../../scripts/restore-root-dependencies.ts', import.meta.url).href
      execFileSync(process.execPath, ['-e', `await import(${JSON.stringify(moduleUrl)})`], { cwd: root })
      expect(readFileSync(path.join(root, 'node_modules', 'keep.txt'), 'utf8')).toBe('still here')
      expect(existsSync(path.join(root, 'node_modules', 'typescript', 'package.json'))).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('checks the canonical root before mutating and refuses an incomplete one', () => {
    const root = ownedRoot()
    try {
      writeFileSync(path.join(root, 'package.json'), '{}')
      // bun.lock missing
      expect(() => assertCanonicalRoot(root)).toThrow('requires bun.lock')
      let ran = false
      expect(() => restoreRootDependencies(root, { run: () => { ran = true } }))
        .toThrow('requires bun.lock')
      expect(ran).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('installs, runs the checker in order, then removes only its own backup', () => {
    const root = ownedRoot()
    try {
      seed(root, { typescript: '6.0.3' })
      const log: string[] = []
      const result: RestoreResult = restoreRootDependencies(root, {
        run: installer('5.5.4', log),
      })
      // The filtered tree said 6.0.3; the restore reports the ACTUAL installed one.
      expect(result.installed).toBe('5.5.4')
      expect(result.declared).toBe('5.5')
      // Order: install strictly before the authoritative checker.
      const install = log.findIndex((entry) => entry.includes('install'))
      const check = log.findIndex((entry) => entry.includes('check-dependency-state'))
      expect(install).toBeGreaterThanOrEqual(0)
      expect(check).toBeGreaterThan(install)
      // The previous tree is gone: the sentinel from the old tree cannot survive.
      expect(existsSync(path.join(root, 'node_modules', 'sentinel.txt'))).toBe(false)
      // No backup directory is left behind on success.
      const leftovers = existsSync(path.join(root, '.test-data'))
        ? require('node:fs').readdirSync(path.join(root, '.test-data')) as string[]
        : []
      expect(leftovers.filter((name) => name.startsWith('root-node-modules-backup-'))).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps the original tree when the backup cannot even be prepared', () => {
    const root = ownedRoot()
    try {
      seed(root, { typescript: '6.0.3' })
      // A regular FILE as the backup parent makes mkdirSync throw before any move.
      const notADirectory = path.join(root, 'backup-parent-is-a-file')
      writeFileSync(notADirectory, 'not a directory')
      let ran = false
      expect(() => restoreRootDependencies(root, {
        run: () => { ran = true },
        backupRoot: notADirectory,
      })).toThrow()
      // Preparation failed, so installation must never have started...
      expect(ran).toBe(false)
      // ...and the ORIGINAL tree must survive untouched.
      expect(readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('previous tree')
      expect(JSON.parse(readFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')).version)
        .toBe('6.0.3')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps the original tree when the rename itself fails', () => {
    const root = ownedRoot()
    try {
      seed(root, { typescript: '6.0.3' })
      // Renaming a directory into its own child is refused by the filesystem.
      let ran = false
      expect(() => restoreRootDependencies(root, {
        run: () => { ran = true },
        backupRoot: path.join(root, 'node_modules', 'nested-backup'),
      })).toThrow()
      expect(ran).toBe(false)
      expect(readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('previous tree')
      expect(JSON.parse(readFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')).version)
        .toBe('6.0.3')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rolls the previous tree back when the install fails', () => {
    const root = ownedRoot()
    try {
      seed(root, { typescript: '6.0.3' })
      expect(() => restoreRootDependencies(root, {
        run: () => { throw new Error('install exploded') },
      })).toThrow('install exploded')
      // The ORIGINAL tree must be intact, including the sentinel.
      expect(readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('previous tree')
      expect(JSON.parse(readFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')).version)
        .toBe('6.0.3')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rolls back when the install succeeds but the checker rejects the tree', () => {
    const root = ownedRoot()
    try {
      seed(root, { typescript: '6.0.3' })
      const installThenFail = installer('5.5.4')
      expect(() => restoreRootDependencies(root, {
        run: (command, args, cwd) => {
          if (args.some((arg) => arg.includes('check-dependency-state'))) throw new Error('dependency state rejected')
          installThenFail(command, args, cwd)
        },
      })).toThrow('dependency state rejected')
      // A verified-good install is still discarded when the checker fails.
      expect(readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('previous tree')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('fails closed when the install provides no root TypeScript', () => {
    const root = ownedRoot()
    try {
      seed(root, { typescript: '6.0.3' })
      expect(() => restoreRootDependencies(root, { run: () => { /* installs nothing */ } }))
        .toThrow('did not provide the root TypeScript')
      // Still rolled back to the original tree.
      expect(readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('previous tree')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects the filtered compiler even if the general checker succeeds', () => {
    const root = ownedRoot()
    try {
      seed(root)
      expect(() => restoreRootDependencies(root, { run: installer('6.0.3') }))
        .toThrow('does not satisfy the root manifest')
      expect(readFileSync(path.join(root, 'node_modules', 'sentinel.txt'), 'utf8')).toBe('previous tree')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
