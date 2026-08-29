import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { installDockIcon, resolveDockIconPath } from '../src/dock-icon'

describe('desktop Dock icon', () => {
  it('resolves the Xpod asset in development', () => {
    const iconPath = resolveDockIconPath({
      appPath: '/repo/desktop',
      moduleDir: '/repo/desktop/dist',
      resourcesPath: '/electron/resources',
      isPackaged: false,
      pathExists: (candidate) => candidate === '/repo/desktop/assets/icon.png',
    })

    expect(iconPath).toBe(path.normalize('/repo/desktop/assets/icon.png'))
  })

  it('resolves the packaged Xpod icon resource', () => {
    const iconPath = resolveDockIconPath({
      appPath: '/Applications/Xpod.app/Contents/Resources/app.asar',
      moduleDir: '/Applications/Xpod.app/Contents/Resources/app.asar/dist',
      resourcesPath: '/Applications/Xpod.app/Contents/Resources',
      isPackaged: true,
      pathExists: (candidate) => candidate.endsWith('/icon.icns'),
    })

    expect(iconPath).toBe(path.normalize('/Applications/Xpod.app/Contents/Resources/icon.icns'))
  })

  it('sets a non-empty Xpod image on the macOS Dock', () => {
    const applied: unknown[] = []
    const image = { isEmpty: () => false } as unknown as Electron.NativeImage

    expect(installDockIcon({
      app: { dock: { setIcon: (value) => applied.push(value) } },
      nativeImage: { createFromPath: () => image },
      platform: 'darwin',
      iconPath: '/repo/desktop/assets/icon.png',
    })).toBe(true)
    expect(applied).toEqual([image])
  })

  it('does not touch the Dock outside macOS or with an empty image', () => {
    const applied: unknown[] = []
    const app = { dock: { setIcon: (value: Electron.NativeImage) => applied.push(value) } }
    expect(installDockIcon({
      app,
      nativeImage: { createFromPath: () => ({ isEmpty: () => false }) as Electron.NativeImage },
      platform: 'linux',
      iconPath: '/repo/desktop/assets/icon.png',
    })).toBe(false)
    expect(installDockIcon({
      app,
      nativeImage: { createFromPath: () => ({ isEmpty: () => true }) as Electron.NativeImage },
      platform: 'darwin',
      iconPath: '/repo/desktop/assets/icon.png',
    })).toBe(false)
    expect(applied).toEqual([])
  })
})
