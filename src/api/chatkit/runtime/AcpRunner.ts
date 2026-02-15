import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { getLoggerFor } from 'global-logger-factory';

type JsonRpcId = number;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface AcpRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

/**
 * ACP runner over stdio using JSON-RPC 2.0 + NDJSON transport.
 *
 * Spec: https://agentclientprotocol.com/overview
 */
export class AcpRunner extends EventEmitter {
  private readonly logger = getLoggerFor(this);
  private proc?: ChildProcessWithoutNullStreams;
  private nextId: JsonRpcId = 1;
  private pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();

  start(options: AcpRunnerOptions): void {
    if (this.proc) {
      throw new Error('ACP runner already started');
    }

    this.proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
      } as NodeJS.ProcessEnv,
      stdio: 'pipe',
    });

    const rl = readline.createInterface({ input: this.proc.stdout });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        // Some agents may print logs to stdout; ignore non-JSON lines.
        this.emit('stdout', line);
        return;
      }
      void this.handleMessage(msg);
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (data: string) => {
      // Keep stderr observable for debugging; do not treat it as protocol.
      this.emit('stderr', data);
    });

    this.proc.on('exit', (code, signal) => {
      this.logger.debug(`ACP process exited: code=${code}, signal=${signal}`);
      for (const [ id, p ] of this.pending.entries()) {
        p.reject(new Error(`ACP process exited before response (id=${id})`));
      }
      this.pending.clear();
      this.emit('exit', code ?? null, signal ?? undefined);
      this.proc = undefined;
      rl.close();
    });

    this.proc.on('error', (err) => {
      this.logger.error(`ACP spawn error: ${err}`);
      this.emit('error', err);
    });
  }

  stop(signal: 'SIGINT' | 'SIGTERM' = 'SIGINT'): void {
    if (!this.proc) {
      return;
    }
    this.proc.kill(signal);
  }

  isRunning(): boolean {
    return Boolean(this.proc);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc) {
      throw new Error('ACP runner is not started');
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const payload = `${JSON.stringify(req)}\n`;

    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
    });

    this.proc.stdin.write(payload);
    return p;
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc) {
      throw new Error('ACP runner is not started');
    }
    const n: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(`${JSON.stringify(n)}\n`);
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if ('id' in msg && typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if ('method' in msg && typeof msg.method === 'string') {
      // Agent -> client request (has id).
      if ('id' in msg && typeof (msg as any).id === 'number') {
        const id = (msg as any).id as number;
        const request = {
          id,
          method: msg.method,
          params: (msg as any).params,
          respond: (result: unknown): void => {
            this.writeResponse({ jsonrpc: '2.0', id, result });
          },
          fail: (code: number, message: string, data?: unknown): void => {
            this.writeResponse({ jsonrpc: '2.0', id, error: { code, message, data } });
          },
        };

        if (this.listenerCount('request') > 0) {
          this.emit('request', request);
        } else {
          request.fail(-32601, `Method not found: ${msg.method}`);
        }
        return;
      }

      this.emit('notification', msg.method, msg.params);
      return;
    }
  }

  private writeResponse(res: JsonRpcResponse): void {
    if (!this.proc) {
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(res)}\n`);
  }
}
