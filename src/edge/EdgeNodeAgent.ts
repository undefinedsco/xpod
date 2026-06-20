import os from 'node:os';
import { spawn } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import type { EdgeNodeSignalClientOptions } from '../service/EdgeNodeSignalClient';
import { EdgeNodeSignalClient } from '../service/EdgeNodeSignalClient';
import { FrpcProcessManager, type FrpcRuntimeStatus } from './frp/FrpcProcessManager';
import { AcmeCertificateManager } from './acme/AcmeCertificateManager';
import { ClusterCertificateManager } from './acme/ClusterCertificateManager';
import { EdgeNodeCapabilityDetector, type NetworkAddressInfo } from './EdgeNodeCapabilityDetector';
import {
  answerPendingWeriftP2PSessionsOnce,
  createP2PSignalingClient,
  type AnswerPendingWeriftP2PSessionsOnceOptions,
  type P2PSignalingClient,
  type WeriftSignaledP2PDataPlaneNode,
} from './reachability';

type EdgeNodeP2PAnswerHandle = Pick<WeriftSignaledP2PDataPlaneNode, 'close'>;

export interface EdgeNodeAgentOptions {
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
  baseUrl?: string;
  directCandidates?: string | string[];
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
  p2p?: {
    enabled?: boolean | string;
    targetBaseUrl: string | URL;
    apiBaseUrl?: string;
    signaling?: P2PSignalingClient;
    fetchImpl?: typeof fetch;
    signalingFetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    signalingPollIntervalMs?: number;
    timeoutMs?: number;
    label?: string;
    peerConfig?: AnswerPendingWeriftP2PSessionsOnceOptions['peerConfig'];
    answerPendingSessionsOnce?: (
      options: AnswerPendingWeriftP2PSessionsOnceOptions<EdgeNodeP2PAnswerHandle>,
    ) => Promise<EdgeNodeP2PAnswerHandle[]>;
  };
}

export class EdgeNodeAgent {
  private readonly logger = getLoggerFor(this);
  private heartbeat?: EdgeNodeSignalClient;
  private frpManager?: FrpcProcessManager;
  private clusterCertificate?: ClusterCertificateManager;
  private networkDetector?: EdgeNodeCapabilityDetector;
  private cachedNetworkInfo?: NetworkAddressInfo;
  private lastNetworkDetection = 0;
  private readonly networkDetectionIntervalMs = 60_000; // 每分钟重新检测一次
  private p2pAnswerTimer?: NodeJS.Timeout;
  private p2pAnswerRunning = false;
  private p2pAnswerStopped = false;
  private readonly p2pAnswerHandles = new Set<EdgeNodeP2PAnswerHandle>();

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
    const heartbeatOptions: EdgeNodeSignalClientOptions = {
      edgeNodesEnabled: true,
      signalEndpoint: options.signalEndpoint,
      nodeId: options.nodeId,
      nodeToken: options.nodeToken,
      baseUrl: options.baseUrl,
      directCandidates: options.directCandidates,
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

    this.heartbeat = new EdgeNodeSignalClient(heartbeatOptions);
    this.startP2PAnswerLoop(options);
  }

  public stop(): void {
    if (this.heartbeat && typeof (this.heartbeat as any).dispose === 'function') {
      (this.heartbeat as any).dispose();
    }
    this.heartbeat = undefined;
    void this.frpManager?.stop();
    this.clusterCertificate?.stop();
    this.stopP2PAnswerLoop();
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

  private startP2PAnswerLoop(options: EdgeNodeAgentOptions): void {
    const p2p = options.p2p;
    if (!p2p || this.normalizeBoolean(p2p.enabled) === false) {
      return;
    }

    const signaling = p2p.signaling ?? createP2PSignalingClient({
      apiBaseUrl: p2p.apiBaseUrl ?? this.deriveP2PApiBaseUrl(options.signalEndpoint),
      nodeId: options.nodeId,
      token: options.nodeToken,
      fetchImpl: p2p.signalingFetchImpl,
    });
    const answerPendingSessionsOnce = p2p.answerPendingSessionsOnce ?? answerPendingWeriftP2PSessionsOnce;
    const answerOptions: AnswerPendingWeriftP2PSessionsOnceOptions<EdgeNodeP2PAnswerHandle> = {
      signaling,
      sourceId: options.nodeId,
      targetBaseUrl: p2p.targetBaseUrl,
      fetchImpl: p2p.fetchImpl,
      label: p2p.label,
      timeoutMs: p2p.timeoutMs,
      pollIntervalMs: p2p.signalingPollIntervalMs,
      peerConfig: p2p.peerConfig,
    };
    const pollIntervalMs = this.normalizeP2PAnswerPollInterval(p2p.pollIntervalMs);

    this.p2pAnswerStopped = false;
    const poll = async (): Promise<void> => {
      if (this.p2pAnswerStopped || this.p2pAnswerRunning) {
        return;
      }
      this.p2pAnswerRunning = true;
      try {
        const handles = await answerPendingSessionsOnce(answerOptions);
        if (this.p2pAnswerStopped) {
          this.closeP2PAnswerHandles(handles);
          return;
        }
        for (const handle of handles) {
          this.p2pAnswerHandles.add(handle);
        }
      } catch (error: unknown) {
        this.logger.warn(`P2P answer loop failed: ${(error as Error).message}`);
      } finally {
        this.p2pAnswerRunning = false;
      }
    };

    void poll();
    this.p2pAnswerTimer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
  }

  private stopP2PAnswerLoop(): void {
    this.p2pAnswerStopped = true;
    if (this.p2pAnswerTimer) {
      clearInterval(this.p2pAnswerTimer);
      this.p2pAnswerTimer = undefined;
    }
    const handles = Array.from(this.p2pAnswerHandles);
    this.p2pAnswerHandles.clear();
    this.closeP2PAnswerHandles(handles);
  }

  private closeP2PAnswerHandles(handles: EdgeNodeP2PAnswerHandle[]): void {
    for (const handle of handles) {
      void handle.close().catch((error: unknown) => {
        this.logger.warn(`Closing P2P answer handle failed: ${(error as Error).message}`);
      });
    }
  }

  private normalizeBoolean(value: boolean | string | undefined): boolean {
    if (value === undefined) {
      return true;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }

  private normalizeP2PAnswerPollInterval(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0 ? value : 1_000;
  }

  private deriveP2PApiBaseUrl(signalEndpoint: string): string {
    const url = new URL(signalEndpoint);
    url.pathname = url.pathname.replace(/\/api\/signal\/?$/u, '/');
    url.search = '';
    url.hash = '';
    return url.toString();
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
