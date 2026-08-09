const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('xpodDesktop', {
  setIdentity(identity: { label: string; webId?: string; podUrl?: string } | null): void {
    ipcRenderer.send('xpod:identity', identity)
  },
})
