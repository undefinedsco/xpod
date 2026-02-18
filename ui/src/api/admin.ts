/**
 * Admin API - 管理接口
 */

export interface ServiceState {
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'crashed';
  pid?: number;
  uptime?: number;
  restartCount: number;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
}

export interface AdminStatus {
  status: string;
  pid: number;
  ppid: number;
  uptime: number;
  env: {
    CSS_BASE_URL?: string;
    CSS_EDITION?: string;
    CSS_PORT?: string;
  };
  configs: Array<{
    name: string;
    path: string;
    exists: boolean;
  }>;
}

export interface AdminConfig {
  env: Record<string, string>;
  configFiles: Array<{
    name: string;
    path: string;
    exists: boolean;
  }>;
}

export interface PublicIpCheckResult {
  status: 'pass' | 'fail' | 'unknown';
  publicIp: string | null;
  baseUrl: string;
  detail: string;
}

const API_BASE = '/api/admin';

/**
 * 获取 xpod 状态
 */
export async function getAdminStatus(): Promise<AdminStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/status`);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get admin status:', e);
  }
  return null;
}

/**
 * 获取配置
 */
export async function getAdminConfig(): Promise<AdminConfig | null> {
  try {
    const res = await fetch(`${API_BASE}/config`);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get admin config:', e);
  }
  return null;
}

export async function getPublicIpCheck(baseUrl?: string): Promise<PublicIpCheckResult | null> {
  try {
    const qs = baseUrl ? '?baseUrl=' + encodeURIComponent(baseUrl) : '';
    const res = await fetch(API_BASE + '/public-ip' + qs);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get public ip check:', e);
  }
  return null;
}

/**
 * 更新配置
 */
export async function updateAdminConfig(env: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env }),
    });
    return res.ok;
  } catch (e) {
    console.error('Failed to update admin config:', e);
    return false;
  }
}

/**
 * 触发重启
 */
export async function triggerRestart(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/restart`, {
      method: 'POST',
    });
    return res.ok;
  } catch (e) {
    console.error('Failed to trigger restart:', e);
    return false;
  }
}

/**
 * 获取 Gateway 状态（子进程状态）
 */
export async function getGatewayStatus(): Promise<ServiceState[] | null> {
  try {
    const res = await fetch('/service/status');
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get gateway status:', e);
  }
  return null;
}

/**
 * 获取日志 (从 Gateway/Supervisor)
 */
export async function getLogs(options?: {
  limit?: number;
  level?: string;
  source?: string;
}): Promise<LogEntry[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.level && options.level !== 'all') params.set('level', options.level);
    if (options?.source && options.source !== 'all') params.set('source', options.source);

    // 调用 Gateway 的 /service/logs 获取所有子进程日志
    const res = await fetch(`/service/logs?${params}`);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get logs:', e);
  }
  return [];
}

/**
 * 订阅实时日志 (SSE)
 */
export function subscribeLogs(
  onLog: (logs: LogEntry[]) => void,
  onError?: (error: Event) => void
): () => void {
  const eventSource = new EventSource('/service/logs/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.logs) {
        onLog(data.logs);
      }
    } catch (e) {
      console.error('Failed to parse log data:', e);
    }
  };

  eventSource.onerror = (error) => {
    console.error('Log stream error:', error);
    onError?.(error);
  };

  // Return unsubscribe function
  return () => {
    eventSource.close();
  };
}


export interface DdnsStatus {
  enabled: boolean;
  allocated: boolean;
  fqdn: string | null;
  baseUrl: string;
  mode: 'direct' | 'tunnel' | 'unknown';
  tunnelProvider: string;
  ipv4: string | null;
  ipv6: string | null;
  detail: string;
}

export async function getDdnsStatus(): Promise<DdnsStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/ddns`);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Failed to get ddns status:', e);
  }
  return null;
}

export async function refreshDdnsStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/ddns/refresh`, { method: 'POST' });
    return res.ok;
  } catch (e) {
    console.error('Failed to refresh ddns status:', e);
    return false;
  }
}
