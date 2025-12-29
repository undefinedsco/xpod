import { getLoggerFor } from 'global-logger-factory';
import { NodeCapabilities } from './EdgeNodeModeDetector';

/**
 * 边缘节点能力检测器
 * 负责检测和报告节点的各种能力信息
 */
export interface EdgeNodeCapabilityDetectorOptions {
  /**
   * 基础能力配置，可以通过配置文件或环境变量设置
   */
  baseCapabilities?: Partial<NodeCapabilities>;
  
  /**
   * 动态检测选项
   */
  dynamicDetection?: {
    enableBandwidthTest?: boolean;
    enableLocationDetection?: boolean;
    bandwidthTestUrl?: string;
    locationServiceUrl?: string;
  };
}

export class EdgeNodeCapabilityDetector {
  private readonly logger = getLoggerFor(this);
  private readonly baseCapabilities: Partial<NodeCapabilities>;
  private readonly dynamicDetection: NonNullable<EdgeNodeCapabilityDetectorOptions['dynamicDetection']>;

  public constructor(options: EdgeNodeCapabilityDetectorOptions = {}) {
    this.baseCapabilities = options.baseCapabilities ?? {};
    this.dynamicDetection = {
      enableBandwidthTest: false,
      enableLocationDetection: false,
      ...options.dynamicDetection,
    };
  }

  /**
   * 检测并返回完整的节点能力信息
   */
  public async detectCapabilities(): Promise<NodeCapabilities> {
    const capabilities: NodeCapabilities = {
      ...this.baseCapabilities,
    };

    try {
      // 检测固体协议版本
      if (!capabilities.solidProtocolVersion) {
        capabilities.solidProtocolVersion = this.detectSolidProtocolVersion();
      }

      // 检测存储后端
      if (!capabilities.storageBackends) {
        capabilities.storageBackends = this.detectStorageBackends();
      }

      // 检测认证方法
      if (!capabilities.authMethods) {
        capabilities.authMethods = this.detectAuthMethods();
      }

      // 动态检测带宽
      if (this.dynamicDetection.enableBandwidthTest && !capabilities.maxBandwidth) {
        capabilities.maxBandwidth = await this.detectBandwidth();
      }

      // 动态检测位置
      if (this.dynamicDetection.enableLocationDetection && !capabilities.location) {
        capabilities.location = await this.detectLocation();
      }

      this.logger.debug(`Node capabilities detected successfully: ${JSON.stringify(capabilities)}`);
      return capabilities;
    } catch (error: unknown) {
      this.logger.error(`Failed to detect node capabilities: ${(error as Error).message}`);
      // 返回基础能力，即使检测失败
      return capabilities;
    }
  }

  /**
   * 检测Solid协议版本
   */
  private detectSolidProtocolVersion(): string {
    // 这里可以根据实际使用的Community Solid Server版本来确定
    // 或者从package.json中获取CSS版本
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cssPackage = require('@solid/community-server/package.json');
      return `solid-0.11-css-${cssPackage.version}`;
    } catch {
      return 'solid-0.11';
    }
  }

  /**
   * 检测存储后端类型
   */
  private detectStorageBackends(): string[] {
    const backends: string[] = [];

    // 检测文件系统后端
    try {
      const fs = require('fs');
      if (fs.existsSync) {
        backends.push('filesystem');
      }
    } catch {
      // 忽略检测失败
    }

    // 检测S3/MinIO后端（通过环境变量）
    if (process.env.XPOD_STORAGE_S3_ENDPOINT || process.env.MINIO_ENDPOINT) {
      backends.push('s3-compatible');
    }

    // 检测数据库后端
    if (process.env.CSS_DATABASE_URL || process.env.POSTGRES_URL) {
      backends.push('database');
    }

    return backends.length > 0 ? backends : ['filesystem'];
  }

  /**
   * 检测支持的认证方法
   */
  private detectAuthMethods(): string[] {
    const methods: string[] = [];

    // 基础认证方法
    methods.push('webid', 'client-credentials');

    // 检测是否支持OIDC
    if (process.env.CSS_IDP_ENABLED !== 'false') {
      methods.push('oidc');
    }

    // 检测是否支持UMA
    if (process.env.CSS_UMA_ENABLED === 'true') {
      methods.push('uma');
    }

    return methods;
  }

  /**
   * 动态检测网络带宽（简化版本）
   */
  private async detectBandwidth(): Promise<number | undefined> {
    if (!this.dynamicDetection.bandwidthTestUrl) {
      return undefined;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

      const startTime = Date.now();
      const response = await fetch(this.dynamicDetection.bandwidthTestUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return undefined;
      }

      const data = await response.arrayBuffer();
      const duration = (Date.now() - startTime) / 1000; // 转为秒
      const sizeInBits = data.byteLength * 8;
      const bandwidthBps = sizeInBits / duration;

      // 返回Mbps，保留2位小数
      return Math.round((bandwidthBps / 1_000_000) * 100) / 100;
    } catch {
      return undefined;
    }
  }

  /**
   * 动态检测地理位置信息
   */
  private async detectLocation(): Promise<NodeCapabilities['location'] | undefined> {
    if (!this.dynamicDetection.locationServiceUrl) {
      return undefined;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

      const response = await fetch(this.dynamicDetection.locationServiceUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return undefined;
      }

      const data = await response.json() as { country?: string; region?: string; regionName?: string; lat?: number; lon?: number };
      
      // 假设返回的数据格式类似 ipinfo.io 或 geoip 服务
      return {
        country: data.country,
        region: data.region ?? data.regionName,
        coordinates: data.lat && data.lon ? {
          lat: Number(data.lat),
          lon: Number(data.lon),
        } : undefined,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 将NodeCapabilities转换为字符串数组（用于向后兼容）
   */
  public static capabilitiesToStringArray(capabilities: NodeCapabilities): string[] {
    const result: string[] = [];

    if (capabilities.solidProtocolVersion) {
      result.push(`solid:${capabilities.solidProtocolVersion}`);
    }

    if (capabilities.storageBackends && capabilities.storageBackends.length > 0) {
      result.push(...capabilities.storageBackends.map(backend => `storage:${backend}`));
    }

    if (capabilities.authMethods && capabilities.authMethods.length > 0) {
      result.push(...capabilities.authMethods.map(method => `auth:${method}`));
    }

    if (capabilities.maxBandwidth !== undefined) {
      result.push(`bandwidth:${capabilities.maxBandwidth}mbps`);
    }

    if (capabilities.location) {
      if (capabilities.location.country) {
        result.push(`location:${capabilities.location.country}`);
      }
      if (capabilities.location.region) {
        result.push(`region:${capabilities.location.region}`);
      }
    }

    return result;
  }

  /**
   * 从字符串数组解析NodeCapabilities（用于向后兼容）
   */
  public static parseCapabilitiesFromStringArray(capabilityStrings: string[]): Partial<NodeCapabilities> {
    const capabilities: Partial<NodeCapabilities> = {
      storageBackends: [],
      authMethods: [],
    };

    for (const capability of capabilityStrings) {
      const [type, value] = capability.split(':', 2);
      
      switch (type) {
        case 'solid':
          capabilities.solidProtocolVersion = value;
          break;
        case 'storage':
          if (value && capabilities.storageBackends) {
            capabilities.storageBackends.push(value);
          }
          break;
        case 'auth':
          if (value && capabilities.authMethods) {
            capabilities.authMethods.push(value);
          }
          break;
        case 'bandwidth':
          if (value.endsWith('mbps')) {
            const bandwidth = Number(value.slice(0, -4));
            if (!isNaN(bandwidth)) {
              capabilities.maxBandwidth = bandwidth;
            }
          }
          break;
        case 'location':
          if (value) {
            capabilities.location = capabilities.location ?? {};
            capabilities.location.country = value;
          }
          break;
        case 'region':
          if (value) {
            capabilities.location = capabilities.location ?? {};
            capabilities.location.region = value;
          }
          break;
      }
    }

    // 清理空数组
    if (capabilities.storageBackends?.length === 0) {
      delete capabilities.storageBackends;
    }
    if (capabilities.authMethods?.length === 0) {
      delete capabilities.authMethods;
    }

    return capabilities;
  }
}