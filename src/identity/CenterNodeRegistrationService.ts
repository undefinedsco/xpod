import { getLoggerFor } from 'global-logger-factory';
import { Initializer } from '@solid/community-server';
import { EdgeNodeRepository } from './drizzle/EdgeNodeRepository';
import { getIdentityDatabase } from './drizzle/db';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Configuration for the Center node registration service.
 */
export interface CenterNodeRegistrationConfig {
  /** Database connection URL */
  identityDbUrl: string;
  /** Server port (from CSS --port parameter) */
  port?: number | string;
  /** Root file path (from CSS --rootFilePath parameter, for node ID persistence) */
  rootFilePath?: string;
  /** Unique identifier for this node. Auto-generated if not provided. */
  nodeId?: string;
  /** Display name for this node */
  displayName?: string;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatInterval?: number;
  /** Whether the service is enabled (default: true) */
  enabled?: boolean | string;
}

/**
 * Service that registers this Center node with the cluster on startup.
 * 
 * This allows multiple Center nodes to discover each other and route
 * requests to the correct node based on Pod location.
 * 
 * The service:
 * 1. Auto-detects internal IP and port
 * 2. Generates or loads a persistent node ID
 * 3. Registers with the shared database on startup
 * 4. Sends periodic heartbeats to indicate liveness
 */
export class CenterNodeRegistrationService extends Initializer {
  protected readonly logger = getLoggerFor(this);

  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly nodeId: string;
  private readonly displayName?: string;
  private readonly internalIp: string;
  private readonly internalPort: number;
  private readonly heartbeatInterval: number;
  private readonly nodeIdPath: string | undefined;
  private readonly enabled: boolean;

  private heartbeatTimer?: NodeJS.Timeout;
  private token?: string;

  public constructor(config: CenterNodeRegistrationConfig) {
    super();

    // Check if enabled
    this.enabled = this.normalizeBoolean(config.enabled, true);
    
    // Auto-detect internal IP and port
    this.internalIp = this.detectInternalIp();
    this.internalPort = this.normalizePort(config.port);
    this.displayName = config.displayName;
    this.heartbeatInterval = config.heartbeatInterval ?? 30_000;
    
    // Auto-generate nodeIdPath from rootFilePath
    this.nodeIdPath = config.rootFilePath ? path.join(config.rootFilePath, '.node-id') : undefined;

    // Create repository from database URL
    const db = getIdentityDatabase(config.identityDbUrl);
    this.edgeNodeRepository = new EdgeNodeRepository(db);

    // Load or generate node ID
    this.nodeId = this.loadOrGenerateNodeId(config.nodeId);
  }

  /**
   * Get the current node's ID.
   */
  public getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Get the current node's internal endpoint.
   */
  public getInternalEndpoint(): { ip: string; port: number } {
    return { ip: this.internalIp, port: this.internalPort };
  }

  /**
   * Initialize the service: register with the cluster and start heartbeat.
   */
  public async handle(): Promise<void> {
    if (!this.enabled) {
      this.logger.info('Center node registration disabled');
      return;
    }

    if (!this.internalIp) {
      this.logger.warn('Center node registration skipped: could not detect internal IP');
      return;
    }

    if (!this.internalPort) {
      this.logger.warn('Center node registration skipped: port not configured');
      return;
    }

    this.logger.info(`Registering center node: ${this.nodeId}`);
    this.logger.info(`Internal endpoint: ${this.internalIp}:${this.internalPort}`);

    try {
      // Register this node with the cluster
      const result = await this.edgeNodeRepository.registerCenterNode({
        nodeId: this.nodeId,
        displayName: this.displayName,
        internalIp: this.internalIp,
        internalPort: this.internalPort,
      });

      this.token = result.token;
      this.logger.info(`Center node registered successfully: ${this.nodeId}`);

      // Start periodic heartbeat
      this.startHeartbeat();
    } catch (error: unknown) {
      this.logger.error(`Failed to register center node: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Auto-detect internal IP address.
   * Priority:
   * 1. K8s POD_IP environment variable
   * 2. First non-localhost IPv4 address from network interfaces
   */
  private detectInternalIp(): string {
    // K8s environment
    const podIp = process.env.POD_IP;
    if (podIp) {
      this.logger.debug(`Using POD_IP: ${podIp}`);
      return podIp;
    }

    // Detect from network interfaces
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const netInterface = interfaces[name];
      if (!netInterface) continue;

      for (const addr of netInterface) {
        // Skip internal (localhost) and non-IPv4
        if (addr.internal || addr.family !== 'IPv4') {
          continue;
        }
        this.logger.debug(`Detected internal IP from ${name}: ${addr.address}`);
        return addr.address;
      }
    }

    this.logger.warn('Could not detect internal IP address');
    return '';
  }

  /**
   * Normalize port from string/number.
   */
  private normalizePort(port?: number | string): number {
    if (typeof port === 'number') {
      return port;
    }
    if (typeof port === 'string') {
      const parsed = parseInt(port, 10);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Load node ID from persistent storage, or generate a new one.
   */
  private loadOrGenerateNodeId(configNodeId?: string): string {
    // Use config value if provided
    if (configNodeId) {
      return configNodeId;
    }

    // Try to load from file
    if (this.nodeIdPath) {
      try {
        if (fs.existsSync(this.nodeIdPath)) {
          const content = fs.readFileSync(this.nodeIdPath, 'utf-8').trim();
          if (content) {
            this.logger.debug(`Loaded node ID from ${this.nodeIdPath}: ${content}`);
            return content;
          }
        }
      } catch (error: unknown) {
        this.logger.warn(`Failed to load node ID from ${this.nodeIdPath}: ${(error as Error).message}`);
      }
    }

    // Generate new node ID
    const newNodeId = `center-${randomUUID()}`;

    // Persist to file if path is configured
    if (this.nodeIdPath) {
      try {
        const dir = path.dirname(this.nodeIdPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.nodeIdPath, newNodeId, 'utf-8');
        this.logger.info(`Generated and saved new node ID: ${newNodeId}`);
      } catch (error: unknown) {
        this.logger.warn(`Failed to persist node ID to ${this.nodeIdPath}: ${(error as Error).message}`);
      }
    }

    return newNodeId;
  }

  /**
   * Start periodic heartbeat to indicate liveness.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.edgeNodeRepository.updateCenterNodeHeartbeat(
          this.nodeId,
          this.internalIp,
          this.internalPort,
          new Date(),
        );
        this.logger.debug(`Heartbeat sent for node: ${this.nodeId}`);
      } catch (error: unknown) {
        this.logger.warn(`Failed to send heartbeat: ${(error as Error).message}`);
      }
    }, this.heartbeatInterval);

    // Don't block process exit
    this.heartbeatTimer.unref();
  }

  /**
   * Stop the heartbeat timer (for graceful shutdown).
   */
  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      this.logger.info(`Heartbeat stopped for node: ${this.nodeId}`);
    }
  }

  /**
   * List all center nodes in the cluster (for discovery).
   */
  public async listClusterNodes(): Promise<Array<{
    nodeId: string;
    internalIp: string;
    internalPort: number;
    isLocal: boolean;
    reachable: boolean;
  }>> {
    const nodes = await this.edgeNodeRepository.listCenterNodes();
    return nodes.map(node => ({
      nodeId: node.nodeId,
      internalIp: node.internalIp,
      internalPort: node.internalPort,
      isLocal: node.nodeId === this.nodeId,
      reachable: node.connectivityStatus === 'reachable',
    }));
  }

  /**
   * Get the internal URL for a specific node.
   */
  public async getNodeInternalUrl(nodeId: string): Promise<string | undefined> {
    const node = await this.edgeNodeRepository.getCenterNode(nodeId);
    if (!node || !node.internalIp || !node.internalPort) {
      return undefined;
    }
    return `http://${node.internalIp}:${node.internalPort}`;
  }

  /**
   * Normalize boolean values from string/boolean.
   */
  private normalizeBoolean(value: string | boolean | undefined, defaultValue: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return defaultValue;
  }
}
