import os from 'node:os';
import { spawn } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import type { EdgeNodeHeartbeatServiceOptions } from '../service/EdgeNodeHeartbeatService';
import { EdgeNodeHeartbeatService } from '../service/EdgeNodeHeartbeatService';
import { FrpcProcessManager, type FrpcRuntimeStatus } from './frp/FrpcProcessManager';
import { AcmeCertificateManager } from './acme/AcmeCertificateManager';
import { ClusterCertificateManager } from './acme/ClusterCertificateManager';
import { EdgeNodeCapabilityDetector, type NetworkAddressInfo } from './EdgeNodeCapabilityDetector';

export interface EdgeNodeAgentOptions {
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
  baseUrl?: string;
  publicAddress?: string;
  pods?: string[];
  includeSystemMetrics?: boolean;
  enableNetworkDetection?: boolean;
  metadata?: Record<string, unknown>;
  intervalMs?: number;
  onHeartbeatResponse?: (data: unknown) => void;
  acme?: {
    mode?: 'local' | 'cluster';
    email?: string;
    domains?: string[];
    directoryUrl?: string;
    accountKeyPath?: string;
    certificateKeyPath: string;
    certificatePath: string;
    fullChainPath?: string;
    renewBeforeDays?: number;
    propagationDelayMs?: number;
    postDeployCommand?: string[];
  };
  frp?: {
    binaryPath: string;
    configPath: string;
    workingDirectory?: string;
    logPrefix?: string;
    autoRestart?: boolean;
  };
}

export class EdgeNodeAgent {
  private readonly logger = getLoggerFor(this);
  private heartbeat?: EdgeNodeHeartbeatService;
  private frpManager?: FrpcProcessManager;
  private clusterCertificate?: ClusterCertificateManager;
  private networkDetector?: EdgeNodeCapabilityDetector;
  private cachedNetworkInfo?: NetworkAddressInfo;
  private lastNetworkDetection = 0;
  private readonly networkDetectionIntervalMs = 60_000; // 每分钟重新检测一次

  public async start(options: EdgeNodeAgentOptions): Promise<void> {
    if (options.acme) {
      const mode = options.acme.mode ?? 'local';
      if (mode === 'cluster') {
        await this.ensureClusterCertificate(options);
      } else {
        await this.issueCertificateLocally(options);
      }
    }
    if (options.frp) {
      this.frpManager = new FrpcProcessManager({
        binaryPath: options.frp.binaryPath,
        configPath: options.frp.configPath,
        workingDirectory: options.frp.workingDirectory,
        logPrefix: options.frp.logPrefix,
        autoRestart: options.frp.autoRestart,
      });
    }
    
    // 初始化网络检测器
    if (options.enableNetworkDetection !== false) {
      this.networkDetector = new EdgeNodeCapabilityDetector({
        dynamicDetection: {
          enableNetworkDetection: true,
        },
      });
      // 执行初始网络检测
      this.cachedNetworkInfo = await this.networkDetector.detectNetworkAddresses();
      this.lastNetworkDetection = Date.now();
      this.logger.info(`Network detection: IPv4=${this.cachedNetworkInfo.ipv4Public ?? this.cachedNetworkInfo.ipv4}, IPv6=${this.cachedNetworkInfo.ipv6Public ?? this.cachedNetworkInfo.ipv6}, hasPublicIPv6=${this.cachedNetworkInfo.hasPublicIPv6}`);
    }
    
    const systemMetrics = options.includeSystemMetrics ? this.collectSystemMetrics() : undefined;
    const metadataPayload = {
      ...(options.metadata ?? {}),
      system: systemMetrics,
    } as Record<string, unknown>;

    const certificatePayload = this.clusterCertificate?.getHeartbeatPayload();
    const heartbeatOptions: EdgeNodeHeartbeatServiceOptions = {
      edgeNodesEnabled: true,
      signalEndpoint: options.signalEndpoint,
      nodeId: options.nodeId,
      nodeToken: options.nodeToken,
      baseUrl: options.baseUrl,
      publicAddress: options.publicAddress,
      pods: options.pods,
      intervalMs: options.intervalMs,
      metadata: this.stringifyIfContent(metadataPayload),
      metrics: systemMetrics ? JSON.stringify(systemMetrics) : undefined,
      certificate: certificatePayload ? JSON.stringify(certificatePayload) : undefined,
      onHeartbeatResponse: (data: unknown): void => {
        this.handleHeartbeatResponse(data);
        options.onHeartbeatResponse?.(data);
      },
      networkSupplier: this.networkDetector ? () => this.getNetworkInfo() : undefined,
    };
    if (this.frpManager) {
      heartbeatOptions.tunnelSupplier = () => this.buildTunnelHeartbeatPayload();
    }

    this.heartbeat = new EdgeNodeHeartbeatService(heartbeatOptions);
  }

  public stop(): void {
    if (this.heartbeat && typeof (this.heartbeat as any).dispose === 'function') {
      (this.heartbeat as any).dispose();
    }
    this.heartbeat = undefined;
    void this.frpManager?.stop();
    this.clusterCertificate?.stop();
  }

  private stringifyIfContent(data: Record<string, unknown>): string | undefined {
    const sanitized: Record<string, unknown> = {};
    for (const [ key, value ] of Object.entries(data)) {
      if (value !== undefined) {
        sanitized[key] = value;
      }
    }
    return Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : undefined;
  }

  private collectSystemMetrics(): Record<string, unknown> {
    const load = os.loadavg();
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      cpuCount: os.cpus().length,
      load1: load[0],
      load5: load[1],
      load15: load[2],
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
    };
  }

  private handleHeartbeatResponse(data: unknown): void {
    if (!data || typeof data !== 'object') {
      return;
    }
    const body = data as Record<string, any>;
    const metadata = body.metadata as Record<string, any> | undefined;
    this.clusterCertificate?.handleHeartbeatMetadata(metadata);
    const tunnel = metadata?.tunnel as Record<string, any> | undefined;
    const config = tunnel?.config as Record<string, any> | undefined;
    if (config) {
      this.logger.debug(`接收到隧道配置: ${JSON.stringify({ entrypoint: tunnel?.entrypoint, proxyName: config.proxyName })}`);
    }
    const entrypoint = typeof tunnel?.entrypoint === 'string' ? tunnel.entrypoint :
      typeof config?.publicUrl === 'string' ? config.publicUrl : undefined;
    void this.frpManager?.applyConfig(config as any, tunnel?.status as string | undefined, entrypoint);
  }

  private async issueCertificateLocally(options: EdgeNodeAgentOptions): Promise<void> {
    const acmeOptions = options.acme!;
    if (!acmeOptions.email || !acmeOptions.domains || acmeOptions.domains.length === 0) {
      throw new Error('本地 ACME 模式需要提供 email 与 domains。');
    }
    if (!acmeOptions.accountKeyPath) {
      throw new Error('本地 ACME 模式需要提供 accountKeyPath。');
    }
    const manager = new AcmeCertificateManager({
      signalEndpoint: options.signalEndpoint,
      nodeId: options.nodeId,
      nodeToken: options.nodeToken,
      email: acmeOptions.email!,
      domains: acmeOptions.domains!,
      directoryUrl: acmeOptions.directoryUrl,
      accountKeyPath: acmeOptions.accountKeyPath!,
      certificateKeyPath: acmeOptions.certificateKeyPath,
      certificatePath: acmeOptions.certificatePath,
      fullChainPath: acmeOptions.fullChainPath,
      renewBeforeDays: acmeOptions.renewBeforeDays,
      propagationDelayMs: acmeOptions.propagationDelayMs,
    });
    try {
      const issued = await manager.ensureCertificate();
      if (issued && acmeOptions.postDeployCommand && acmeOptions.postDeployCommand.length > 0) {
        await this.runPostDeploy(acmeOptions.postDeployCommand);
      }
    } catch (error: unknown) {
      this.logger.error(`自动签发证书失败：${(error as Error).message}`);
      throw error;
    }
  }

  private async ensureClusterCertificate(options: EdgeNodeAgentOptions): Promise<void> {
    const acmeOptions = options.acme!;
    if (!acmeOptions.certificateKeyPath || !acmeOptions.certificatePath) {
      throw new Error('Cluster 模式需要提供 certificateKeyPath 与 certificatePath。');
    }
    const manager = new ClusterCertificateManager({
      signalEndpoint: options.signalEndpoint,
      nodeId: options.nodeId,
      nodeToken: options.nodeToken,
      certificateKeyPath: acmeOptions.certificateKeyPath,
      certificatePath: acmeOptions.certificatePath,
      fullChainPath: acmeOptions.fullChainPath,
      renewBeforeDays: acmeOptions.renewBeforeDays,
      onCertificateInstalled: acmeOptions.postDeployCommand ? () => this.runPostDeploy(acmeOptions.postDeployCommand!) : undefined,
    });
    this.clusterCertificate = manager;
    await manager.start();
  }

  private async runPostDeploy(command: string[]): Promise<void> {
    const [ executable, ...args ] = command;
    if (!executable) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`命令 ${executable} 退出码 ${code}`));
        }
      });
    });
  }

  private buildTunnelHeartbeatPayload(): Record<string, unknown> | undefined {
    const status: FrpcRuntimeStatus | undefined = this.frpManager?.getStatus();
    if (!status) {
      return undefined;
    }
    return { client: status };
  }

  /**
   * 获取网络信息（带缓存，每分钟刷新一次）
   */
  private async getNetworkInfo(): Promise<{ ipv4?: string; ipv6?: string }> {
    const now = Date.now();
    
    // 如果缓存过期，重新检测
    if (!this.cachedNetworkInfo || (now - this.lastNetworkDetection) > this.networkDetectionIntervalMs) {
      if (this.networkDetector) {
        try {
          this.cachedNetworkInfo = await this.networkDetector.detectNetworkAddresses();
          this.lastNetworkDetection = now;
        } catch (error: unknown) {
          this.logger.debug(`Network detection failed: ${(error as Error).message}`);
        }
      }
    }
    
    // 优先返回公网地址
    return {
      ipv4: this.cachedNetworkInfo?.ipv4Public ?? this.cachedNetworkInfo?.ipv4,
      ipv6: this.cachedNetworkInfo?.ipv6Public ?? this.cachedNetworkInfo?.ipv6,
    };
  }
}
