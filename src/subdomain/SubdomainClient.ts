/**
 * SubdomainClient - Local 模式子域名客户端
 * 
 * Local 模式不持有 DNS/Tunnel 密钥，通过调用 Cloud API 来管理子域名。
 * 使用 Node Token 认证（与 Edge Node 心跳相同的认证方式）。
 */

import { getLoggerFor } from 'global-logger-factory';

export interface SubdomainClientOptions {
  /** Cloud API 端点 (如 https://center.example.com/v1/subdomain) */
  cloudApiEndpoint: string;
  
  /** 节点 ID */
  nodeId: string;
  
  /** 节点 Token */
  nodeToken: string;
  
  /** 请求超时 (ms) */
  timeoutMs?: number;
}

export interface SubdomainCheckResult {
  subdomain: string;
  available: boolean;
  reason?: string;
}

export interface SubdomainRegistrationResult {
  success: boolean;
  subdomain: string;
  fullDomain: string;
  mode: 'direct' | 'tunnel';
  publicIp?: string;
  tunnelProvider?: string;
  tunnelEndpoint?: string;
  registeredAt: string;
  message?: string;
}

export interface SubdomainInfo {
  subdomain: string;
  fullDomain: string;
  mode: 'direct' | 'tunnel';
  publicIp?: string;
  tunnelProvider?: string;
  tunnelEndpoint?: string;
  registeredAt: string;
  ownerId?: string;
}

/**
 * 子域名客户端 (Local 模式)
 * 
 * 通过 HTTP 调用 Cloud 的子域名 API
 */
export class SubdomainClient {
  private readonly logger = getLoggerFor(this);
  private readonly cloudApiEndpoint: string;
  private readonly nodeId: string;
  private readonly nodeToken: string;
  private readonly timeoutMs: number;

  constructor(options: SubdomainClientOptions) {
    this.cloudApiEndpoint = options.cloudApiEndpoint.replace(/\/$/, '');
    this.nodeId = options.nodeId;
    this.nodeToken = options.nodeToken;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  /**
   * 检查子域名可用性
   */
  async checkAvailability(name: string): Promise<SubdomainCheckResult> {
    const url = `${this.cloudApiEndpoint}/check?name=${encodeURIComponent(name)}`;
    const response = await this.fetch(url, { method: 'GET' });
    return response as SubdomainCheckResult;
  }

  /**
   * 注册子域名
   */
  async register(options: {
    subdomain: string;
    localPort: number;
    publicIp?: string;
  }): Promise<SubdomainRegistrationResult> {
    const url = `${this.cloudApiEndpoint}/register`;
    const response = await this.fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        subdomain: options.subdomain,
        localPort: options.localPort,
        publicIp: options.publicIp,
        nodeId: this.nodeId,
      }),
    });
    return response as SubdomainRegistrationResult;
  }

  /**
   * 获取子域名信息
   */
  async getInfo(name: string): Promise<SubdomainInfo | null> {
    const url = `${this.cloudApiEndpoint}/${encodeURIComponent(name)}`;
    try {
      const response = await this.fetch(url, { method: 'GET' });
      return response as SubdomainInfo;
    } catch (error) {
      if (error instanceof SubdomainClientError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 列出所有子域名
   */
  async list(): Promise<{ registrations: SubdomainInfo[]; total: number }> {
    const url = this.cloudApiEndpoint;
    const response = await this.fetch(url, { method: 'GET' });
    return response as { registrations: SubdomainInfo[]; total: number };
  }

  /**
   * 释放子域名
   */
  async release(name: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.cloudApiEndpoint}/${encodeURIComponent(name)}`;
    const response = await this.fetch(url, { method: 'DELETE' });
    return response as { success: boolean; message: string };
  }

  /**
   * 启动隧道
   */
  async startTunnel(name: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.cloudApiEndpoint}/${encodeURIComponent(name)}/start`;
    const response = await this.fetch(url, { method: 'POST' });
    return response as { success: boolean; message: string };
  }

  /**
   * 停止隧道
   */
  async stopTunnel(name: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.cloudApiEndpoint}/${encodeURIComponent(name)}/stop`;
    const response = await this.fetch(url, { method: 'POST' });
    return response as { success: boolean; message: string };
  }

  // ============ Private Methods ============

  private async fetch(url: string, options: {
    method: string;
    body?: string;
  }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.nodeToken}`,
          'X-Node-Id': this.nodeId,
        },
        body: options.body,
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok) {
        const error = (data as any)?.error ?? 'Unknown error';
        throw new SubdomainClientError(error, response.status);
      }

      return data;
    } catch (error) {
      if (error instanceof SubdomainClientError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SubdomainClientError('Request timeout', 408);
      }
      throw new SubdomainClientError(
        error instanceof Error ? error.message : 'Unknown error',
        500,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * SubdomainClient 错误
 */
export class SubdomainClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'SubdomainClientError';
  }
}
