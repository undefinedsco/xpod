// Dashboard API - Bridge between UI and backend

export interface ServiceStatus {
  css?: {
    running: boolean;
    port: number | null;
    baseUrl: string;
  };
  api?: {
    running: boolean;
    port: number | null;
    baseUrl: string;
  };
  orchestrator?: {
    port: number;
    baseUrl: string;
  };
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

// Use HTTP API instead of Tauri
const API_BASE = '';

export async function getServiceStatus(): Promise<ServiceStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/service/status`);
    if (res.ok) {
      const data = await res.json();
      // Handle array response from Supervisor
      if (Array.isArray(data)) {
        const cssState = data.find((s: any) => s.name === 'css');
        const apiState = data.find((s: any) => s.name === 'api');
        
        return {
          css: {
            running: cssState?.status === 'running',
            port: 3002, // Default CSS port
            baseUrl: 'http://localhost:3002'
          },
          api: {
            running: apiState?.status === 'running',
            port: 3005, // Default API port
            baseUrl: 'http://localhost:3005'
          }
        };
      }
      return data;
    }
  } catch (e) {
    console.error('Failed to get service status:', e);
  }
  return null;
}

export interface LogFilterOptions {
  level?: 'all' | 'info' | 'warn' | 'error';
  source?: 'all' | 'xpod' | 'css' | 'api';
  limit?: number;
}

export async function getLogs(options?: LogFilterOptions): Promise<LogEntry[]> {
  try {
    const params = new URLSearchParams();
    if (options?.level && options.level !== 'all') params.set('level', options.level);
    if (options?.source && options.source !== 'all') params.set('source', options.source);
    if (options?.limit) params.set('limit', options.limit.toString());
    
    const queryString = params.toString();
    const url = `${API_BASE}/service/logs${queryString ? '?' + queryString : ''}`;
    
    const res = await fetch(url);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get logs:', e);
  }
  return [];
}

export async function getServiceUrl(): Promise<string> {
  const status = await getServiceStatus();
  return status?.orchestrator?.baseUrl || window.location.origin;
}

// Mock implementations for development
export const mockService = {
  async getServiceStatus(): Promise<ServiceStatus> {
    return {
      css: { running: true, port: 3001, baseUrl: 'http://localhost:3001' },
      api: { running: true, port: 3002, baseUrl: 'http://localhost:3002' },
      orchestrator: { port: 3100, baseUrl: 'http://localhost:3100' },
    };
  },
  async getServiceUrl() { return 'http://localhost:3100'; },
};
