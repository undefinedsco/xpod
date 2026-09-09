import { existsSync } from 'node:fs'
import path from 'node:path'

export interface DockIconApp {
  dock?: {
    setIcon(icon: Electron.NativeImage): void
  }
}

export interface DockIconImageFactory {
  createFromPath(filePath: string): Electron.NativeImage
}

export function resolveDockIconPath({
  appPath,
  moduleDir,
  resourcesPath,
  isPackaged,
  pathExists = existsSync,
}: {
  appPath: string
  moduleDir: string
  resourcesPath: string
  isPackaged: boolean
  pathExists?: (filePath: string) => boolean
}): string | undefined {
  const candidates = isPackaged
    ? [
        path.join(resourcesPath, 'icon.png'),
        path.join(resourcesPath, 'icon.icns'),
      ]
    : [
        path.join(moduleDir, '..', 'assets', 'icon.png'),
        path.join(appPath, 'assets', 'icon.png'),
      ]
  return candidates.find(pathExists)
}

export function installDockIcon({
  app,
  nativeImage,
  platform,
  iconPath,
}: {
  app: DockIconApp
  nativeImage: DockIconImageFactory
  platform: NodeJS.Platform
  iconPath?: string
}): boolean {
  if (platform !== 'darwin' || !app.dock || !iconPath) return false
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) return false
  app.dock.setIcon(icon)
  return true
}
