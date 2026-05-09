/**
 * ChatPage - ChatKit 聊天页面
 * 
 * 使用 OpenAI ChatKit React 组件连接到本地 ChatKit 后端
 */

import { useChatKit, ChatKit } from '@openai/chatkit-react';
import { useAuth } from '../context/AuthContext';
import { useState, useCallback } from 'react';
import { storedAccountTokenHeaders } from '../utils/account-session';

// 获取 API URL（默认指向 Gateway）
const API_URL = import.meta.env.VITE_CHATKIT_API_URL || 'http://localhost:3000/chatkit';
// 开发环境使用 localhost 域名密钥
const DOMAIN_KEY = import.meta.env.VITE_CHATKIT_DOMAIN_KEY || 'domain_pk_localhost_dev';

export function ChatPage() {
  const { isLoggedIn } = useAuth();
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
    theme: 'light',
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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <a href="/.account/" className="text-gray-500 hover:text-gray-700">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </a>
            <h1 className="text-xl font-semibold text-gray-900">Chat</h1>
          </div>
          <div className="flex items-center space-x-4">
            {/* API Key 输入 */}
            <button
              onClick={() => setShowApiKeyInput(!showApiKeyInput)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              {apiKey ? '🔑 API Key Set' : 'Set API Key'}
            </button>
            {/* 登录状态 */}
            <div className="text-sm text-gray-500">
              {isLoggedIn ? (
                <span className="text-green-600">● Logged in</span>
              ) : (
                <a href="/.account/login/" className="text-blue-600 hover:text-blue-800">
                  Login
                </a>
              )}
            </div>
          </div>
        </div>
        
        {/* API Key 输入框 */}
        {showApiKeyInput && (
          <div className="max-w-7xl mx-auto px-4 py-2 border-t bg-gray-50">
            <div className="flex items-center space-x-2">
              <input
                type="password"
                placeholder="Enter API Key (sk-xxx)"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => setShowApiKeyInput(false)}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Get your API Key from the Account page after logging in.
            </p>
          </div>
        )}
      </header>

      {/* Chat Container */}
      <main className="max-w-4xl mx-auto p-4">
        <div className="bg-white rounded-lg shadow-lg overflow-hidden" style={{ height: 'calc(100vh - 180px)' }}>
          <ChatKit 
            control={chatKit.control}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
        
        {/* 调试信息 */}
        <div className="mt-4 p-4 bg-gray-100 rounded-lg text-xs text-gray-600">
          <p><strong>API URL:</strong> {API_URL}</p>
          <p><strong>Domain Key:</strong> {DOMAIN_KEY}</p>
          <p><strong>Auth:</strong> {apiKey ? 'API Key' : isLoggedIn ? 'Session' : 'None'}</p>
        </div>
      </main>
    </div>
  );
}
