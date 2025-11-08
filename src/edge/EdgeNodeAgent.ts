import os from 'node:os';
import { spawn } from 'node:child_process';
import { getLoggerFor } from '@solid/community-server';
import type { EdgeNodeHeartbeatServiceOptions } from '../service/EdgeNodeHeartbeatService';
import { EdgeNodeHeartbeatService } from '../service/EdgeNodeHeartbeatService';
import { AcmeCertificateManager } from './acme/AcmeCertificateManager';
import { FrpcProcessManager } from './frp/FrpcProcessManager';

export interface EdgeNodeAgentOptions {
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
  baseUrl?: string;
  publicAddress?: string;
  pods?: string[];
  includeSystemMetrics?: boolean;
  metadata?: Record<string, unknown>;
  intervalMs?: number;
  onHeartbeatResponse?: (data: unknown) => void;
  acme?: {
    email: string;
    domains: string[];
    directoryUrl?: string;
    accountKeyPath: string;
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

  public async start(options: EdgeNodeAgentOptions): Promise<void> {
    if (options.acme) {
      await this.issueCertificateIfNeeded(options);
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
    const systemMetrics = options.includeSystemMetrics ? this.collectSystemMetrics() : undefined;
    const metadataPayload = {
      ...(options.metadata ?? {}),
      system: systemMetrics,
    } as Record<string, unknown>;

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
      onHeartbeatResponse: (data: unknown): void => {
        this.handleHeartbeatResponse(data);
        options.onHeartbeatResponse?.(data);
      },
    };

    this.heartbeat = new EdgeNodeHeartbeatService(heartbeatOptions);
  }

  public stop(): void {
    if (this.heartbeat && typeof (this.heartbeat as any).dispose === 'function') {
      (this.heartbeat as any).dispose();
    }
    this.heartbeat = undefined;
    void this.frpManager?.stop();
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
    const tunnel = metadata?.tunnel as Record<string, any> | undefined;
    const config = tunnel?.config as Record<string, any> | undefined;
    if (config) {
      this.logger.debug(`接收到隧道配置: ${JSON.stringify({ entrypoint: tunnel?.entrypoint, proxyName: config.proxyName })}`);
    }
    void this.frpManager?.applyConfig(config as any, tunnel?.status);
  }

  private async issueCertificateIfNeeded(options: EdgeNodeAgentOptions): Promise<void> {
    const acmeOptions = options.acme!;
    const manager = new AcmeCertificateManager({
      signalEndpoint: options.signalEndpoint,
      nodeId: options.nodeId,
      nodeToken: options.nodeToken,
      email: acmeOptions.email,
      domains: acmeOptions.domains,
      directoryUrl: acmeOptions.directoryUrl,
      accountKeyPath: acmeOptions.accountKeyPath,
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
}
