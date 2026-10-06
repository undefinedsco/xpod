import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import {
  ownedProcessMarkers,
  commandNamesPath,
  listOwnedPids,
  stopOwnedProcesses,
  removeOwnedUserData,
  cleanupSatisfied,
  waitForPhaseEvent,
} from '../../desktop/scripts/packaged-update-acceptance.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function uniqueTestDir() {
  const parent = path.join(repoRoot, '.test-data')
  fs.mkdirSync(parent, { recursive: true })
  return fs.mkdtempSync(path.join(parent, 'packaged-update-phases-'))
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

for (const [phase, event] of [['fixture READY', 'data'], ['old App exit', 'exit']]) {
  test(`${phase} absent fails and removes listeners; late event cannot succeed`, async () => {
    const emitter = new EventEmitter()
    let cleanup = false
    await assert.rejects((async () => {
      try { await waitForPhaseEvent(emitter, event, () => true, 10, phase) }
      finally { cleanup = true }
    })(), { message: `Packaged update acceptance timed out waiting for ${phase}.` })
    assert.equal(cleanup, true)
    assert.equal(emitter.listenerCount(event), 0)
    emitter.emit(event, 'late')
  })
}
test('success clears timer and listener without a late timeout', async () => {
  const emitter = new EventEmitter()
  const pending = waitForPhaseEvent(emitter, 'data', (value) => value === 'READY', 20, 'fixture READY')
  emitter.emit('data', 'noise')
  emitter.emit('data', 'READY')
  assert.deepEqual(await pending, ['READY'])
  assert.equal(emitter.listenerCount('data'), 0)
  await new Promise((resolve) => setTimeout(resolve, 30))
})
test('fixture early exit fails promptly and removes both listeners', async () => {
  const stdout = new EventEmitter()
  const child = new EventEmitter()
  const pending = waitForPhaseEvent(stdout, 'data', () => true, 1000, 'fixture READY', child)
  child.emit('exit', 1)
  await assert.rejects(pending, { message: 'Packaged update acceptance child exited before fixture READY.' })
  assert.equal(stdout.listenerCount('data'), 0)
  assert.equal(child.listenerCount('exit'), 0)
})
for (const source of ['stdout', 'owned child', 'old app']) {
  test(`${source} error rejects safely and releases every phase listener`, async () => {
    const emitter = new EventEmitter()
    const child = source === 'old app' ? undefined : new EventEmitter()
    const target = source === 'owned child' ? child : emitter
    const phase = source === 'old app' ? 'old App exit' : 'fixture READY'
    const event = source === 'old app' ? 'exit' : 'data'
    const pending = waitForPhaseEvent(emitter, event, () => true, 10, phase, child)
    target.emit('error', new Error('private spawn path must not escape'))
    await assert.rejects(pending, { message: `Packaged update acceptance failed waiting for ${phase}.` })
    assert.equal(emitter.listenerCount(event), 0)
    assert.equal(emitter.listenerCount('error'), 0)
    assert.equal(child?.listenerCount('error') ?? 0, 0)
    assert.equal(child?.listenerCount('exit') ?? 0, 0)
    emitter.emit(event, 'late')
    // No stale error handler remains to turn a later event into success.
    assert.throws(() => target.emit('error', new Error('late')), /late/)
    await new Promise((resolve) => setTimeout(resolve, 15))
  })
}
test('same emitter is not registered twice for error handling', async () => {
  const emitter = new EventEmitter()
  const pending = waitForPhaseEvent(emitter, 'data', () => true, 10, 'fixture READY', emitter)
  assert.equal(emitter.listenerCount('error'), 1)
  emitter.emit('error', new Error('private'))
  await assert.rejects(pending, { message: 'Packaged update acceptance failed waiting for fixture READY.' })
  assert.equal(emitter.listenerCount('error'), 0)
  assert.equal(emitter.listenerCount('exit'), 0)
})

test('owned markers cover the bundle subtree and only a private userData', () => {
  assert.deepEqual(
    ownedProcessMarkers({ appPath: '/tmp/Xpod.app', userData: '/tmp/xpod-update-abc', privateUserData: true }),
    [ path.join('/tmp/Xpod.app', 'Contents'), '/tmp/xpod-update-abc' ],
  )
  // A caller supplied --user-data is the user's original profile: never owned.
  assert.deepEqual(
    ownedProcessMarkers({ appPath: '/tmp/Xpod.app', userData: '/Users/me/Library/Application Support/Xpod', privateUserData: false }),
    [ path.join('/tmp/Xpod.app', 'Contents') ],
  )
})

test('listOwnedPids selects the bundle runtime and private userData, never this process', () => {
  const table = [
    { pid: process.pid, command: 'node packaged-update-acceptance.mjs --old /tmp/Xpod.app' },
    { pid: 101, command: '/tmp/Xpod.app/Contents/MacOS/Xpod' },
    { pid: 102, command: '/tmp/Xpod.app/Contents/Resources/runtime/xpod start --foreground' },
    { pid: 103, command: '/usr/bin/node /tmp/xpod-update-abc/updates/install-update.sh' },
    { pid: 104, command: '/usr/bin/unrelated --profile Xpod' },
  ]
  const markers = ownedProcessMarkers({ appPath: '/tmp/Xpod.app', userData: '/tmp/xpod-update-abc', privateUserData: true })
  assert.deepEqual(listOwnedPids(markers, { readProcessTable: () => table }).sort((a, b) => a - b), [ 101, 102, 103 ])
})

test('path matching owns descendants but rejects ambiguous sibling prefixes', () => {
  // A sibling sharing the marker as a prefix must not be captured.
  assert.equal(commandNamesPath('/tmp/xpod-update-abcdef/runtime-cache/x', '/tmp/xpod-update-abc'), false)
  assert.equal(commandNamesPath('/tmp/Xpod.app/Contents/MacOS/XpodHelper serve', '/tmp/Xpod.app/Contents/MacOS/Xpod'), false)
  // Descendants and the exact token itself must be captured.
  assert.equal(commandNamesPath('/tmp/xpod-update-abc/runtime-cache/x', '/tmp/xpod-update-abc'), true)
  assert.equal(commandNamesPath('/tmp/Xpod.app/Contents/Resources/runtime/xpod start', '/tmp/Xpod.app/Contents'), true)
  assert.equal(commandNamesPath('/tmp/Xpod.app/Contents/MacOS/Xpod', '/tmp/Xpod.app/Contents/MacOS/Xpod'), true)
})

test('a stale bundle runtime cannot prove the app relaunched under the exact binary marker', () => {
  const runtime = '/tmp/Xpod.app/Contents/Resources/runtime/xpod start --foreground'
  const table = [ { pid: 700, command: runtime } ]
  // Relaunch proof uses the exact old binary path only.
  assert.deepEqual(listOwnedPids([ '/tmp/Xpod.app/Contents/MacOS/Xpod' ], { readProcessTable: () => table }), [])
  // Cleanup still stops the runtime via the bundle marker.
  assert.deepEqual(listOwnedPids([ '/tmp/Xpod.app/Contents' ], { readProcessTable: () => table }), [ 700 ])
})

test('listOwnedPids propagates a process-inventory failure (fail closed)', () => {
  assert.throws(
    () => listOwnedPids([ 'marker' ], { readProcessTable: () => { throw new Error('process inventory unavailable: ps failed') } }),
    /process inventory unavailable/,
  )
})

test('stopOwnedProcesses escalates SIGTERM to SIGKILL and reports remaining PIDs', async () => {
  let live = [ 111, 222 ]
  const signals = []
  const result = await stopOwnedProcesses([ 'marker' ], 0, {
    listPids: () => [ ...live ],
    killPid: (pid, signal) => {
      signals.push(`${pid}:${signal}`)
      if (signal === 'SIGKILL') live = live.filter((value) => value !== pid)
    },
    wait: async () => {},
  })
  assert.equal(result.stopped, true)
  assert.equal(result.remaining, 0)
  assert.deepEqual(signals, [ '111:SIGTERM', '222:SIGTERM', '111:SIGKILL', '222:SIGKILL' ])
})

test('removeOwnedUserData is refused while an owned writer could still run', async () => {
  let removals = 0
  const result = await removeOwnedUserData('/tmp/xpod-update-leak', [ '/tmp/xpod-update-leak' ], {
    listPids: () => [ 4242 ],
    remove: () => { removals += 1 },
    pathExists: () => true,
  })
  assert.equal(result.removed, false)
  assert.equal(result.remainingOwnedPids, 1)
  assert.equal(removals, 0)
  assert.match(result.error.message, /owned processes still running/)
})

test('a transient ENOTEMPTY is retried a bounded number of times and succeeds', async () => {
  let attempts = 0
  const result = await removeOwnedUserData('/tmp/xpod-update-retry', [ '/tmp/xpod-update-retry' ], {
    listPids: () => [],
    remove: () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('directory not empty')
        error.code = 'ENOTEMPTY'
        throw error
      }
    },
    pathExists: () => attempts < 3,
    retryDelayMs: 0,
    wait: async () => {},
  })
  assert.equal(attempts, 3)
  assert.equal(result.removed, true)
})

test('a persistent ENOTEMPTY is propagated, never swallowed', async () => {
  let attempts = 0
  const result = await removeOwnedUserData('/tmp/xpod-update-stuck', [ '/tmp/xpod-update-stuck' ], {
    listPids: () => [],
    remove: () => {
      attempts += 1
      const error = new Error('directory not empty')
      error.code = 'ENOTEMPTY'
      throw error
    },
    pathExists: () => true,
    attempts: 3,
    retryDelayMs: 0,
    wait: async () => {},
  })
  assert.equal(attempts, 3)
  assert.equal(result.removed, false)
  assert.equal(result.error.code, 'ENOTEMPTY')
})

test('removeOwnedUserData never deletes when process inventory is unavailable', async () => {
  let removals = 0
  const result = await removeOwnedUserData('/tmp/xpod-update-unknown', [ '/tmp/xpod-update-unknown' ], {
    listPids: () => { throw new Error('process inventory unavailable: ps failed') },
    remove: () => { removals += 1 },
    pathExists: () => true,
  })
  assert.equal(result.removed, false)
  assert.equal(removals, 0)
  assert.match(result.error.message, /process inventory unavailable/)
})

test('an explicit --user-data run cannot claim cleanup removed (no false removal)', () => {
  const base = { oldAppStopped: true, relaunchedAppStopped: true, fixtureStopped: true, remainingOwnedPids: 0 }
  // An explicit original profile is preserved, never removed: cleanup must not
  // be satisfied by claiming a removal that did not happen.
  assert.equal(cleanupSatisfied({ ...base, removedUserData: false }), false)
  // A verified private removal is the only way cleanup is satisfied.
  assert.equal(cleanupSatisfied({ ...base, removedUserData: true }), true)
  // Unknown process inventory still fails closed.
  assert.equal(cleanupSatisfied({ ...base, removedUserData: true, inventoryError: 'ps failed' }), false)
})

test('a real task-owned child writing the private tempdir is stopped before removal', async (t) => {
  const dir = uniqueTestDir()
  const userData = path.join(dir, 'xpod-update-runtime')
  const cache = path.join(userData, 'runtime-cache', '@solid', 'community-server', 'dist')
  fs.mkdirSync(cache, { recursive: true })
  const writer = path.join(dir, 'writer.cjs')
  fs.writeFileSync(
    writer,
    "const fs=require('node:fs'),path=require('node:path');const target=process.argv[2];"
    + "fs.mkdirSync(target,{recursive:true});setInterval(()=>fs.writeFileSync(path.join(target,'chunk'),String(Date.now())),5);",
  )
  const child = spawn(process.execPath, [ writer, cache ], { stdio: 'ignore' })
  t.after(() => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const markers = [ userData ]
  assert.equal(await waitFor(() => listOwnedPids(markers).includes(child.pid)), true)
  const stopped = await stopOwnedProcesses(markers, 5_000)
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.remaining, 0)
  assert.notEqual(child.signalCode, null)

  const removal = await removeOwnedUserData(userData, markers)
  assert.equal(removal.removed, true)
  assert.equal(fs.existsSync(userData), false)
})
