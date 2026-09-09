#!/usr/bin/env node

/**
 * Local-only Electron macOS updater feed for acceptance tests.
 *
 * Electron's built-in macOS updater expects a JSON response containing `url`,
 * `name`, `notes`, and `pub_date`. This fixture deliberately binds to
 * 127.0.0.1 so it cannot become an accidental production update endpoint.
 *
 * Examples:
 *   node scripts/update-feed-fixture.mjs --port 43199 --version 0.1.1
 *   curl -i 'http://127.0.0.1:43199/update/darwin?current_version=0.1.0'
 *   curl -i 'http://127.0.0.1:43199/update/darwin?mode=error'
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const options = parseArgs(process.argv.slice(2))
const host = '127.0.0.1'
const port = Number(options.port ?? 0)
const version = String(options.version ?? '0.1.1')
const notes = String(options.notes ?? `Xpod ${version} is ready.`)
const artifact = options.artifact ? path.resolve(options.artifact) : undefined

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('--port must be an integer from 0 to 65535')
}
if (!isVersion(version)) throw new Error(`--version is not a semantic version: ${version}`)
if (artifact && !fs.statSync(artifact, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`--artifact does not exist: ${artifact}`)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}`)
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed' })
    return
  }

  if (url.pathname === '/health') {
    sendJson(response, 200, { ok: true, version })
    return
  }
  if (url.pathname === '/artifact' && artifact) {
    const stream = fs.createReadStream(artifact)
    stream.once('error', () => sendJson(response, 404, { error: 'artifact_not_found' }))
    response.writeHead(200, {
      'content-type': 'application/zip',
      'cache-control': 'no-store',
    })
    stream.pipe(response)
    return
  }
  if (!url.pathname.startsWith('/update')) {
    sendJson(response, 404, { error: 'not_found' })
    return
  }

  const mode = url.searchParams.get('mode') ?? options.mode ?? 'newer'
  if (mode === 'error') {
    sendJson(response, 500, {
      error: 'fixture_error',
      message: 'Synthetic update feed failure for acceptance testing.',
    })
    return
  }
  if (mode === 'none' || mode === 'not-available') {
    response.writeHead(204, { 'cache-control': 'no-store' })
    response.end()
    return
  }

  const current = url.searchParams.get('current_version')
    ?? url.searchParams.get('current')
    ?? url.searchParams.get('v')
  if (current && isVersion(current) && compareVersions(version, current) <= 0) {
    response.writeHead(204, { 'cache-control': 'no-store' })
    response.end()
    return
  }

  const artifactUrl = artifact
    ? `http://${host}:${server.address()?.port ?? port}/artifact`
    : String(options.url ?? `http://${host}:${server.address()?.port ?? port}/artifact`)
  sendJson(response, 200, {
    url: artifactUrl,
    name: version,
    notes,
    pub_date: new Date().toISOString(),
  })
})

server.listen(port, host, () => {
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  process.stdout.write(`XPOD_UPDATE_FIXTURE_READY http://${host}:${boundPort}/update/darwin\n`)
})

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = args[index + 1]
    if (value && !value.startsWith('--')) {
      parsed[key] = value
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

function isVersion(value) {
  return /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value).trim())
}

function compareVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/, '').split(/[+-]/, 1)[0]
    .split('.').map((part) => Number(part))
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function stop() {
  server.close(() => process.exit(0))
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
