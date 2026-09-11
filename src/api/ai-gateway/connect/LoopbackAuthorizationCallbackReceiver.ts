import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface AuthorizationCodeCallbackReceiver {
  register(input: {
    redirectUris: string[];
    state: string;
    expiresAt: Date;
    onCallback(result: { code?: string; error?: string }): Promise<void> | void;
  }): Promise<{ redirectUri: string; close(): void }>;
}

type RegistrationInput = Parameters<AuthorizationCodeCallbackReceiver['register']>[0];
type Registration = RegistrationInput & { path: string; close(): void };
type Listener = { server: Server; registrations: Map<string, Registration> };

/** Receives authorization codes locally; credential exchange belongs to the authenticated caller. */
export class LoopbackAuthorizationCallbackReceiver implements AuthorizationCodeCallbackReceiver {
  private readonly listeners = new Map<number, Listener>();
  private pending: Promise<unknown> = Promise.resolve();

  public register(input: RegistrationInput): ReturnType<AuthorizationCodeCallbackReceiver['register']> {
    const result = this.pending.then(() => this.registerSerial(input));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async registerSerial(input: RegistrationInput): ReturnType<AuthorizationCodeCallbackReceiver['register']> {
    if (!input.state || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()) {
      throw new Error('Authorization callback registration is invalid or expired.');
    }
    if ([...this.listeners.values()].some(listener => listener.registrations.has(input.state))) {
      throw new Error('Authorization callback state is already registered.');
    }
    const uris = input.redirectUris.map(value => {
      let uri: URL;
      try { uri = new URL(value); } catch { throw new Error('Invalid loopback authorization redirect URI.'); }
      if (uri.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(uri.hostname) ||
        uri.username || uri.password || uri.search || uri.hash || uri.port === '0') {
        throw new Error('Invalid loopback authorization redirect URI.');
      }
      return uri;
    });
    for (const uri of uris) {
      const port = Number(uri.port || 80);
      let listener = this.listeners.get(port);
      if (!listener) {
        const registrations = new Map<string, Registration>();
        const server = createServer((request, response) => {
          void this.handle(request, response, port, registrations);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
              server.removeListener('error', reject);
              resolve();
            });
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') { continue; }
          throw new Error('Unable to start the local authorization callback listener.');
        }
        server.unref();
        listener = { server, registrations };
        this.listeners.set(port, listener);
      }
      const selected = listener;
      let timer: ReturnType<typeof setTimeout>;
      let active = true;
      const close = (): void => {
        if (!active) { return; }
        active = false;
        clearTimeout(timer);
        selected.registrations.delete(input.state);
        if (selected.registrations.size === 0 && this.listeners.get(port) === selected) {
          this.listeners.delete(port);
          selected.server.close();
        }
      };
      selected.registrations.set(input.state, { ...input, path: uri.pathname, close });
      timer = setTimeout(close, Math.max(0, Math.min(input.expiresAt.getTime() - Date.now(), 2_147_483_647)));
      timer.unref();
      return { redirectUri: uri.toString(), close };
    }
    throw new Error('The registered local authorization callback ports are unavailable. Close the application using them and retry.');
  }

  private async handle(request: IncomingMessage, response: ServerResponse, port: number,
    registrations: Map<string, Registration>): Promise<void> {
    const reply = (status: number, success = false): void => {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'close',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      });
      response.end(success ? '授权已返回 Xpod，请切回应用完成连接。' : '授权回调无效或已过期，请返回应用重试。');
    };
    const allowedHosts = ['localhost', '127.0.0.1'].map(host => port === 80 ? host : `${host}:${port}`);
    if (request.method !== 'GET' || !allowedHosts.includes(request.headers.host ?? '') ||
      !request.url?.startsWith('/') || request.url.startsWith('//') ||
      request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) {
      reply(400); return;
    }
    let uri: URL;
    try { uri = new URL(request.url, `http://127.0.0.1:${port}`); } catch { reply(400); return; }
    const query = uri.searchParams;
    if (['state', 'code', 'error'].some(key => query.getAll(key).length > 1) ||
      !query.get('state') || (!!query.get('code') === !!query.get('error')) ||
      (query.has('code') && query.has('error'))) {
      reply(400); return;
    }
    const registration = registrations.get(query.get('state')!);
    if (!registration || registration.path !== request.url.split('?')[0] || uri.hash ||
      registration.expiresAt.getTime() <= Date.now()) {
      reply(400); return;
    }
    registration.close();
    try {
      await registration.onCallback(query.has('code') ? { code: query.get('code')! } : { error: query.get('error')! });
      reply(200, !query.has('error'));
    } catch {
      reply(500);
    }
  }
}
