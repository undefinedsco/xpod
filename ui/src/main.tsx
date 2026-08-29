import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles/global.css'
import { XpodThemeProvider } from './theme/XpodThemeProvider.tsx'
import { initializeXpodTheme } from './theme/xpod-theme-state'
import { syncProvisionCodeFromAuthContext } from './utils/pod'

initializeXpodTheme()

// 优先传递服务端当前 OIDC interaction 的本机开通上下文；普通账号页面
// 才使用 URL/会话缓存，避免把上一次本机开通误用于另一个登录流程。
try {
  syncProvisionCodeFromAuthContext()
} catch { /* ignore */ }

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <XpodThemeProvider>
      <App />
    </XpodThemeProvider>
  </React.StrictMode>,
)
