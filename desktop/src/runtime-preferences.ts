import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadDesktopEnvFile } from './user-env.js'

/** Desktop policy only; runtime configuration stays in the existing env file. */
export class RuntimePreferences {
  private readonly file: string
  constructor(userDataDirectory: string) { this.file = path.join(userDataDirectory, 'runtime-preferences.json') }
  read(): { autoRestart: boolean } {
    if (!existsSync(this.file)) return { autoRestart: true }
    const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!value || typeof value !== 'object' || !('autoRestart' in value) || typeof value.autoRestart !== 'boolean') throw new Error('Invalid runtime preferences')
    return { autoRestart: value.autoRestart }
  }
  setAutoRestart(autoRestart: boolean): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify({ autoRestart }), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}

/** Read on every launch so a saved data-directory change survives a desktop restart. */
export function readRuntimeDataEnvironment(envPath: string | undefined): NodeJS.ProcessEnv {
  if (!envPath || !existsSync(envPath)) return {}
  const persisted: NodeJS.ProcessEnv = {}
  loadDesktopEnvFile(envPath, persisted)
  return persisted.CSS_ROOT_FILE_PATH === undefined ? {} : { CSS_ROOT_FILE_PATH: persisted.CSS_ROOT_FILE_PATH }
}
