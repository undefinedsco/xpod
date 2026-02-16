/**
 * DDNS Manager for Local Managed Mode
 *
 * Responsibilities (Local managed mode):
 * - Allocate a managed domain on Cloud (subdomain -> fqdn)
 * - Keep the record updated when network changes
 *
 * Note: if the machine has no public IP, we assume tunnel mode and let Cloud
 * point the managed domain to the configured tunnel provider.
 */

import { getLoggerFor } from 'global-logger-factory';
import type { SubdomainClient } from '../subdomain/SubdomainClient';
import type { EdgeNodeCapabilityDetector } from './EdgeNodeCapabilityDetector';

export interface DdnsManagerOptions {
  client: SubdomainClient;
  detector: EdgeNodeCapabilityDetector;
  subdomain: string;
  intervalMs?: number;
  autoAllocate?: boolean;

  // Local tunnel provider preference (best-effort hint for Cloud).
  tunnelProvider?: 'cloudflare' | 'sakura_frp' | 'none';
}

export class DdnsManager {
  private readonly logger = getLoggerFor(this);
  private readonly client: SubdomainClient;
  private readonly detector: EdgeNodeCapabilityDetector;
  private readonly subdomain: string;
  private readonly intervalMs: number;
  private readonly autoAllocate: boolean;
  private readonly tunnelProvider: 'cloudflare' | 'sakura_frp' | 'none';

  private interval?: NodeJS.Timeout;
  private allocated = false;
  private fqdn?: string;
  private lastIpv4?: string;
  private lastIpv6?: string;
  private lastMode: 'direct' | 'tunnel' | 'unknown' = 'unknown';

  public constructor(options: DdnsManagerOptions) {
    this.client = options.client;
    this.detector = options.detector;
    this.subdomain = options.subdomain;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.autoAllocate = options.autoAllocate ?? true;
    this.tunnelProvider = options.tunnelProvider ?? 'none';
  }

  public async start(): Promise<void> {
    if (this.interval) {
      return;
    }

    this.logger.info(`Starting DDNS manager for subdomain: ${this.subdomain}`);

    await this.runCycle();
    this.interval = setInterval(() => void this.runCycle(), this.intervalMs);
  }

  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.logger.info('DDNS manager stopped');
  }

  public getFqdn(): string | undefined {
    return this.allocated ? this.fqdn : undefined;
  }

  public isAllocated(): boolean {
    return this.allocated;
  }

  public getStatus(): {
    allocated: boolean;
    fqdn?: string;
    ipv4?: string;
    ipv6?: string;
    mode: 'direct' | 'tunnel' | 'unknown';
    tunnelProvider: string;
  } {
    return {
      allocated: this.allocated,
      fqdn: this.fqdn,
      ipv4: this.lastIpv4,
      ipv6: this.lastIpv6,
      mode: this.lastMode,
      tunnelProvider: this.tunnelProvider,
    };
  }

  public async runOnce(): Promise<void> {
    await this.runCycle();
  }

  private async runCycle(): Promise<void> {
    try {
      const netInfo = await this.detector.detectNetworkAddresses();

      const ipv4Public = netInfo.ipv4Public;
      const ipv6Public = netInfo.ipv6Public;
      const hasPublicIp = Boolean(ipv4Public || ipv6Public);

      this.lastMode = hasPublicIp ? 'direct' : 'tunnel';

      const ipv4 = ipv4Public ?? netInfo.ipv4;
      const ipv6 = ipv6Public ?? netInfo.ipv6;

      if (!this.allocated && this.autoAllocate) {
        await this.allocateSubdomain(ipv4, ipv6);
      }

      if (this.allocated) {
        const ipChanged = ipv4 !== this.lastIpv4 || ipv6 !== this.lastIpv6;
        if (ipChanged || this.lastMode === 'tunnel') {
          await this.updateDdns(ipv4, ipv6);
        }
      }
    } catch (error: unknown) {
      this.logger.error(`DDNS cycle failed: ${(error as Error).message}`);
    }
  }

  private async allocateSubdomain(ipv4?: string, ipv6?: string): Promise<void> {
    const existing = await this.client.getDdns(this.subdomain);
    if (existing) {
      this.logger.info(`DDNS subdomain already allocated: ${existing.fqdn}`);
      this.allocated = true;
      this.fqdn = existing.fqdn;
      this.lastIpv4 = existing.ipAddress;
      this.lastIpv6 = existing.ipv6Address;
      return;
    }

    this.logger.info(`Allocating DDNS subdomain: ${this.subdomain}`);

    const result = await this.client.allocateDdns({
      subdomain: this.subdomain,
      ipAddress: this.lastMode === 'direct' ? ipv4 : undefined,
      ipv6Address: this.lastMode === 'direct' ? ipv6 : undefined,
      mode: this.lastMode === 'tunnel' ? 'tunnel' : 'direct',
      tunnelProvider: this.tunnelProvider,
    });

    if (result.success) {
      this.logger.info(`DDNS allocated: ${result.fqdn}`);
      this.allocated = true;
      this.fqdn = result.fqdn;
      this.lastIpv4 = this.lastMode === 'direct' ? ipv4 : undefined;
      this.lastIpv6 = this.lastMode === 'direct' ? ipv6 : undefined;
    }
  }

  private async updateDdns(ipv4?: string, ipv6?: string): Promise<void> {
    if (this.lastMode === 'direct' && !ipv4 && !ipv6) {
      this.logger.debug('No IP address to update in direct mode');
      return;
    }


    this.logger.info(
      `Updating DDNS: ${this.subdomain} mode=${this.lastMode} ipv4=${ipv4 ?? 'none'} ipv6=${ipv6 ?? 'none'} tunnel=${this.tunnelProvider}`,
    );

    const result = await this.client.updateDdns(this.subdomain, {
      ipAddress: this.lastMode === 'direct' ? ipv4 : undefined,
      ipv6Address: this.lastMode === 'direct' ? ipv6 : undefined,
      mode: this.lastMode === 'tunnel' ? 'tunnel' : 'direct',
      tunnelProvider: this.tunnelProvider,
    });

    if (result.success) {
      this.fqdn = result.fqdn;
      this.lastIpv4 = this.lastMode === 'direct' ? ipv4 : undefined;
      this.lastIpv6 = this.lastMode === 'direct' ? ipv6 : undefined;
      this.logger.info(`DDNS updated: ${result.fqdn}`);
    }
  }
}
