import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// 全局持久化 provisionCode：用户从 /.account/?provisionCode=xxx 进入后，
// 无论经过注册、登录多少步，最终到 AccountPage 创建 Pod 时 provisionCode 都在。
try {
  const pc = new URLSearchParams(location.search).get('provisionCode')
  if (pc) sessionStorage.setItem('provisionCode', pc)
} catch { /* ignore */ }

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)