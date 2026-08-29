/**
 * ChatPage - ChatKit 聊天页面
 * 
 * 使用 OpenAI ChatKit React 组件连接到本地 ChatKit 后端
 */

import { useChatKit, ChatKit } from '@openai/chatkit-react';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContextValue';
import { useState, useCallback } from 'react';
import { useXpodTheme } from '../theme/xpod-theme-context';
import { storedAccountTokenHeaders } from '../utils/account-session';

// 获取 API URL（默认指向 Gateway）
const API_URL = import.meta.env.VITE_CHATKIT_API_URL || 'http://localhost:3000/chatkit';
// 开发环境使用 localhost 域名密钥
const DOMAIN_KEY = import.meta.env.VITE_CHATKIT_DOMAIN_KEY || 'domain_pk_localhost_dev';

export function ChatPage() {
  const { isLoggedIn } = useAuth();
  const { resolvedTheme } = useXpodTheme();
  const [apiKey, setApiKey] = useState<string>('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  // 自定义 fetch 函数，添加认证头
  const authenticatedFetch = useCallback(async (url: string | URL | Request, options: RequestInit = {}) => {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> || {}),
    };
    
    if (apiKey) {
      // 使用 API Key 认证 (sk-xxx 格式)
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      Object.assign(headers, storedAccountTokenHeaders(headers));
    }
    
    return fetch(url, { ...options, headers, credentials: 'include' });
  }, [apiKey]);

  // 使用 useChatKit hook
  const chatKit = useChatKit({
    api: {
      url: API_URL,
      domainKey: DOMAIN_KEY,
      fetch: authenticatedFetch,
    },
    theme: resolvedTheme,
    header: {
      enabled: true,
      title: {
        enabled: true,
        text: 'Xpod Chat',
      },
    },
    history: {
      enabled: true,
    },
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <a
              href="/status/overview"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label="Back to status"
            >
              <ArrowLeft aria-hidden="true" className="h-5 w-5" strokeWidth={1.8} />
            </a>
            <h1 className="text-xl font-semibold text-foreground">Chat</h1>
          </div>
          <div className="flex items-center space-x-4">
            {/* API Key 输入 */}
            <button
              onClick={() => setShowApiKeyInput(!showApiKeyInput)}
              className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <KeyRound aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
              {apiKey ? 'API Key set' : 'Set API Key'}
            </button>
            {/* 登录状态 */}
            <div className="text-sm text-muted-foreground">
              {isLoggedIn ? (
                <span className="text-primary">● Logged in</span>
              ) : (
                <a href="/status/overview" className="text-primary hover:text-primary/80">
                  Login
                </a>
              )}
            </div>
          </div>
        </div>
        
        {/* API Key 输入框 */}
        {showApiKeyInput && (
          <div className="max-w-7xl mx-auto px-4 py-2 border-t border-border bg-muted/40">
            <div className="flex items-center space-x-2">
              <input
                type="password"
                placeholder="Enter API Key (sk-xxx)"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:border-primary"
              />
              <button
                onClick={() => setShowApiKeyInput(false)}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Get your API Key from the Account page after logging in.
            </p>
          </div>
        )}
      </header>

      {/* Chat Container */}
      <main className="max-w-4xl mx-auto p-4">
        <div className="overflow-hidden rounded-xl border border-border bg-card" style={{ height: 'calc(100dvh - 180px)' }}>
          <ChatKit 
            control={chatKit.control}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
        
        {/* 调试信息 */}
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground">
          <p><strong>API URL:</strong> {API_URL}</p>
          <p><strong>Domain Key:</strong> {DOMAIN_KEY}</p>
          <p><strong>Auth:</strong> {apiKey ? 'API Key' : isLoggedIn ? 'Session' : 'None'}</p>
        </div>
      </main>
    </div>
  );
}
