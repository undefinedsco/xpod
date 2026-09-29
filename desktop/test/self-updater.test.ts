import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildInstallScript,
  compareDesktopVersions,
  describeInstallBlocker,
  DesktopSelfUpdater,
  formatBytes,
  formatUpdateProgress,
  isVersionLike,
  normalizeVersion,
  parseBundleVersion,
  parseSelfUpdateManifest,
} from '../src/self-updater'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'xpod-self-update-'))
  temporaryDirectories.push(directory)
  return directory
}

const RELEASED_MANIFEST = `version: 0.4.19
files:
  - url: Xpod-0.4.19-arm64-mac.zip
    sha512: ${'a'.repeat(86)}==
    size: 186528027
  - url: Xpod-0.4.19-arm64.dmg
    sha512: ${'b'.repeat(86)}==
    size: 192907952
path: Xpod-0.4.19-arm64-mac.zip
sha512: ${'a'.repeat(86)}==
releaseDate: '2026-09-28T06:42:39.641Z'
`

describe('parseSelfUpdateManifest', () => {
  it('reads the electron-builder release manifest and resolves the archive', () => {
    expect(parseSelfUpdateManifest(
      RELEASED_MANIFEST,
      'https://github.com/undefinedsco/xpod/releases/latest/download/latest-mac.yml',
    )).toEqual({
      version: '0.4.19',
      url: 'https://github.com/undefinedsco/xpod/releases/latest/download/Xpod-0.4.19-arm64-mac.zip',
      sha512: `${'a'.repeat(86)}==`,
      size: 186528027,
    })
  })

  it('reads the Electron update JSON used by the acceptance fixture', () => {
    expect(parseSelfUpdateManifest(JSON.stringify({
      url: 'http://127.0.0.1:43199/artifact',
      name: '0.4.19',
      notes: 'Xpod 0.4.19 is ready.',
    }), 'http://127.0.0.1:43199/update/darwin')).toEqual({
      version: '0.4.19',
      url: 'http://127.0.0.1:43199/artifact',
    })
  })

  it('ignores empty and unreadable bodies', () => {
    expect(parseSelfUpdateManifest('', 'https://example.test/latest-mac.yml')).toBeUndefined()
    expect(parseSelfUpdateManifest('{"error":"nope"}', 'https://example.test/latest-mac.yml')).toBeUndefined()
    expect(parseSelfUpdateManifest('<!doctype html><html></html>', 'https://example.test/latest-mac.yml')).toBeUndefined()
  })
})

describe('version handling', () => {
  it('orders versions numerically and ignores the v prefix', () => {
    expect(compareDesktopVersions('0.4.19', '0.4.18')).toBe(1)
    expect(compareDesktopVersions('v0.4.18', '0.4.18')).toBe(0)
    expect(compareDesktopVersions('0.4.9', '0.4.10')).toBe(-1)
    expect(compareDesktopVersions('0.5.0', '0.4.99')).toBe(1)
  })

  it('accepts only version-shaped strings', () => {
    expect(isVersionLike('0.4.19')).toBe(true)
    expect(isVersionLike('v1.2.3-rc.1')).toBe(true)
    expect(isVersionLike('latest')).toBe(false)
    expect(normalizeVersion('Xpod 0.4.19')).toBe('0.4.19')
  })

  it('formats progress for the tray', () => {
    expect(formatBytes(186_528_027)).toBe('178 MB')
    expect(formatUpdateProgress({ transferred: 78_000_000, total: 186_000_000, percent: 42, bytesPerSecond: 1_200_000 }))
      .toBe('42% of 177 MB · 1 MB/s')
    expect(formatUpdateProgress({ transferred: 512 })).toBe('512 B')
  })

  it('reads the bundle version out of an Info.plist', () => {
    expect(parseBundleVersion('<key>CFBundleShortVersionString</key>\n<string>0.4.19</string>')).toBe('0.4.19')
    expect(parseBundleVersion('<key>CFBundleVersion</key><string>1</string>')).toBeUndefined()
  })
})

describe('buildInstallScript', () => {
  it('waits for the app, restores a failed copy and quotes every path', () => {
    const script = buildInstallScript({
      pid: 4_242,
      targetApp: "/Applications/Xpod's Copy.app",
      stagedApp: "/tmp/staged 0.4.19/Xpod.app",
      logPath: '/tmp/install.log',
      relaunch: 'open',
    })

    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('while kill -0 4242 2>/dev/null; do')
    expect(script).toContain(`ditto '/Applications/Xpod'\\''s Copy.app' '/Applications/Xpod'\\''s Copy.app.xpod-previous'`)
    expect(script).toContain(`ditto '/tmp/staged 0.4.19/Xpod.app' '/Applications/Xpod'\\''s Copy.app'`)
    expect(script).toContain('open \'/Applications/Xpod\'\\\'\'s Copy.app\'')
  })

  it('relaunches the executable directly for unattended acceptance', () => {
    const script = buildInstallScript({
      pid: 1,
      targetApp: '/tmp/Xpod.app',
      stagedApp: '/tmp/staged/Xpod.app',
      logPath: '/tmp/install.log',
      relaunch: 'direct',
    })

    expect(script).toContain(`'/tmp/Xpod.app/Contents/MacOS/Xpod' >>"$LOG" 2>&1 &`)
    // Only the recovery branch may fall back to LaunchServices.
    expect(script).not.toContain(`\nopen '/tmp/Xpod.app' >>"$LOG" 2>&1 || true\n`)
  })
})

describe('describeInstallBlocker', () => {
  it('refuses a translocated copy', () => {
    expect(describeInstallBlocker('/private/var/folders/x/AppTranslocation/1/d/Xpod.app'))
      .toContain('translocated')
  })

  it('accepts a writable application directory', () => {
    expect(describeInstallBlocker('/tmp/Xpod.app')).toBeUndefined()
  })
})

interface LocalFeed {
  baseUrl: string
  server: Server
  requests: Array<{ url: string; range?: string }>
}

async function startFeed(handler: (request: { url: string; range?: string }, response: import('node:http').ServerResponse) => void): Promise<LocalFeed> {
  const requests: LocalFeed['requests'] = []
  const server = createServer((request, response) => {
    const entry = { url: request.url ?? '/', range: request.headers.range }
    requests.push(entry)
    handler(entry, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, requests, baseUrl: `http://127.0.0.1:${port}` }
}

function sha512Base64(payload: Buffer): string {
  return createHash('sha512').update(payload).digest('base64')
}

describe('DesktopSelfUpdater', () => {
  it('downloads, verifies and stages a newer release before offering the install', async () => {
    const payload = Buffer.from('x'.repeat(256 * 1024))
    const archive = Buffer.concat([payload, payload])
    const feed = await startFeed((request, response) => {
      if (request.url === '/latest-mac.yml') {
        response.writeHead(200, { 'content-type': 'text/yaml' })
        response.end(`version: 0.4.19\npath: Xpod-0.4.19-arm64-mac.zip\nsha512: ${sha512Base64(archive)}\nsize: ${archive.length}\n`)
        return
      }
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': archive.length })
      response.end(archive)
    })
    const updatesDir = temporaryDirectory()
    const events: string[] = []
    const updater = new DesktopSelfUpdater({
      version: '0.4.18',
      appPath: '/tmp/Xpod.app',
      updatesDir,
      manifestUrl: `${feed.baseUrl}/latest-mac.yml`,
      runCommand: async (command, args) => {
        if (command.endsWith('ditto') && args[0] === '-x') {
          // Stand in for the extraction so staging can inspect a real bundle.
          const destination = args.at(-1) ?? ''
          mkdirSync(path.join(destination, 'Xpod.app', 'Contents'), { recursive: true })
          writeFileSync(path.join(destination, 'Xpod.app', 'Contents', 'Info.plist'), '<plist/>')
          return ''
        }
        if (command.endsWith('plutil')) return '0.4.19\n'
        return ''
      },
      spawnInstaller: () => undefined,
      requestQuit: () => undefined,
      onLifecycleEvent: (event) => events.push(event),
    })
    updater.on('update-downloaded', () => events.push('event:update-downloaded'))
    updater.on('error', (error) => events.push(`error:${error instanceof Error ? error.message : String(error)}`))
    updater.on('download-progress', () => {
      if (!events.includes('event:progress')) events.push('event:progress')
    })

    updater.checkForUpdates()
    await waitFor(() => events.includes('event:update-downloaded') || events.some((entry) => entry.startsWith('error:')))
    expect(events.filter((entry) => entry.startsWith('error:'))).toEqual([])

    expect(events).toContain('download-started')
    expect(events).toContain('event:progress')
    expect(events).toContain('download-verified')
    expect(events).toContain('update-staged')
    expect(events).toContain('signature-verified')
    expect(updater.snapshot()?.version).toBe('0.4.19')
    expect(existsSync(path.join(updatesDir, 'Xpod-0.4.19-arm64-mac.zip'))).toBe(true)
    expect(existsSync(path.join(updatesDir, 'Xpod-0.4.19-arm64-mac.zip.part'))).toBe(false)
    feed.server.close()
  })

  it('resumes a partial archive and rejects a checksum mismatch', async () => {
    const archive = Buffer.from('y'.repeat(64 * 1024))
    const updatesDir = temporaryDirectory()
    const archiveName = 'Xpod-0.4.19-arm64-mac.zip'
    writeFileSync(path.join(updatesDir, `${archiveName}.part`), archive.subarray(0, 16 * 1024))
    const feed = await startFeed((request, response) => {
      if (request.url === '/latest-mac.yml') {
        response.writeHead(200, { 'content-type': 'text/yaml' })
        // Deliberately wrong checksum: the transfer must be thrown away.
        response.end(`version: 0.4.19\npath: ${archiveName}\nsha512: ${sha512Base64(Buffer.from('other'))}\nsize: ${archive.length}\n`)
        return
      }
      const offset = request.range ? Number(/bytes=(\d+)-/u.exec(request.range)?.[1] ?? 0) : 0
      response.writeHead(request.range ? 206 : 200, {
        'content-type': 'application/zip',
        'content-length': archive.length - offset,
      })
      response.end(archive.subarray(offset))
    })
    const failures: string[] = []
    const updater = new DesktopSelfUpdater({
      version: '0.4.18',
      appPath: '/tmp/Xpod.app',
      updatesDir,
      manifestUrl: `${feed.baseUrl}/latest-mac.yml`,
      runCommand: async () => '',
      spawnInstaller: () => undefined,
      requestQuit: () => undefined,
    })
    updater.on('error', (error) => failures.push(error instanceof Error ? error.message : String(error)))

    updater.checkForUpdates()
    await waitFor(() => failures.length > 0)

    expect(feed.requests.some((request) => request.range === 'bytes=16384-')).toBe(true)
    expect(failures[0]).toContain('published checksum')
    expect(existsSync(path.join(updatesDir, `${archiveName}.part`))).toBe(false)
    feed.server.close()
  })

  it('reports when the feed has nothing newer', async () => {
    const feed = await startFeed((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/yaml' })
      response.end('version: 0.4.18\npath: Xpod-0.4.18-arm64-mac.zip\n')
    })
    const events: string[] = []
    const updater = new DesktopSelfUpdater({
      version: '0.4.18',
      appPath: '/tmp/Xpod.app',
      updatesDir: temporaryDirectory(),
      manifestUrl: `${feed.baseUrl}/latest-mac.yml`,
      runCommand: async () => '',
      spawnInstaller: () => undefined,
      requestQuit: () => undefined,
    })
    updater.on('update-not-available', () => events.push('not-available'))
    updater.on('update-available', () => events.push('available'))

    updater.checkForUpdates()
    await waitFor(() => events.includes('not-available'))

    expect(events).toEqual(['not-available'])
    feed.server.close()
  })

  it('writes a detached installer and asks the app to quit', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const updatesDir = temporaryDirectory()
    const stagedApp = path.join(updatesDir, 'staged-0.4.19', 'Xpod.app')
    writeFileSync(path.join(temporaryDirectory(), 'placeholder'), '')
    const scripts: string[] = []
    let quitRequested = false
    const updater = new DesktopSelfUpdater({
      version: '0.4.18',
      appPath: '/tmp/Xpod.app',
      updatesDir,
      runCommand: async () => '',
      spawnInstaller: (scriptPath) => scripts.push(scriptPath),
      requestQuit: () => { quitRequested = true },
    })
    Object.assign(updater as unknown as { staged: unknown }, {
      staged: { version: '0.4.19', archivePath: path.join(updatesDir, 'Xpod-0.4.19-arm64-mac.zip'), appPath: stagedApp },
    })

    updater.quitAndInstall()

    expect(quitRequested).toBe(true)
    expect(scripts).toHaveLength(1)
    const script = readFileSync(scripts[0]!, 'utf8')
    expect(script).toContain(`ditto '${stagedApp}' '/tmp/Xpod.app'`)
    expect(script).toContain("open '/tmp/Xpod.app'")
    server.close()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the updater to settle.')
}
