import { getLoggerFor } from 'global-logger-factory';
import type { EdgeNodeCapabilityDetector } from './EdgeNodeCapabilityDetector';
import type { EdgeNodeDnsCoordinator } from './EdgeNodeDnsCoordinator';
import type { TunnelProvider } from '../tunnel/TunnelProvider';

export interface LocalNetworkManagerOptions {
  detector: EdgeNodeCapabilityDetector;
  dnsCoordinator: EdgeNodeDnsCoordinator;
  tunnelProvider?: TunnelProvider;
  localPort?: number;
  intervalMs?: number;
}

/**
 * 本地网络管理器
 * 
 * 专门用于 Local 模式，定期探测本机 IP 并自动同步到 DNS。
 * 它是“自闭环”的，不依赖外部心跳。
 * 
 * 逻辑：
 * 1. 优先探测公网 IP (IPv6 > IPv4)。
 * 2. 如果有公网 IP -> 停止 Tunnel -> 更新 AAAA/A 记录。
 * 3. 如果无公网 IP -> 启动 Tunnel (Fallback) -> Tunnel 接管 CNAME。
 */
export class LocalNetworkManager {
  private readonly logger = getLoggerFor(this);
  private readonly detector: EdgeNodeCapabilityDetector;
  private readonly dnsCoordinator: EdgeNodeDnsCoordinator;
  private readonly tunnelProvider?: TunnelProvider;
  private readonly localPort: number;
  private readonly intervalMs: number;
  private interval?: NodeJS.Timeout;
  
  // 状态追踪，用于减少重复日志
  private lastState = {
    hasPublicIp: false,
    tunnelRunning: false,
  };

  public constructor(options: LocalNetworkManagerOptions) {
    this.detector = options.detector;
    this.dnsCoordinator = options.dnsCoordinator;
    this.tunnelProvider = options.tunnelProvider;
    this.localPort = options.localPort ?? 3000;
    this.intervalMs = options.intervalMs ?? 60_000; // 默认 1 分钟
  }

  /**
   * 启动管理循环
   */
  public start(): void {
    if (this.interval) {
      return;
    }
    this.logger.info(`Starting background loop (interval: ${this.intervalMs}ms)`);
    
    // 立即执行一次，然后开始循环
    void this.runMaintenance();
    this.interval = setInterval(() => this.runMaintenance(), this.intervalMs);
  }

  /**
   * 停止
   */
  public async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    
    // 确保退出时关闭 Tunnel，防止僵尸进程
    if (this.tunnelProvider?.getStatus().running) {
      this.logger.info('Stopping tunnel before exit...');
      await this.tunnelProvider.stop();
    }
  }

  private async runMaintenance(): Promise<void> {
    try {
      this.logger.debug('Starting network detection phase...');
      
      // 1. 探测本机 IP
      const netInfo = await this.detector.detectNetworkAddresses();
      
      // 2. 构造元数据 (只使用公网 IP)
      const metadata: Record<string, unknown> = {
        ipv4: netInfo.ipv4Public,
        ipv6: netInfo.ipv6Public,
        accessMode: 'direct',
        subdomain: '@', 
      };

      const hasPublicIp = !!(metadata.ipv4 || metadata.ipv6);
      const tunnelRunning = !!this.tunnelProvider?.getStatus().running;
      
      // 检查状态是否发生变化
      const stateChanged = hasPublicIp !== this.lastState.hasPublicIp || 
                           tunnelRunning !== this.lastState.tunnelRunning;

      if (stateChanged) {
        this.logger.info(`Network status changed: IP=${hasPublicIp ? 'Public' : 'Private'}, Tunnel=${tunnelRunning ? 'Running' : 'Stopped'} (IPv4=${metadata.ipv4 || 'none'}, IPv6=${metadata.ipv6 || 'none'})`);
      } else {
        // 平时仅打印一条极简的调试信息（如果级别设为 info 则每分钟一条）
        this.logger.debug(`Status check: IP=${hasPublicIp ? 'Public' : 'Private'}, Tunnel=${tunnelRunning ? 'Running' : 'Stopped'}`);
      }

      if (hasPublicIp) {
        // === 直连模式 ===
        if (tunnelRunning) {
          this.logger.info('Stopping tunnel fallback to use direct public IP...');
          await this.tunnelProvider!.stop();
          this.lastState.tunnelRunning = false;
        }

        // 仅在 IP 变化或初次运行且有 IP 时同步 DNS
        await this.dnsCoordinator.synchronize('local-self', metadata);

      } else {
        // === 隧道模式 (Fallback) ===
        if (this.tunnelProvider) {
          if (!tunnelRunning) {
            this.logger.info('No public IP. Starting Cloudflare Tunnel fallback...');
            const config = await this.tunnelProvider.setup({
              subdomain: 'local',
              localPort: this.localPort,
            });
            
            await this.tunnelProvider.start(config);
            this.logger.info('Tunnel fallback active.');
            this.lastState.tunnelRunning = true;
          }
        }
      }
      
      // 更新状态追踪
      this.lastState.hasPublicIp = hasPublicIp;
      this.lastState.tunnelRunning = !!this.tunnelProvider?.getStatus().running;
      
    } catch (error: unknown) {
      this.logger.error(`Maintenance task failed: ${(error as Error).message}`);
    }
  }
}
