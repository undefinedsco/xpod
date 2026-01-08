import { Initializer } from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';
import { EdgeNodeAgent, type EdgeNodeAgentOptions } from './EdgeNodeAgent';

/**
 * 所有配置项设为可选，以便在 disabled 状态下即使缺少 CLI 变量也能成功实例化。
 */
export interface EdgeNodeAgentInitializerOptions extends Partial<EdgeNodeAgentOptions> {
  enabled?: boolean | string;
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
      // 此时已确认 options 符合 EdgeNodeAgentOptions (去除 Partial)
      await this.agent.start(this.options as EdgeNodeAgentOptions);
      this.logger.info(`EdgeNodeAgent started (Node: ${this.options.nodeId})`);
    } catch (error: unknown) {
      this.logger.error(`Failed to start EdgeNodeAgent: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 确保启用时必需参数存在
   */
  private validateOptions(options: EdgeNodeAgentInitializerOptions): asserts options is EdgeNodeAgentOptions {
    const missing: string[] = [];
    
    if (!options.signalEndpoint) missing.push('signalEndpoint');
    if (!options.nodeId) missing.push('nodeId');
    if (!options.nodeToken) missing.push('nodeToken');

    if (missing.length > 0) {
      throw new Error(`EdgeNodeAgent enabled but missing required configuration: ${missing.join(', ')}`);
    }
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
}
