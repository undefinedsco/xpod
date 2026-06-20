import { Initializer } from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';
import { EdgeNodeAgent, type EdgeNodeAgentOptions } from './EdgeNodeAgent';

/**
 * 所有配置项设为可选，以便在 disabled 状态下即使缺少 CLI 变量也能成功实例化。
 */
export interface EdgeNodeAgentInitializerOptions {
  enabled?: boolean | string;
  signalEndpoint?: string;
  nodeId?: string;
  nodeToken?: string;
  baseUrl?: string;
  directCandidates?: string | string[];
  pods?: string[];
  includeSystemMetrics?: boolean;
  enableNetworkDetection?: boolean;
  metadata?: Record<string, unknown>;
  intervalMs?: number | string;
  p2pEnabled?: boolean | string;
  p2pTargetBaseUrl?: string;
  p2pLabel?: string;
}

/**
 * Initializer that starts the EdgeNodeAgent.
 * Designed to be safe to configure even when disabled or missing dependent variables.
 */
export class EdgeNodeAgentInitializer extends Initializer {
  protected readonly logger = getLoggerFor(this);
  private readonly agent: EdgeNodeAgent;
  private readonly options: EdgeNodeAgentInitializerOptions;
  private readonly enabled: boolean;

  public constructor(options: EdgeNodeAgentInitializerOptions) {
    super();
    this.options = options;
    this.agent = new EdgeNodeAgent();
    this.enabled = this.normalizeBoolean(options.enabled);
  }

  public override async handle(): Promise<void> {
    if (!this.enabled) {
      this.logger.debug('EdgeNodeAgent is disabled, skipping startup.');
      return;
    }

    this.logger.info('Enabling EdgeNodeAgent...');
    
    // 运行时严格校验参数
    this.validateOptions(this.options);

    try {
      await this.agent.start(this.buildAgentOptions(this.options));
      this.logger.info(`EdgeNodeAgent started (Node: ${this.options.nodeId})`);
    } catch (error: unknown) {
      this.logger.error(`Failed to start EdgeNodeAgent: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 确保启用时必需参数存在
   */
  private validateOptions(options: EdgeNodeAgentInitializerOptions): void {
    const missing: string[] = [];
    
    if (!options.signalEndpoint) missing.push('signalEndpoint');
    if (!options.nodeId) missing.push('nodeId');
    if (!options.nodeToken) missing.push('nodeToken');
    if (this.normalizeBoolean(options.p2pEnabled) && !options.p2pTargetBaseUrl) {
      missing.push('p2pTargetBaseUrl');
    }

    if (missing.length > 0) {
      throw new Error(`EdgeNodeAgent enabled but missing required configuration: ${missing.join(', ')}`);
    }
  }

  private buildAgentOptions(options: EdgeNodeAgentInitializerOptions): EdgeNodeAgentOptions {
    const p2pEnabled = this.normalizeBoolean(options.p2pEnabled);
    return {
      signalEndpoint: options.signalEndpoint!,
      nodeId: options.nodeId!,
      nodeToken: options.nodeToken!,
      baseUrl: options.baseUrl,
      directCandidates: options.directCandidates,
      pods: options.pods,
      includeSystemMetrics: options.includeSystemMetrics,
      enableNetworkDetection: options.enableNetworkDetection,
      metadata: options.metadata,
      intervalMs: this.normalizePositiveInteger(options.intervalMs),
      ...(p2pEnabled ? {
        p2p: {
          enabled: true,
          targetBaseUrl: options.p2pTargetBaseUrl!,
          label: options.p2pLabel,
        },
      } : {}),
    };
  }

  private normalizeBoolean(value: string | boolean | undefined): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return false;
  }

  private normalizePositiveInteger(value: number | string | undefined): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return undefined;
  }
}
