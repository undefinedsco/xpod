import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDesktopEnvFile, loadDesktopEnvFile } from '../src/user-env.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop user env', () => {
  it('creates a private first-run config with desktop runtime paths', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-desktop-env-'))
    roots.push(root)

    const envPath = ensureDesktopEnvFile(root)
    const content = readFileSync(envPath, 'utf8')

    expect(envPath).toBe(path.join(root, '.env'))
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    expect(content).toContain('XPOD_AI_CLIENT_CONFIGURATION_ENABLED=true')
    expect(content).toContain('oidcIssuer=https://id.undefineds.co/')
    expect(content).not.toContain('CSS_BASE_URL=')
    expect(content).not.toContain('CSS_PORT=')
    expect(content).not.toContain('API_PORT=')
    expect(content).toContain(`CSS_IDENTITY_DB_URL=sqlite:${path.join(root, 'identity.sqlite')}`)
  })

  it('preserves a custom existing user config', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-desktop-env-'))
    roots.push(root)
    const envPath = path.join(root, '.env')
    writeFileSync(envPath, 'XPOD_EDITION=local\nCUSTOM_SETTING=yes\n')

    ensureDesktopEnvFile(root)

    expect(readFileSync(envPath, 'utf8')).toBe('XPOD_EDITION=local\nCUSTOM_SETTING=yes\n')
  })

  it('removes obsolete generated internal ports while preserving other values', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-desktop-env-'))
    roots.push(root)
    const envPath = path.join(root, '.env')
    writeFileSync(envPath, [
      '# Xpod local runtime configuration',
      'XPOD_EDITION=local',
      'CSS_BASE_URL=http://127.0.0.1:3000/',
      'CSS_PORT=3001',
      'API_PORT=3002',
      'XPOD_PORT=4567',
      '',
    ].join('\n'))

    ensureDesktopEnvFile(root)

    expect(readFileSync(envPath, 'utf8')).toBe([
      '# Xpod local runtime configuration',
      'XPOD_EDITION=local',
      'oidcIssuer=https://id.undefineds.co/',
      'XPOD_PORT=4567',
      '',
    ].join('\n'))
  })

  it('loads file values without replacing explicit environment overrides', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-desktop-env-'))
    roots.push(root)
    const envPath = path.join(root, '.env')
    writeFileSync(envPath, 'CSS_BASE_URL=http://127.0.0.1:3000/\nCSS_PORT=3001\n')
    const target: NodeJS.ProcessEnv = { CSS_PORT: '7777' }

    loadDesktopEnvFile(envPath, target)

    expect(target.CSS_BASE_URL).toBe('http://127.0.0.1:3000/')
    expect(target.CSS_PORT).toBe('7777')
  })
})
