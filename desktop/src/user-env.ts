import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function desktopEnvPath(userDataDir: string): string {
  return path.join(userDataDir, '.env')
}

export function ensureDesktopEnvFile(userDataDir: string): string {
  const envPath = desktopEnvPath(userDataDir)
  if (existsSync(envPath)) {
    removeLegacyInternalPortDefaults(envPath)
    return envPath
  }

  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(envPath, defaultDesktopEnv(userDataDir), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodSync(envPath, 0o600)
  return envPath
}

function removeLegacyInternalPortDefaults(envPath: string): void {
  const content = readFileSync(envPath, 'utf8')
  const migrated = content
    .split('\n')
    .filter((line) => line !== 'CSS_PORT=3001'
      && line !== 'API_PORT=3002'
      && line !== 'CSS_BASE_URL=http://127.0.0.1:3000/')
  if (isGeneratedLegacyDesktopConfig(content) && !migrated.some((line) => line.trim().startsWith('oidcIssuer='))) {
    migrated.splice(2, 0, 'oidcIssuer=https://id.undefineds.co/')
  }
  const nextContent = migrated.join('\n')
  if (nextContent === content) return
  writeFileSync(envPath, nextContent, { encoding: 'utf8', mode: 0o600 })
  chmodSync(envPath, 0o600)
}

function isGeneratedLegacyDesktopConfig(content: string): boolean {
  return content.includes('# Xpod local runtime configuration')
    || (content.includes('XPOD_EDITION=local')
      && content.includes('CSS_IDENTITY_DB_URL=sqlite:')
      && content.includes('CSS_SPARQL_ENDPOINT=sqlite:'))
}

export function loadDesktopEnvFile(envPath: string, target: NodeJS.ProcessEnv = process.env): void {
  const content = readFileSync(envPath, 'utf8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    target[key] ??= value
  }
}

function defaultDesktopEnv(userDataDir: string): string {
  return [
    '# Xpod local runtime configuration',
    'XPOD_EDITION=local',
    'XPOD_AI_CLIENT_CONFIGURATION_ENABLED=true',
    'oidcIssuer=https://id.undefineds.co/',
    `CSS_IDENTITY_DB_URL=sqlite:${path.join(userDataDir, 'identity.sqlite')}`,
    `CSS_SPARQL_ENDPOINT=sqlite:${path.join(userDataDir, 'quadstore.sqlite')}`,
    `CSS_RDF_INDEX_PATH=${path.join(userDataDir, 'rdf-index.sqlite')}`,
    `CSS_ROOT_FILE_PATH=${path.join(userDataDir, 'data')}`,
    '',
  ].join('\n')
}
