#!/usr/bin/env node
// Actual development UI/Gateway, isolated Electron profile. Verifies cancelled
// login persistence and frame size, not successful account authentication.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, '.test-data/desktop-login-restart')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(path.join(output, 'profile-'))
const target = process.env.XPOD_RECOVERY_ACCEPTANCE_URL ?? 'http://127.0.0.1:5173/ai-connections'
const evidence = { scope: 'actual development UI/Gateway with isolated profile; cancelled login only', stages: [] }
let application
let childExited = true
async function poll(read, accepts, description) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await read()
    if (accepts(result)) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}
async function run(name, url) {
  application = await electron.launch({ args: [path.join(root, 'desktop/dist/main.js')], cwd: path.join(root, 'desktop'),
    env: { ...process.env, XPOD_DESKTOP_URL: url, XPOD_DESKTOP_ACCEPTANCE: '1',
      XPOD_DESKTOP_ALLOW_PARALLEL_ACCEPTANCE: '1', XPOD_DESKTOP_USER_DATA_DIR: profile }, timeout: 30_000 })
  childExited = false
  const processExit = new Promise(resolve => application.process().once('exit', (code, signal) => {
    childExited = true
    resolve({ code, signal })
  }))
  const page = await application.firstWindow()
  const failures = []
  page.on('pageerror', error => failures.push(error.message))
  await poll(() => page.url(), value => value.startsWith(new URL(target).origin), 'local product URL')
  await poll(() => page.locator('body').innerText(), text => /登录|Sign in|Log in/i.test(text), 'manual login surface')
  await new Promise(resolve => setTimeout(resolve, 1500))
  const frame = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  const stage = { name, url: page.url(), contentSize: frame, body: await page.locator('body').innerText(),
    buttons: await page.locator('button').allTextContents(), errors: failures, screenshot: path.join(output, `${name}.png`) }
  evidence.stages.push(stage)
  await page.screenshot({ path: stage.screenshot })
  assert.equal(new URL(stage.url).origin, new URL(target).origin)
  assert.equal(new URL(stage.url).pathname, new URL(target).pathname)
  assert.deepEqual(frame, [280, 400])
  assert.deepEqual(failures, [])
  assert.ok(stage.buttons.some(text => /登录|Sign in|Log in/i.test(text)), 'Manual login button is required')
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  stage.quit = await Promise.race([processExit, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('app.quit timeout')), 10_000)
    timer.unref()
  })])
  assert.equal(stage.quit.code, 0)
}
try {
  const cancelled = new URL(target)
  cancelled.searchParams.set('xpod-login', 'cancelled')
  await run('cancelled-first-launch', cancelled.href)
  await run('plain-restart-same-profile', target)
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.error = error.message
  process.exitCode = 1
} finally {
  if (application && !childExited) await application.evaluate(({ app }) => app.exit(1)).catch(() => undefined)
  await rm(profile, { recursive: true, force: true })
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
}
