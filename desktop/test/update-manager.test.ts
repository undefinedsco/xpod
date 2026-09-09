import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  DesktopUpdateManager,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  defaultDesktopUpdateFeedUrl,
  normalizeUpdateFeedUrl,
  resolveDesktopUpdateConfig,
  withDefaultDesktopUpdateFeed,
  type DesktopAutoUpdater,
} from '../src/update-manager'

class FakeAutoUpdater extends EventEmitter implements DesktopAutoUpdater {
  feedUrl: string | undefined
  checks = 0
  installs = 0

  setFeedURL(options: { url: string }): void {
    this.feedUrl = options.url
  }

  checkForUpdates(): void {
    this.checks += 1
  }

  quitAndInstall(): void {
    this.installs += 1
  }
}

describe('DesktopUpdateManager', () => {
  it('stays disabled until an update feed is configured', () => {
    const updater = new FakeAutoUpdater()
    const manager = new DesktopUpdateManager({ updater })

    expect(manager.start()).toEqual({ status: 'disabled' })
    expect(updater.checks).toBe(0)
  })

  it('rejects unsafe non-local HTTP update feeds', () => {
    const updater = new FakeAutoUpdater()
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'http://updates.example/latest',
    })

    expect(manager.start()).toEqual({
      status: 'error',
      message: 'Update feed must be HTTPS or a local test URL.',
    })
    expect(updater.feedUrl).toBeUndefined()
    expect(updater.checks).toBe(0)
  })

  it('checks, senses a new version and downloads it without an unexpected restart by default', () => {
    const states: string[] = []
    const updater = new FakeAutoUpdater()
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'http://127.0.0.1:49152/update',
      onStateChange: (state) => states.push(`${state.status}:${state.version ?? ''}`),
    })

    expect(manager.start()).toEqual({ status: 'checking' })
    expect(updater.feedUrl).toBe('http://127.0.0.1:49152/update')
    expect(updater.checks).toBe(1)

    updater.emit('update-available', undefined, '0.1.1')
    expect(manager.snapshot()).toEqual({ status: 'downloading', version: '0.1.1' })

    updater.emit('update-downloaded', undefined, undefined, '0.1.1')
    expect(manager.snapshot()).toEqual({ status: 'downloaded', version: '0.1.1' })
    expect(updater.installs).toBe(0)
    expect(states).toEqual([
      'checking:',
      'available:0.1.1',
      'downloading:0.1.1',
      'downloaded:0.1.1',
    ])
  })

  it('supports manual install when auto-install is disabled', () => {
    const updater = new FakeAutoUpdater()
    const downloaded: string[] = []
    let installFromNotification: (() => unknown) | undefined
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'https://updates.example/xpod',
      autoInstall: false,
      onUpdateDownloaded: (state, install) => {
        downloaded.push(`${state.status}:${state.version ?? ''}`)
        installFromNotification = install
      },
    })

    manager.start()
    updater.emit('update-downloaded', undefined, '0.1.2')

    expect(updater.installs).toBe(0)
    expect(downloaded).toEqual(['downloaded:0.1.2'])
    installFromNotification?.()
    expect(updater.installs).toBe(1)
  })

  it('does not show a restart prompt when unattended install is enabled', () => {
    const updater = new FakeAutoUpdater()
    let prompts = 0
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'https://updates.example/xpod',
      autoInstall: true,
      onUpdateDownloaded: () => { prompts += 1 },
      onAutoInstallReady: (install) => install(),
    })

    manager.start()
    updater.emit('update-downloaded', undefined, '0.1.3')

    expect(prompts).toBe(0)
    expect(updater.installs).toBe(1)
  })

  it('supports unattended install when acceptance or deployment opts in', () => {
    const updater = new FakeAutoUpdater()
    const scheduled: Array<() => void> = []
    let timerId = 0
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'https://updates.example/xpod',
      autoInstall: true,
      setTimeout: (callback, delayMs) => {
        if (delayMs !== 1_000) return ++timerId as unknown as ReturnType<typeof setTimeout>
        scheduled.push(callback)
        return ++timerId as unknown as ReturnType<typeof setTimeout>
      },
    })

    manager.start()
    updater.emit('update-downloaded', undefined, '0.1.2')

    expect(updater.installs).toBe(0)
    scheduled.at(-1)?.()
    expect(updater.installs).toBe(1)
  })

  it('lets the host mark update-quit semantics before unattended installation', () => {
    const updater = new FakeAutoUpdater()
    const events: string[] = []
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'https://updates.example/xpod',
      autoInstall: true,
      onAutoInstallReady: (install) => {
        events.push('mark-update-quit')
        install()
      },
    })

    manager.start()
    updater.emit('update-downloaded', undefined, '0.1.2')

    expect(events).toEqual(['mark-update-quit'])
    expect(updater.installs).toBe(1)
  })

  it('can defer the initial check and still expose a manual check action', () => {
    const updater = new FakeAutoUpdater()
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'https://updates.example/xpod',
      autoCheck: false,
    })

    expect(manager.start()).toEqual({ status: 'idle' })
    expect(updater.checks).toBe(0)
    expect(manager.checkNow()).toEqual({ status: 'checking' })
    expect(updater.checks).toBe(1)
  })

  it('does not issue duplicate checks while a check or download is in progress', () => {
    const updater = new FakeAutoUpdater()
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'https://updates.example/xpod',
    })

    manager.start()
    manager.checkNow()
    expect(updater.checks).toBe(1)
    updater.emit('update-available', undefined, '0.1.3')
    manager.checkNow()
    expect(updater.checks).toBe(1)
  })

  it('maps updater exceptions to a compact, user-facing error', () => {
    const updater = new FakeAutoUpdater()
    updater.checkForUpdates = () => {
      throw new Error('  network connection\nfailed '.repeat(40))
    }
    const manager = new DesktopUpdateManager({
      updater,
      feedUrl: 'https://updates.example/xpod',
    })

    expect(manager.start().status).toBe('error')
    expect(manager.snapshot().message).toBe('Could not reach the update service. Check your connection and try again.')
    expect(manager.snapshot().message).not.toContain('\n')
  })
})

describe('normalizeUpdateFeedUrl', () => {
  it('accepts HTTPS and loopback HTTP feeds only', () => {
    expect(normalizeUpdateFeedUrl('https://updates.example/xpod')).toBe('https://updates.example/xpod')
    expect(normalizeUpdateFeedUrl('http://localhost:3000/update')).toBe('http://localhost:3000/update')
    expect(normalizeUpdateFeedUrl('http://127.0.0.1:3000/update')).toBe('http://127.0.0.1:3000/update')
    expect(normalizeUpdateFeedUrl('http://updates.example/xpod')).toBeUndefined()
    expect(normalizeUpdateFeedUrl('file:///tmp/update')).toBeUndefined()
    expect(normalizeUpdateFeedUrl('https://user:pass@updates.example/xpod')).toBeUndefined()
    expect(normalizeUpdateFeedUrl('https://updates.example/xpod#fragment')).toBeUndefined()
  })
})

describe('resolveDesktopUpdateConfig', () => {
  it('uses safe defaults and parses local acceptance configuration', () => {
    expect(resolveDesktopUpdateConfig({})).toEqual({
      feedUrl: undefined,
      autoCheck: true,
      autoInstall: false,
      checkIntervalMs: DEFAULT_UPDATE_CHECK_INTERVAL_MS,
    })
    expect(resolveDesktopUpdateConfig({
      XPOD_DESKTOP_UPDATE_FEED_URL: ' http://127.0.0.1:43199/update ',
      XPOD_DESKTOP_AUTO_CHECK_UPDATES: 'off',
      XPOD_DESKTOP_AUTO_INSTALL_UPDATES: '0',
      XPOD_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '1500.8',
    })).toEqual({
      feedUrl: 'http://127.0.0.1:43199/update',
      autoCheck: false,
      autoInstall: false,
      checkIntervalMs: 1500,
    })
  })

  it('enables the official feed for packaged macOS builds without overriding an explicit feed', () => {
    const base = resolveDesktopUpdateConfig({})
    expect(withDefaultDesktopUpdateFeed(base, {
      isPackaged: true,
      version: '0.3.71',
      platform: 'darwin',
      arch: 'arm64',
    }).feedUrl).toBe('https://update.electronjs.org/undefinedsco/xpod/darwin-arm64/0.3.71')
    expect(defaultDesktopUpdateFeedUrl({
      isPackaged: false,
      version: '0.3.71',
      platform: 'darwin',
    })).toBeUndefined()

    const explicit = resolveDesktopUpdateConfig({
      XPOD_DESKTOP_UPDATE_FEED_URL: 'http://127.0.0.1:43199/update',
    })
    expect(withDefaultDesktopUpdateFeed(explicit, {
      isPackaged: true,
      version: '0.3.71',
      platform: 'darwin',
    }).feedUrl).toBe('http://127.0.0.1:43199/update')
  })
})
