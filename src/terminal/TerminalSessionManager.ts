import { randomUUID } from 'crypto';
import { getLoggerFor } from '@solid/community-server';
import { TerminalSession } from './TerminalSession';
import { AclPermissionService } from './AclPermissionService';
import type { SessionConfig, Session, EnvRef, CreateSessionRequest } from './types';
import { isTrustedAgent, TRUSTED_AGENTS } from './types';

export interface TerminalSessionManagerOptions {
  /** Maximum sessions per user */
  maxSessionsPerUser: number;
  /** Maximum total sessions */
  maxTotalSessions: number;
  /** Default session timeout in seconds */
  defaultTimeout: number;
  /** Maximum session timeout in seconds */
  maxTimeout: number;
  /** Default working directory */
  defaultWorkdir: string;
  /** SPARQL endpoint for ACL queries */
  sparqlEndpoint?: string;
  /** Whether to require ACL Control permission (default: true) */
  requireAclControl: boolean;
  /** Base URL for mapping file paths to resource URLs */
  baseUrl?: string;
  /** File system root for mapping URLs to paths */
  fileSystemRoot?: string;
}

const DEFAULT_OPTIONS: TerminalSessionManagerOptions = {
  maxSessionsPerUser: 5,
  maxTotalSessions: 100,
  defaultTimeout: 3600, // 1 hour
  maxTimeout: 86400, // 24 hours
  defaultWorkdir: '/workspace',
  requireAclControl: true,
};

export class TerminalSessionManager {
  protected readonly logger = getLoggerFor(this);

  private readonly sessions = new Map<string, TerminalSession>();
  private readonly userSessions = new Map<string, Set<string>>();
  private readonly options: TerminalSessionManagerOptions;
  private readonly aclService?: AclPermissionService;

  constructor(options: Partial<TerminalSessionManagerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Initialize ACL service if SPARQL endpoint is provided
    if (this.options.sparqlEndpoint) {
      this.aclService = new AclPermissionService(this.options.sparqlEndpoint);
    }
  }

  /**
   * Convert a file system path to a resource URL.
   */
  private pathToUrl(path: string): string | undefined {
    if (!this.options.baseUrl || !this.options.fileSystemRoot) {
      return undefined;
    }

    const root = this.options.fileSystemRoot.endsWith('/')
      ? this.options.fileSystemRoot.slice(0, -1)
      : this.options.fileSystemRoot;

    if (!path.startsWith(root)) {
      return undefined;
    }

    const relativePath = path.slice(root.length);
    const baseUrl = this.options.baseUrl.endsWith('/')
      ? this.options.baseUrl.slice(0, -1)
      : this.options.baseUrl;

    return baseUrl + relativePath;
  }

  /**
   * Check if user has acl:Control permission for the working directory.
   */
  async checkWorkdirPermission(userId: string, workdir: string): Promise<boolean> {
    if (!this.options.requireAclControl) {
      return true;
    }

    if (!this.aclService) {
      this.logger.warn('ACL service not configured, skipping permission check');
      return true;
    }

    const resourceUrl = this.pathToUrl(workdir);
    if (!resourceUrl) {
      this.logger.warn(`Cannot map workdir to URL: ${workdir}`);
      return false;
    }

    return this.aclService.hasControlPermission(userId, resourceUrl);
  }

  /**
   * Create a new terminal session
   */
  async createSession(
    userId: string,
    request: CreateSessionRequest,
    secretResolver?: (ref: EnvRef) => Promise<string>,
  ): Promise<TerminalSession> {
    // Validate command is trusted
    if (!isTrustedAgent(request.command)) {
      throw new Error(
        `Untrusted command: ${request.command}. Allowed: ${TRUSTED_AGENTS.join(', ')}`
      );
    }

    const workdir = request.workdir ?? this.options.defaultWorkdir;

    // Check ACL Control permission
    const hasPermission = await this.checkWorkdirPermission(userId, workdir);
    if (!hasPermission) {
      throw new Error(
        `Permission denied: acl:Control required for workdir ${workdir}`
      );
    }

    // Check limits
    if (this.sessions.size >= this.options.maxTotalSessions) {
      throw new Error('Maximum total sessions reached');
    }

    const userSessionIds = this.userSessions.get(userId) ?? new Set();
    if (userSessionIds.size >= this.options.maxSessionsPerUser) {
      throw new Error(`Maximum sessions per user reached (${this.options.maxSessionsPerUser})`);
    }

    // Resolve environment variables
    const env: Record<string, string> = {};
    if (request.env) {
      for (const [key, value] of Object.entries(request.env)) {
        if (typeof value === 'string') {
          env[key] = value;
        } else if (secretResolver) {
          try {
            env[key] = await secretResolver(value);
          } catch (error) {
            this.logger.warn(`Failed to resolve secret for ${key}: ${error}`);
          }
        }
      }
    }

    // Build session config
    const sessionId = `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const timeout = Math.min(
      request.timeout ?? this.options.defaultTimeout,
      this.options.maxTimeout
    );

    const config: SessionConfig = {
      command: request.command,
      args: request.args ?? [],
      workdir,
      env: request.env ?? {},
      timeout,
    };

    // Create session
    const session = new TerminalSession(sessionId, userId, config, env);

    // Track session
    this.sessions.set(sessionId, session);
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(sessionId);

    // Clean up on exit
    session.on('exit', () => {
      this.removeSession(sessionId);
    });

    this.logger.info(`Created terminal session ${sessionId} for user ${userId} in ${workdir}`);
    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions for a user
   */
  getUserSessions(userId: string): TerminalSession[] {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) {
      return [];
    }
    return Array.from(sessionIds)
      .map(id => this.sessions.get(id))
      .filter((s): s is TerminalSession => s !== undefined);
  }

  /**
   * Terminate a session
   */
  terminateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.terminate();
    return true;
  }

  /**
   * Remove a session from tracking
   */
  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      const userSessionIds = this.userSessions.get(session.userId);
      if (userSessionIds) {
        userSessionIds.delete(sessionId);
        if (userSessionIds.size === 0) {
          this.userSessions.delete(session.userId);
        }
      }
      this.logger.info(`Removed terminal session ${sessionId}`);
    }
  }

  /**
   * Get session statistics
   */
  getStats(): { totalSessions: number; activeUsers: number } {
    return {
      totalSessions: this.sessions.size,
      activeUsers: this.userSessions.size,
    };
  }

  /**
   * Terminate all sessions (for shutdown)
   */
  terminateAll(): void {
    for (const session of this.sessions.values()) {
      session.terminate();
    }
    this.sessions.clear();
    this.userSessions.clear();
  }
}
