const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('xpodDesktop', {
  platform: process.platform,
  /** Local recovery only; does not claim the remote IdP cancelled its interaction. */
  cancelLogin(): Promise<void> {
    return ipcRenderer.invoke('xpod:cancel-login')
  },
  onNavigate(navigate: (route: string) => void): () => void {
    const listener = (_event: import('electron').IpcRendererEvent, route: unknown) => {
      if (typeof route === 'string') navigate(route)
    }
    ipcRenderer.on('xpod:navigate', listener)
    ipcRenderer.send('xpod:navigation-ready', true)
    return () => {
      ipcRenderer.removeListener('xpod:navigate', listener)
      ipcRenderer.send('xpod:navigation-ready', false)
    }
  },
  setIdentity(identity: { label: string; webId?: string; podUrl?: string } | null): void {
    ipcRenderer.send('xpod:identity', identity)
  },
  setWindowMode(mode: 'auth' | 'account' | 'workspace'): void {
    if (mode !== 'auth' && mode !== 'account' && mode !== 'workspace') return
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
