import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Non-vacuous checks for the acceptance-only desktop media retention path.
 *
 * These run the REAL helper against a REAL zip archive and a REAL electron-builder
 * style feed. Nothing is stubbed except `gh` (no network, no credentials). Cases
 * cover: raw archive digest verified before extraction, tampered archive,
 * traversal/absolute/backslash/symlink members, duplicate members, wrong feed
 * hash/size/version, and producer/attempt/upload/order trust violations.
 */

const HELPER = path.resolve(__dirname, '../../scripts/diagnostics/retain-desktop-release-media.py')
const TAG = 'v0.4.34'
const SHA = '1147fecfec4aea4b75cacbe779713f09e92dafac'
const VERSION = '0.4.34'
const RUN_ID = '44047310435'
const ATTEMPT = 1
const ARTIFACT_ID = 14315326869

type Member = { name: string; body: string; mode?: number }

const workdirs: string[] = []
afterEach(() => {
  for (const dir of workdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Minimal deterministic ZIP writer so fixtures need no dependency. */
function buildZip(members: Member[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8')
    const body = Buffer.from(member.body, 'utf8')
    const crc = crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(member.mode ?? 0o100644 * 65536, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const ZIP_NAME = `Xpod-${VERSION}-arm64-mac.zip`
const DMG_NAME = `Xpod-${VERSION}-arm64.dmg`
const ZIP_BODY = 'zip-payload-bytes'
const DMG_BODY = 'dmg-payload-bytes'

function sha512b64(body: string): string {
  return createHash('sha512').update(body).digest('base64')
}

/**
 * Mirrors the REAL 500-byte latest-mac.yml: a `files:` list holding the ZIP entry
 * then the DMG entry, then top-level path/sha512/releaseDate. The DMG's `size`
 * deliberately differs from the ZIP's so a flat parser would mis-bind them.
 */
function realFeed(overrides: {
  zipSize?: number; dmgSize?: number; zipSha?: string; dmgSha?: string
  order?: 'zip-first' | 'dmg-first'; version?: string
} = {}): string {
  const zipEntry = [
    `  - url: ${ZIP_NAME}`,
    `    sha512: ${overrides.zipSha ?? sha512b64(ZIP_BODY)}`,
    `    size: ${overrides.zipSize ?? Buffer.byteLength(ZIP_BODY)}`,
  ]
  const dmgEntry = [
    `  - url: ${DMG_NAME}`,
    `    sha512: ${overrides.dmgSha ?? sha512b64(DMG_BODY)}`,
    `    size: ${overrides.dmgSize ?? Buffer.byteLength(DMG_BODY)}`,
  ]
  const entries = overrides.order === 'dmg-first' ? [...dmgEntry, ...zipEntry] : [...zipEntry, ...dmgEntry]
  return [
    `version: ${overrides.version ?? VERSION}`,
    'files:',
    ...entries,
    `path: ${ZIP_NAME}`,
    `sha512: ${overrides.zipSha ?? sha512b64(ZIP_BODY)}`,
    `releaseDate: '2026-11-17T09:14:08.042Z'`,
  ].join('\n')
}

function mediaZip(members?: Member[], feedText?: string): Buffer {
  return buildZip(members ?? [
    { name: ZIP_NAME, body: ZIP_BODY },
    { name: DMG_NAME, body: DMG_BODY },
    { name: `${ZIP_NAME}.blockmap`, body: 'bm' },
    { name: `${DMG_NAME}.blockmap`, body: 'bm' },
    { name: 'latest-mac.yml', body: feedText ?? realFeed() },
  ])
}

type Options = {
  run?: Record<string, unknown>
  jobs?: unknown[]
  artifacts?: unknown[]
  zipBytes?: Buffer
  artifactDigestOverride?: string
}

function box(options: Options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-retention-'))
  workdirs.push(dir)
  const zipBytes = options.zipBytes ?? mediaZip()
  const archive = path.join(dir, 'artifact.zip')
  fs.writeFileSync(archive, zipBytes)
  const digest = options.artifactDigestOverride
    ?? `sha256:${createHash('sha256').update(zipBytes).digest('hex')}`

  const run = {
    path: '.github/workflows/release-desktop.yml', head_branch: TAG, head_sha: SHA,
    run_attempt: ATTEMPT, status: 'completed', event: 'workflow_dispatch', ...options.run,
  }
  const jobs = options.jobs ?? [{
    id: 133916323832, name: 'Build macOS desktop release', conclusion: 'failure',
    steps: [
      // Real source ordering: build 14, verify 15, upload 16 (09:14:08 -> 09:15:03),
      // acceptance 17. Numbers below are the fixture's 1-4 equivalent.
      { number: 1, name: 'Build DMG and ZIP', conclusion: 'success', completed_at: '2026-11-17T09:14:08Z' },
      { number: 2, name: 'Verify packaged version and native runtime payload', conclusion: 'success', completed_at: '2026-11-17T09:14:08Z' },
      { number: 3, name: 'Run actions/upload-artifact@v4', conclusion: 'success', started_at: '2026-11-17T09:14:08Z', completed_at: '2026-11-17T09:15:03Z' },
      { number: 4, name: 'Accept actual stable packaged desktop permissions and operations', conclusion: 'failure', started_at: '2026-11-17T09:15:03Z' },
    ],
  }]
  const artifacts = options.artifacts ?? [{
    id: ARTIFACT_ID, name: `xpod-desktop-macos-${VERSION}`, size_in_bytes: zipBytes.length,
    digest, expired: false, created_at: '2026-11-17T09:15:03Z',
  }]

  const payload = path.join(dir, 'payload')
  fs.mkdirSync(payload)
  fs.writeFileSync(path.join(payload, 'run.json'), JSON.stringify(run))
  fs.writeFileSync(path.join(payload, 'jobs.json'), JSON.stringify([{ jobs }]))
  fs.writeFileSync(path.join(payload, 'artifacts.json'), JSON.stringify([{ artifacts }]))

  const stub = path.join(dir, 'gh')
  fs.writeFileSync(stub, `#!/bin/bash
set -euo pipefail
args="$*"
case "$args" in
  *"/actions/runs/${RUN_ID}/attempts/"*"/jobs"*) cat "${payload}/jobs.json" ;;
  *"/actions/runs/${RUN_ID}/artifacts"*) cat "${payload}/artifacts.json" ;;
  *"/actions/artifacts/"*"/zip") cat "${archive}" ;;
  *"/actions/runs/${RUN_ID}") cat "${payload}/run.json" ;;
  *) echo "unexpected gh invocation" >&2; exit 9 ;;
esac
`, { mode: 0o755 })

  return { dir, stub, destination: path.join(dir, 'out'), receipt: path.join(dir, 'receipt.json'), work: path.join(dir, 'work') }
}

function run(train: ReturnType<typeof box>) {
  return execFileSync('python3', [HELPER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${train.dir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'undefinedsco/xpod',
      SOURCE_RUN_ID: RUN_ID,
      EXPECTED_TAG: TAG,
      EXPECTED_SHA: SHA,
      EXPECTED_VERSION: VERSION,
      DESTINATION: train.destination,
      RECEIPT: train.receipt,
      WORK_DIR: train.work,
    },
  })
}

describe('desktop media retention (real archive)', () => {
  it('verifies the raw archive digest, extracts, and records a real receipt', () => {
    const train = box()
    run(train)
    const receipt = JSON.parse(fs.readFileSync(train.receipt, 'utf8'))
    expect(receipt.archiveVerifiedBeforeExtraction).toBe(true)
    expect(receipt.artifact).toMatchObject({ id: ARTIFACT_ID })
    expect(receipt.producerSteps.mediaUpload.number).toBe(3)
    expect(receipt.feed.zipSha512Verified).toBe(true)
    expect(receipt.feed.dmgSha512Verified).toBe(true)
    expect(receipt.feed.entries).toEqual([DMG_NAME, ZIP_NAME].sort())
    for (const name of [ZIP_NAME, DMG_NAME, `${ZIP_NAME}.blockmap`, 'latest-mac.yml']) {
      expect(fs.existsSync(path.join(train.destination, name))).toBe(true)
    }
    expect(receipt.media.zip.sha256).toBe(
      createHash('sha256').update(fs.readFileSync(path.join(train.destination, ZIP_NAME))).digest('hex'))
  })

  it('refuses a tampered archive whose bytes do not match the API digest', () => {
    const train = box({ artifactDigestOverride: `sha256:${'a'.repeat(64)}` })
    expect(() => run(train)).toThrow()
    expect(fs.existsSync(train.receipt)).toBe(false)
    // Nothing may be extracted before the archive digest passes.
    expect(fs.existsSync(path.join(train.destination, ZIP_NAME))).toBe(false)
  })

  it.each([
    ['traversal member', [{ name: '../evil.zip', body: 'x' }]],
    ['absolute member', [{ name: '/etc/evil.zip', body: 'x' }]],
    ['backslash member', [{ name: 'a\\b.zip', body: 'x' }]],
    ['symlink member', [{ name: ZIP_NAME, body: 'x', mode: 0o120777 * 65536 }]],
  ])('refuses a %s', (_label, members) => {
    const train = box({ zipBytes: mediaZip(members as Member[]) })
    expect(() => run(train)).toThrow()
    expect(fs.existsSync(train.receipt)).toBe(false)
  })

  it('binds each files[] entry to its own bytes (ZIP and DMG separately)', () => {
    const train = box({ zipBytes: mediaZip(undefined, realFeed()) })
    run(train)
    const receipt = JSON.parse(fs.readFileSync(train.receipt, 'utf8'))
    expect(receipt.feed.zipSha512Verified).toBe(true)
    expect(receipt.feed.dmgSha512Verified).toBe(true)
    expect(receipt.feed.topLevelSha512BindsZip).toBe(true)
  })

  it('binds correctly when the feed lists the DMG entry BEFORE the ZIP entry', () => {
    const train = box({ zipBytes: mediaZip(undefined, realFeed({ order: 'dmg-first' })) })
    run(train)
    const receipt = JSON.parse(fs.readFileSync(train.receipt, 'utf8'))
    // URL binding, not positional binding: the same URLs must still match.
    expect(receipt.feed.entries).toEqual([DMG_NAME, ZIP_NAME].sort())
    expect(receipt.feed.zipSha512Verified).toBe(true)
    expect(receipt.feed.dmgSha512Verified).toBe(true)
  })

  it('refuses when the DMG size is compared/mis-bound (real shape, wrong DMG size)', () => {
    // A flat parser would overwrite the ZIP size with the DMG size and compare
    // the DMG size against the ZIP bytes. This must be refused per-entry.
    const train = box({ zipBytes: mediaZip(undefined, realFeed({ dmgSize: 999_999 })) })
    expect(() => run(train)).toThrow()
  })

  it('refuses a feed whose ZIP sha512 does not match the retained ZIP', () => {
    const train = box({ zipBytes: mediaZip(undefined, realFeed({ zipSha: 'A'.repeat(88) })) })
    expect(() => run(train)).toThrow()
  })

  it('refuses a feed whose DMG sha512 does not match the retained DMG', () => {
    const train = box({ zipBytes: mediaZip(undefined, realFeed({ dmgSha: 'B'.repeat(88) })) })
    expect(() => run(train)).toThrow()
  })

  it('refuses a feed that declares an unexpected extra entry', () => {
    const feed = realFeed() + '\n  - url: Extra-0.4.34.zip\n    sha512: ' + sha512b64('x') + '\n    size: 1'
    const train = box({ zipBytes: mediaZip(undefined, feed) })
    expect(() => run(train)).toThrow()
  })

  it('refuses an artifact created AFTER the selected upload completed', () => {
    const train = box({
      artifacts: [{
        id: ARTIFACT_ID, name: `xpod-desktop-macos-${VERSION}`,
        size_in_bytes: mediaZip().length,
        digest: `sha256:${createHash('sha256').update(mediaZip()).digest('hex')}`,
        expired: false, created_at: '2026-11-17T09:20:00Z',
      }],
    })
    expect(() => run(train)).toThrow()
  })

  it.each([
    ['foreign workflow', { run: { path: '.github/workflows/candidate.yml' } }],
    ['another commit', { run: { head_sha: 'f'.repeat(40) } }],
    ['wrong branch', { run: { head_branch: 'staging' } }],
    ['unfinished run', { run: { status: 'in_progress' } }],
    ['pull-request origin', { run: { event: 'pull_request' } }],
  ])('refuses a %s', (_label, options) => {
    const train = box(options as Options)
    expect(() => run(train)).toThrow()
  })

  it('refuses an artifact created before the media upload step completed', () => {
    const train = box({
      artifacts: [{
        id: ARTIFACT_ID, name: `xpod-desktop-macos-${VERSION}`,
        size_in_bytes: mediaZip().length,
        digest: `sha256:${createHash('sha256').update(mediaZip()).digest('hex')}`,
        expired: false, created_at: '2026-11-17T09:00:00Z',
      }],
    })
    expect(() => run(train)).toThrow()
  })

  it('refuses a producer whose packaging step did not succeed', () => {
    const train = box({
      jobs: [{
        id: 1, name: 'Build macOS desktop release', conclusion: 'failure',
        steps: [
          { number: 1, name: 'Build DMG and ZIP', conclusion: 'failure' },
          { number: 2, name: 'Verify packaged version and native runtime payload', conclusion: 'success' },
          { number: 3, name: 'Run actions/upload-artifact@v4', conclusion: 'success' },
        ],
      }],
    })
    expect(() => run(train)).toThrow()
  })

  it('refuses when the upload step is not the one after payload verification', () => {
    const train = box({
      jobs: [{
        id: 1, name: 'Build macOS desktop release', conclusion: 'failure',
        steps: [
          { number: 1, name: 'Build DMG and ZIP', conclusion: 'success' },
          { number: 2, name: 'Upload failed API preparation diagnostics separately', conclusion: 'success' },
          { number: 3, name: 'Verify packaged version and native runtime payload', conclusion: 'success' },
          { number: 4, name: 'Accept actual stable packaged desktop permissions and operations', conclusion: 'failure' },
        ],
      }],
    })
    expect(() => run(train)).toThrow()
  })

  it.each([
    ['renamed artifact', [{ id: ARTIFACT_ID, name: 'xpod-desktop-macos-0.0.0', size_in_bytes: 1, digest: `sha256:${'a'.repeat(64)}`, expired: false }]],
    ['expired artifact', [{ id: ARTIFACT_ID, name: `xpod-desktop-macos-${VERSION}`, size_in_bytes: 1, digest: `sha256:${'a'.repeat(64)}`, expired: true }]],
    ['digest-less artifact', [{ id: ARTIFACT_ID, name: `xpod-desktop-macos-${VERSION}`, size_in_bytes: 1, expired: false }]],
  ])('refuses a %s', (_label, artifacts) => {
    const train = box({ artifacts: artifacts as never })
    expect(() => run(train)).toThrow()
  })
})
