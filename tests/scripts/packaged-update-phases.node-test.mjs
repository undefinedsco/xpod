import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { waitForPhaseEvent } from '../../desktop/scripts/packaged-update-acceptance.mjs'

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
