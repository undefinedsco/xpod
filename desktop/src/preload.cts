const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('xpodDesktop', {
  platform: process.platform,
  setIdentity(identity: { label: string; webId?: string; podUrl?: string } | null): void {
    ipcRenderer.send('xpod:identity', identity)
  },
  setWindowMode(mode: 'auth' | 'workspace'): void {
    if (mode !== 'auth' && mode !== 'workspace') return
    ipcRenderer.send('xpod:window-mode', mode)
  },
  ...(process.env.XPOD_DESKTOP_ACCEPTANCE === '1'
    ? {
      /** Acceptance-only hook; absent from packaged and normal development runs. */
      closeWindowForAcceptance(): void {
        ipcRenderer.send('xpod:acceptance:close-window')
      },
      /** Acceptance-only hook; exercises the same before-quit cleanup. */
      quitForAcceptance(): void {
        ipcRenderer.send('xpod:acceptance:quit')
      },
    }
    : {}),
})
