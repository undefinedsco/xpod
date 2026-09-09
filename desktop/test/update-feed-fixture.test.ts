import { describe, expect, it } from 'bun:test'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

interface FixtureHandle {
  child: ChildProcessWithoutNullStreams
  baseUrl: string
  close: () => Promise<void>
}

describe('local macOS update feed fixture', () => {
  it('serves the Electron JSON protocol for a newer version', async () => {
    const fixture = await startFixture(['--version', '0.1.1'])
    try {
      const response = await fetch(`${fixture.baseUrl}/update/darwin?current_version=0.1.0`)
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body).toMatchObject({
        name: '0.1.1',
        notes: 'Xpod 0.1.1 is ready.',
      })
      expect(typeof body.url).toBe('string')
      expect(body.pub_date).toEqual(expect.any(String))
    } finally {
      await fixture.close()
    }
  })

  it('returns 204 when the running version is current or newer', async () => {
    const fixture = await startFixture(['--version', '0.1.1'])
    try {
      const current = await fetch(`${fixture.baseUrl}/update/darwin?current_version=0.1.1`)
      expect(current.status).toBe(204)
      const newer = await fetch(`${fixture.baseUrl}/update/darwin?current_version=0.1.2`)
      expect(newer.status).toBe(204)
    } finally {
      await fixture.close()
    }
  })

  it('returns a deterministic error response for failure acceptance', async () => {
    const fixture = await startFixture([])
    try {
      const response = await fetch(`${fixture.baseUrl}/update/darwin?mode=error`)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: 'fixture_error',
        message: 'Synthetic update feed failure for acceptance testing.',
      })
    } finally {
      await fixture.close()
    }
  })
})

async function startFixture(args: string[]): Promise<FixtureHandle> {
  const script = path.resolve(import.meta.dir, '../scripts/update-feed-fixture.mjs')
  const child = spawn('node', [script, '--port', '0', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let output = ''
  const ready = new Promise<string>((resolve, reject) => {
    const onData = (chunk: string): void => {
      output += chunk
      const match = output.match(/XPOD_UPDATE_FIXTURE_READY (http:\/\/127\.0\.0\.1:\d+\/update\/darwin)/)
      if (match) {
        child.stdout.off('data', onData)
        resolve(match[1])
      }
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.once('exit', (code) => {
      reject(new Error(`fixture exited before ready (${code}): ${output}`))
    })
  })

  const baseUrl = await ready
  return {
    child,
    baseUrl,
    close: async () => {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await once(child, 'exit')
    },
  }
}
