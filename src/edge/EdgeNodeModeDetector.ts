import { getLoggerFor } from 'global-logger-factory';

export interface NodeRegistrationInfo {
  nodeId: string;
  publicIp?: string;
  publicPort?: number;
  capabilities: NodeCapabilities;
}

export interface NodeCapabilities {
  solidProtocolVersion?: string;
  storageBackends?: string[];
  authMethods?: string[];
  maxBandwidth?: number;
  supportedModes?: ('direct' | 'proxy')[];
  location?: {
    country?: string;
    region?: string;
    coordinates?: { lat: number; lon: number };
  };
}

export interface ModeDetectionResult {
  accessMode: 'direct' | 'proxy';
  reason: string;
  subdomain: string;
  connectivityTest?: {
    success: boolean;
    latency?: number;
    error?: string;
  };
}

export interface EdgeNodeModeDetectorOptions {
  baseDomain: string;
  connectivityTimeoutMs?: number;
  maxDirectModeAttempts?: number;
}

export class EdgeNodeModeDetector {
  private readonly logger = getLoggerFor(this);
  private readonly baseDomain: string;
  private readonly connectivityTimeoutMs: number;
  private readonly maxDirectModeAttempts: number;

  public constructor(options: EdgeNodeModeDetectorOptions) {
    this.baseDomain = options.baseDomain;
    this.connectivityTimeoutMs = options.connectivityTimeoutMs ?? 3000;
    this.maxDirectModeAttempts = Math.max(1, options.maxDirectModeAttempts ?? 1);
  }

  public async detectMode(nodeInfo: NodeRegistrationInfo): Promise<ModeDetectionResult> {
    const subdomain = this.generateSubdomain(nodeInfo.nodeId);
    const supportedModes = this.extractSupportedModes(nodeInfo.capabilities);
    const supportsDirect = supportedModes.has('direct');
    const supportsProxy = supportedModes.has('proxy');

    // Prefer direct if supported and publicIp is present
    const hasPublicIp = Boolean(nodeInfo.publicIp);
    let connectivityTest: { success: boolean; latencyMs?: number; error?: string } | undefined;

    if (supportsDirect && hasPublicIp) {
      connectivityTest = await this.testDirectConnectivity(
        nodeInfo.publicIp!,
        nodeInfo.publicPort ?? 443
      );

      if (connectivityTest.success) {
        this.logger.info(`Node ${nodeInfo.nodeId} is directly reachable at ${nodeInfo.publicIp}:${nodeInfo.publicPort ?? 443}`);
        return {
          accessMode: 'direct',
          reason: 'Direct connectivity test passed',
          subdomain,
          connectivityTest,
        };
      }

      this.logger.info(`Node ${nodeInfo.nodeId} is not directly reachable, will fall back to proxy if available: ${connectivityTest.error}`);
      if (!supportsProxy) {
        return {
          accessMode: 'direct',
          reason: `Direct connectivity failed and proxy not supported: ${connectivityTest.error}`,
          subdomain,
          connectivityTest,
        };
      }
    }

    // Direct not available or failed; if proxy supported, use proxy mode
    if (supportsProxy) {
      return {
        accessMode: 'proxy',
        reason: supportsDirect && hasPublicIp ? 'Direct connectivity failed, using proxy' : 'Direct not available, using proxy',
        subdomain,
        connectivityTest,
      };
    }

    // Neither direct nor proxy viable
    return {
      accessMode: supportsDirect ? 'direct' : 'proxy',
      reason: supportsDirect ? 'Direct mode only; no proxy configured' : 'Proxy only; no direct available',
      subdomain,
    };
  }

  private generateSubdomain(nodeId: string): string {
    // Generate a unique subdomain based on node ID
    // For now, use a simple approach - in production you might want more sophisticated logic
    const sanitized = nodeId.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    return `${sanitized}.${this.baseDomain}`;
  }

  private async testDirectConnectivity(ip: string, port: number): Promise<{
    success: boolean;
    latency?: number;
    error?: string;
  }> {
    let lastResult = await this.singleConnectivityAttempt(ip, port);
    if (lastResult.success || this.maxDirectModeAttempts === 1) {
      return lastResult;
    }

    for (let attempt = 2; attempt <= this.maxDirectModeAttempts; attempt++) {
      lastResult = await this.singleConnectivityAttempt(ip, port);
      if (lastResult.success) {
        return lastResult;
      }
    }
    return lastResult;
  }

  private async singleConnectivityAttempt(ip: string, port: number): Promise<{
    success: boolean;
    latency?: number;
    error?: string;
  }> {
    const net = await import('node:net');

    return new Promise((resolve) => {
      const startTime = Date.now();
      const socket = new net.Socket();

      const cleanup = (): void => {
        socket.destroy();
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve({
          success: false,
          error: `Connection timeout after ${this.connectivityTimeoutMs}ms`,
        });
      }, this.connectivityTimeoutMs);

      socket.on('connect', () => {
        clearTimeout(timeout);
        const latency = Date.now() - startTime;
        cleanup();
        resolve({
          success: true,
          latency,
        });
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        cleanup();
        resolve({
          success: false,
          error: error.message,
        });
      });

      try {
        socket.connect(port, ip);
      } catch (error) {
        clearTimeout(timeout);
        cleanup();
        resolve({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown connection error',
        });
      }
    });
  }

  public async recheckMode(currentMode: string, nodeInfo: NodeRegistrationInfo): Promise<ModeDetectionResult | null> {
    // Only recheck if currently in proxy mode and public IP is available
    const supportedModes = this.extractSupportedModes(nodeInfo.capabilities);
    if (currentMode !== 'proxy' || !nodeInfo.publicIp || !supportedModes.has('direct')) {
      return null;
    }

    const connectivityTest = await this.testDirectConnectivity(
      nodeInfo.publicIp,
      nodeInfo.publicPort ?? 443
    );

    if (connectivityTest.success) {
      const subdomain = this.generateSubdomain(nodeInfo.nodeId);
      this.logger.info(`Node ${nodeInfo.nodeId} connectivity restored, switching to direct mode`);
      return {
        accessMode: 'direct',
        reason: 'Direct connectivity restored',
        subdomain,
        connectivityTest,
      };
    }

    return null;
  }

  private extractSupportedModes(capabilities: NodeCapabilities): Set<string> {
    const modes = new Set<string>();
    const rawModes = capabilities.supportedModes ?? ['direct', 'proxy'];
    
    for (const mode of rawModes) {
      modes.add(mode);
    }
    
    if (modes.size === 0) {
      modes.add('direct');
      modes.add('proxy');
    }
    return modes;
  }
}
