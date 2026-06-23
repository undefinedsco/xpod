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
  acceptSignaledRawTcpP2PConnectionOnce,
  createP2PDataPlaneHandler,
  createP2PSignalingClient,
  type AccessRoute,
  type P2PSignalingClient,
  type RawTcpP2PConnectSocket,
  type RawTcpP2PSleep,
  type TcpP2PDataPlaneSocketHandle,
} from './reachability';

type EdgeNodeP2PHeartbeatRoute = Omit<AccessRoute, 'canonicalUrl'> & { canonicalUrl?: string };

export interface EdgeNodeP2PAcceptEvent {
  sessionId: string;
  nodeId: string;
  clientId: string;
  localCandidateCount: number;
  remoteCandidateCount: number;
  nodeAddress: CandidateAddressEvidence;
  clientAddress: CandidateAddressEvidence;
  acceptedAt: string;
}

type CandidateAddressEvidence =
  | 'explicit-host'
  | 'explicit-address'
  | 'signal-observed'
  | 'candidate-url'
  | 'port-only';

const DEFAULT_P2P_ACCEPT_INTERVAL_MS = 1_000;

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
    label?: string;
    host?: string;
    address?: string;
    signaling?: P2PSignalingClient;
    acceptIntervalMs?: number | string;
    connectTimeoutMs?: number | string;
    winnerSelectionWindowMs?: number | string;
    localAddress?: string;
    sleepMs?: RawTcpP2PSleep;
    connectSocket?: RawTcpP2PConnectSocket;
    onP2PAccept?: (event: EdgeNodeP2PAcceptEvent) => void;
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
  private p2pAcceptInterval?: NodeJS.Timeout;
  private p2pAcceptRunning = false;
  private p2pAcceptGeneration = 0;
  private readonly p2pAcceptedSessionIds = new Set<string>();
  private readonly p2pSocketHandles = new Set<TcpP2PDataPlaneSocketHandle>();
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
      ...this.buildHeartbeatMetadata(options),
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
    this.startP2PAcceptLoop(options);
  }

  public stop(): void {
    if (this.heartbeat && typeof (this.heartbeat as any).dispose === 'function') {
      (this.heartbeat as any).dispose();
    }
    this.heartbeat = undefined;
    if (this.p2pAcceptInterval) {
      clearInterval(this.p2pAcceptInterval);
      this.p2pAcceptInterval = undefined;
    }
    this.p2pAcceptGeneration += 1;
    for (const handle of this.p2pSocketHandles) {
      handle.close();
    }
    this.p2pSocketHandles.clear();
    this.p2pAcceptedSessionIds.clear();
    this.p2pAcceptRunning = false;
    void this.frpManager?.stop();
    this.clusterCertificate?.stop();
  }

  private startP2PAcceptLoop(options: EdgeNodeAgentOptions): void {
    const p2p = options.p2p;
    if (!p2p || this.normalizeBoolean(p2p.enabled) === false) {
      return;
    }
    const signaling = p2p.signaling ?? createP2PSignalingClient({
      apiBaseUrl: this.resolveP2PApiBaseUrl(options.signalEndpoint),
      nodeId: options.nodeId,
      token: options.nodeToken,
    });
    const handler = createP2PDataPlaneHandler({ targetBaseUrl: p2p.targetBaseUrl });
    const intervalMs = this.normalizePositiveInteger(p2p.acceptIntervalMs) ?? DEFAULT_P2P_ACCEPT_INTERVAL_MS;
    this.p2pAcceptGeneration += 1;
    const generation = this.p2pAcceptGeneration;
    const run = (): void => {
      void this.acceptP2PConnectionOnce({
        generation,
        signaling,
        sourceId: options.nodeId,
        host: p2p.host,
        address: p2p.address,
        handler,
        connectTimeoutMs: this.normalizePositiveInteger(p2p.connectTimeoutMs),
        winnerSelectionWindowMs: this.normalizeNonNegativeInteger(p2p.winnerSelectionWindowMs),
        localAddress: p2p.localAddress,
        sleepMs: p2p.sleepMs,
        connectSocket: p2p.connectSocket,
        onP2PAccept: p2p.onP2PAccept,
      });
    };
    run();
    this.p2pAcceptInterval = setInterval(run, intervalMs);
  }

  private async acceptP2PConnectionOnce(options: Parameters<typeof acceptSignaledRawTcpP2PConnectionOnce>[0] & {
    generation: number;
    onP2PAccept?: (event: EdgeNodeP2PAcceptEvent) => void;
  }): Promise<void> {
    if (this.p2pAcceptRunning) {
      return;
    }
    this.p2pAcceptRunning = true;
    try {
      const { generation, onP2PAccept, ...acceptOptions } = options;
      const accepted = await acceptSignaledRawTcpP2PConnectionOnce({
        ...acceptOptions,
        signaling: this.skipAcceptedP2PSessions(acceptOptions.signaling),
        host: acceptOptions.host,
      });
      if (accepted) {
        if (generation !== this.p2pAcceptGeneration) {
          accepted.socketHandle.close();
          return;
        }
        this.p2pAcceptedSessionIds.add(accepted.session.sessionId);
        this.p2pSocketHandles.add(accepted.socketHandle);
        onP2PAccept?.({
          sessionId: accepted.session.sessionId,
          nodeId: accepted.session.nodeId,
          clientId: accepted.session.clientId,
          localCandidateCount: accepted.localCandidates.length,
          remoteCandidateCount: accepted.remoteCandidates.length,
          nodeAddress: addressEvidenceFromCandidates(accepted.localCandidates),
          clientAddress: addressEvidenceFromCandidates(accepted.remoteCandidates),
          acceptedAt: new Date().toISOString(),
        });
        this.logger.info(`Accepted raw TCP P2P session ${accepted.session.sessionId}.`);
      }
    } catch (error: unknown) {
      this.logger.debug(`Raw TCP P2P accept attempt failed: ${(error as Error).message}`);
    } finally {
      this.p2pAcceptRunning = false;
    }
  }

  private skipAcceptedP2PSessions(signaling: P2PSignalingClient): P2PSignalingClient {
    return {
      createP2PSession: (request) => signaling.createP2PSession(request),
      getP2PSession: (sessionIdOrUrl) => signaling.getP2PSession(sessionIdOrUrl),
      addP2PCandidates: (sessionIdOrUrl, request) => signaling.addP2PCandidates(sessionIdOrUrl, request),
      listP2PSessions: async () => {
        const sessions = await signaling.listP2PSessions();
        return sessions.filter((session) => !this.p2pAcceptedSessionIds.has(session.sessionId));
      },
    };
  }

  private resolveP2PApiBaseUrl(signalEndpoint: string): string {
    try {
      return new URL(signalEndpoint).origin;
    } catch {
      return signalEndpoint;
    }
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

  private buildHeartbeatMetadata(options: EdgeNodeAgentOptions): Record<string, unknown> {
    const metadata = { ...(options.metadata ?? {}) } as Record<string, unknown>;
    const p2pRoute = this.buildP2PHeartbeatRoute(options);
    if (p2pRoute) {
      metadata.routes = this.mergeHeartbeatRoutes(metadata.routes, p2pRoute);
    }
    return metadata;
  }

  private buildP2PHeartbeatRoute(options: EdgeNodeAgentOptions): EdgeNodeP2PHeartbeatRoute | undefined {
    const p2p = options.p2p;
    if (!p2p || this.normalizeBoolean(p2p.enabled) === false) {
      return undefined;
    }
    const label = typeof p2p.label === 'string' && p2p.label.length > 0 ? p2p.label : undefined;
    return {
      id: 'p2p-raw-tcp',
      nodeId: options.nodeId,
      ...(options.baseUrl ? { canonicalUrl: options.baseUrl } : {}),
      kind: 'p2p',
      targetUrl: `tcp-punch://node/${encodeURIComponent(options.nodeId)}`,
      priority: 40,
      requiresManagedClient: true,
      visibility: 'authorized-client',
      health: 'healthy',
      metadata: {
        protocols: {
          'raw-tcp-hole-punch': {
            enabled: true,
            ...(label ? { label } : {}),
          },
        },
      },
    };
  }

  private mergeHeartbeatRoutes(existing: unknown, p2pRoute: EdgeNodeP2PHeartbeatRoute): EdgeNodeP2PHeartbeatRoute[] {
    const routes = Array.isArray(existing)
      ? existing.filter((entry): entry is EdgeNodeP2PHeartbeatRoute => Boolean(entry) && typeof entry === 'object')
      : [];
    const withoutGeneratedRoute = routes.filter((route) => route.id !== p2pRoute.id);
    return [...withoutGeneratedRoute, p2pRoute];
  }

  private normalizePositiveInteger(value: number | string | undefined): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
    return undefined;
  }

  private normalizeNonNegativeInteger(value: number | string | undefined): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.floor(parsed);
      }
    }
    return undefined;
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

function addressEvidenceFromCandidates(candidates: Array<{ host?: string; address?: string; url?: string }>): CandidateAddressEvidence {
  const evidence = candidates.map(candidateAddressEvidence);
  return evidence.find((entry) => entry === 'explicit-host')
    ?? evidence.find((entry) => entry === 'explicit-address')
    ?? evidence.find((entry) => entry === 'signal-observed')
    ?? evidence.find((entry) => entry === 'candidate-url')
    ?? 'port-only';
}

function candidateAddressEvidence(candidate: { host?: string; address?: string; url?: string }): CandidateAddressEvidence {
  if (candidate.host) {
    return 'explicit-host';
  }
  if (candidate.address && candidate.url) {
    return 'explicit-address';
  }
  if (candidate.address) {
    return 'signal-observed';
  }
  if (candidate.url) {
    return 'candidate-url';
  }
  return 'port-only';
}
