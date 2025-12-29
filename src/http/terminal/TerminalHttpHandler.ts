import { IncomingMessage, ServerResponse } from 'http';
import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler } from '@solid/community-server';
import type {
  HttpHandlerInput,
  HttpRequest,
  HttpResponse,
  CredentialsExtractor,
} from '@solid/community-server';
import { WebSocketServer, WebSocket } from 'ws';
import { TerminalSessionManager } from '../../terminal/TerminalSessionManager';
import { TerminalSession } from '../../terminal/TerminalSession';
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  ClientMessage,
  ServerMessage,
} from '../../terminal/types';

export interface TerminalHttpHandlerOptions {
  /** Sidecar API path, default: '/-/terminal' */
  sidecarPath?: string;
  /** Credentials extractor for authentication */
  credentialsExtractor: CredentialsExtractor;
  /** Session manager options */
  maxSessionsPerUser?: number;
  maxTotalSessions?: number;
  defaultTimeout?: number;
  maxTimeout?: number;
  defaultWorkdir?: string;
}

export class TerminalHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  
  private readonly sidecarPath: string;
  private readonly sessionManager: TerminalSessionManager;
  private readonly credentialsExtractor: CredentialsExtractor;
  private wss?: WebSocketServer;
  private readonly wsConnections = new Map<string, Set<WebSocket>>();

  constructor(options: TerminalHttpHandlerOptions) {
    super();
    this.sidecarPath = options.sidecarPath ?? '/-/terminal';
    this.credentialsExtractor = options.credentialsExtractor;
    this.sessionManager = new TerminalSessionManager({
      maxSessionsPerUser: options.maxSessionsPerUser,
      maxTotalSessions: options.maxTotalSessions,
      defaultTimeout: options.defaultTimeout,
      maxTimeout: options.maxTimeout,
      defaultWorkdir: options.defaultWorkdir,
    });
  }

  override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    if (!url.pathname.includes(this.sidecarPath)) {
      throw new Error(`Not a terminal request: ${url.pathname}`);
    }
  }

  async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const pathAfterSidecar = url.pathname.split(this.sidecarPath)[1] ?? '';

    try {
      // Route to appropriate handler
      if (pathAfterSidecar === '/sessions' || pathAfterSidecar === '/sessions/') {
        if (request.method === 'POST') {
          await this.handleCreateSession(request, response);
        } else if (request.method === 'OPTIONS') {
          this.handleCors(response);
        } else {
          this.sendError(response, 405, 'Method Not Allowed');
        }
      } else if (pathAfterSidecar.match(/^\/sessions\/[^/]+$/)) {
        const sessionId = pathAfterSidecar.split('/')[2];
        if (request.method === 'GET') {
          await this.handleGetSession(sessionId, request, response);
        } else if (request.method === 'DELETE') {
          await this.handleDeleteSession(sessionId, request, response);
        } else if (request.method === 'OPTIONS') {
          this.handleCors(response);
        } else {
          this.sendError(response, 405, 'Method Not Allowed');
        }
      } else if (pathAfterSidecar.match(/^\/sessions\/[^/]+\/ws$/)) {
        // WebSocket upgrade is handled separately via handleUpgrade
        this.sendError(response, 400, 'WebSocket upgrade required');
      } else {
        this.sendError(response, 404, 'Not Found');
      }
    } catch (error) {
      this.logger.error(`Terminal handler error: ${error}`);
      this.sendError(response, 500, (error as Error).message);
    }
  }

  /**
   * Handle WebSocket upgrade requests
   * This should be called from the server's 'upgrade' event
   */
  handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
    }

    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const match = url.pathname.match(new RegExp(`${this.sidecarPath}/sessions/([^/]+)/ws`));
    
    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleWebSocketConnection(ws, session);
    });
  }

  private async handleCreateSession(
    request: HttpRequest,
    response: HttpResponse,
  ): Promise<void> {
    // Authenticate
    const credentials = await this.credentialsExtractor.handleSafe(request);
    if (!credentials.agent?.webId) {
      this.sendError(response, 401, 'Unauthorized');
      return;
    }
    const userId = credentials.agent.webId;

    // Parse request body
    const body = await this.readBody(request);
    let sessionRequest: CreateSessionRequest;
    try {
      sessionRequest = JSON.parse(body);
    } catch {
      this.sendError(response, 400, 'Invalid JSON body');
      return;
    }

    if (!sessionRequest.command) {
      this.sendError(response, 400, 'Missing required field: command');
      return;
    }

    try {
      const session = await this.sessionManager.createSession(userId, sessionRequest);
      
      // Preserve the base path before sidecarPath (e.g., /alice from /alice/-/terminal/sessions)
      const requestUrl = new URL(request.url ?? '', `http://${request.headers.host}`);
      const sidecarIndex = requestUrl.pathname.indexOf(this.sidecarPath);
      const basePath = sidecarIndex > 0 ? requestUrl.pathname.slice(0, sidecarIndex) : '';
      
      const wsUrl = new URL(request.url ?? '', `ws://${request.headers.host}`);
      wsUrl.pathname = `${basePath}${this.sidecarPath}/sessions/${session.sessionId}/ws`;

      const responseBody: CreateSessionResponse = {
        sessionId: session.sessionId,
        status: session.status,
        wsUrl: wsUrl.toString(),
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      };

      this.sendJson(response, 201, responseBody);
    } catch (error) {
      if ((error as Error).message.includes('Untrusted')) {
        this.sendError(response, 403, (error as Error).message);
      } else if ((error as Error).message.includes('Maximum')) {
        this.sendError(response, 429, (error as Error).message);
      } else {
        throw error;
      }
    }
  }

  private async handleGetSession(
    sessionId: string,
    request: HttpRequest,
    response: HttpResponse,
  ): Promise<void> {
    const credentials = await this.credentialsExtractor.handleSafe(request);
    if (!credentials.agent?.webId) {
      this.sendError(response, 401, 'Unauthorized');
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendError(response, 404, 'Session not found');
      return;
    }

    // Only session owner can access
    if (session.userId !== credentials.agent.webId) {
      this.sendError(response, 403, 'Forbidden');
      return;
    }

    this.sendJson(response, 200, session.toJSON());
  }

  private async handleDeleteSession(
    sessionId: string,
    request: HttpRequest,
    response: HttpResponse,
  ): Promise<void> {
    const credentials = await this.credentialsExtractor.handleSafe(request);
    if (!credentials.agent?.webId) {
      this.sendError(response, 401, 'Unauthorized');
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendError(response, 404, 'Session not found');
      return;
    }

    // Only session owner can terminate
    if (session.userId !== credentials.agent.webId) {
      this.sendError(response, 403, 'Forbidden');
      return;
    }

    this.sessionManager.terminateSession(sessionId);
    response.writeHead(204);
    response.end();
  }

  private handleWebSocketConnection(ws: WebSocket, session: TerminalSession): void {
    this.logger.debug(`WebSocket connected to session ${session.sessionId}`);

    // Track connection
    if (!this.wsConnections.has(session.sessionId)) {
      this.wsConnections.set(session.sessionId, new Set());
    }
    this.wsConnections.get(session.sessionId)!.add(ws);

    // Forward PTY output to WebSocket
    const dataHandler = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ServerMessage = { type: 'output', data };
        ws.send(JSON.stringify(msg));
      }
    };
    session.on('data', dataHandler);

    // Forward PTY exit to WebSocket
    const exitHandler = (code: number, signal?: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ServerMessage = { type: 'exit', code, signal };
        ws.send(JSON.stringify(msg));
        ws.close();
      }
    };
    session.on('exit', exitHandler);

    // Handle incoming WebSocket messages
    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());
        this.handleClientMessage(session, msg, ws);
      } catch (error) {
        this.logger.warn(`Invalid WebSocket message: ${error}`);
      }
    });

    // Handle WebSocket close
    ws.on('close', () => {
      this.logger.debug(`WebSocket disconnected from session ${session.sessionId}`);
      session.removeListener('data', dataHandler);
      session.removeListener('exit', exitHandler);
      
      const connections = this.wsConnections.get(session.sessionId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          this.wsConnections.delete(session.sessionId);
        }
      }
    });

    // Handle WebSocket error
    ws.on('error', (error) => {
      this.logger.error(`WebSocket error: ${error}`);
    });

    // Send initial ping
    const pong: ServerMessage = { type: 'pong' };
    ws.send(JSON.stringify(pong));
  }

  private handleClientMessage(
    session: TerminalSession,
    msg: ClientMessage,
    ws: WebSocket,
  ): void {
    switch (msg.type) {
      case 'input':
        if (msg.data) {
          session.write(msg.data);
        }
        break;

      case 'resize':
        if (msg.cols && msg.rows) {
          session.resize(msg.cols, msg.rows);
        }
        break;

      case 'signal':
        if (msg.signal) {
          session.sendSignal(msg.signal);
        }
        break;

      case 'ping':
        const pong: ServerMessage = { type: 'pong' };
        ws.send(JSON.stringify(pong));
        break;

      case 'permission_response':
        // TODO: Handle permission responses for interactive prompts
        this.logger.debug(`Permission response: ${msg.requestId} = ${msg.granted}`);
        break;

      default:
        this.logger.warn(`Unknown message type: ${(msg as any).type}`);
    }
  }

  private handleCors(response: HttpResponse): void {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    response.end();
  }

  private sendJson(response: HttpResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  private sendError(response: HttpResponse, status: number, message: string): void {
    this.sendJson(response, status, { error: message });
  }

  private readBody(request: HttpRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks).toString()));
      request.on('error', reject);
    });
  }

  /**
   * Get the session manager for external access
   */
  getSessionManager(): TerminalSessionManager {
    return this.sessionManager;
  }
}
