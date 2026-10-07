const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('xpodDesktop', {
  platform: process.platform,
  publishAttention(snapshot: unknown): void {
    ipcRenderer.send('xpod-desktop:attention', snapshot)
  },
  deviceRuntime: {
    getRuntimeSettings() { return ipcRenderer.invoke('xpod:get-runtime-settings') },
    setLaunchAtLogin(enabled: boolean) { return ipcRenderer.invoke('xpod:set-launch-at-login', enabled) },
    setAutoRestart(enabled: boolean) { return ipcRenderer.invoke('xpod:set-auto-restart', enabled) },
    runtimeAction(action: 'start' | 'stop' | 'restart') { return ipcRenderer.invoke('xpod:runtime-action', action) },
    showDataDirectory() { return ipcRenderer.invoke('xpod:show-data-directory') },
    selectDataDirectory() { return ipcRenderer.invoke('xpod:select-data-directory') },
  },
  onApprovalDecision(decide: (input: { approvalId: string; decision: 'approved' | 'rejected' }) => void): () => void {
    const listener = (_event: import('electron').IpcRendererEvent, input: unknown) => {
      if (!input || typeof input !== 'object') return
      const value = input as { approvalId?: unknown; decision?: unknown }
      if (typeof value.approvalId === 'string' && (value.decision === 'approved' || value.decision === 'rejected')) {
        decide({ approvalId: value.approvalId, decision: value.decision })
      }
    }
    ipcRenderer.on('xpod:approval-decision', listener)
    ipcRenderer.send('xpod:approval-ready', true)
    return () => {
      ipcRenderer.removeListener('xpod:approval-decision', listener)
      ipcRenderer.send('xpod:approval-ready', false)
    }
  },
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
