/**
 * Reaching a delegated federation endpoint the way the specification requires.
 *
 * `.well-known`/SRV delegation means a server's endpoint lives at another host:port than its server
 * name. The specification is explicit that the *server name* is what the connection has to prove —
 * the TLS certificate must cover it and the `Host` header must carry it — because otherwise the
 * delegated host could answer for a name it does not own.
 *
 * `fetch` can do neither: it derives both from the URL, and the fetch specification forbids setting
 * `Host`. So this is the transport that can. It connects to the address that was resolved while
 * presenting the original server name as SNI and as `Host`; everything else is the caller's — the
 * method, path, query, headers and body it was given are what is sent.
 *
 * The request is built as a value first (`federationRequestOptions`), so what would be presented is
 * testable without a socket, and the socket part stays a thin adapter over `node:http(s)`.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { splitServerName } from '../protocol/serverName';

/** Where a server name's endpoint actually is, and the name it must prove. */
export interface FederationRequestTarget {
  /** The resolved address, e.g. `https://delegated.example:8448`. */
  baseUrl: string;
  /** The server name the request is for: what the certificate and `Host` must carry. */
  hostHeader: string;
}

/** A transport that can present the name a delegated endpoint is being asked for. */
export type FederationFetchTarget = (input: {
  url: string;
  init: RequestInit;
  target: FederationRequestTarget;
}) => Promise<Response>;

export interface FederationRequestPlan {
  protocol: 'http:' | 'https:';
  hostname: string;
  port?: number;
  path: string;
  /** SNI: the host the certificate must cover, which is the server name and not the address. */
  servername: string;
  headers: Record<string, string>;
}

/**
 * The request to make, as values.
 *
 * `hostname`/`port` are the resolved address; `servername` and the `Host` header are the server
 * name. A server name with an explicit port keeps it in `Host` (that is the authority the peer
 * expects) while SNI carries only the host, because SNI has no ports.
 */
export function federationRequestOptions(input: {
  url: string;
  target: FederationRequestTarget;
  init: RequestInit;
}): FederationRequestPlan {
  const address = new URL(input.url);
  if (address.protocol !== 'http:' && address.protocol !== 'https:') {
    throw new Error(`Federation is reached over HTTP(S), not ${address.protocol}`);
  }
  const headers = headerRecord(input.init.headers);
  headers.host = input.target.hostHeader;
  return {
    protocol: address.protocol,
    hostname: address.hostname,
    ...(address.port === '' ? {} : { port: Number(address.port) }),
    path: `${address.pathname}${address.search}`,
    servername: splitServerName(input.target.hostHeader).host,
    headers,
  };
}

export interface NodeFederationFetchOptions {
  /** A CA bundle to trust, when the deployment terminates TLS with its own authority. */
  ca?: RequestOptions['ca'];
  /** Only for a deployment that has decided to talk to peers it cannot verify. */
  rejectUnauthorized?: boolean;
}

/**
 * The transport itself: a thin adapter over `node:http(s)` that sets SNI and `Host` from the plan.
 *
 * A non-2xx answer is a Response, not an exception: the caller classifies statuses (that is what
 * makes "the peer refused" different from "the peer is unreachable"), and only a transport failure
 * throws here.
 */
export function createNodeFederationFetch(options: NodeFederationFetchOptions = {}): FederationFetchTarget {
  return async ({ url, init, target }) => {
    const plan = federationRequestOptions({ url, target, init });
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body !== undefined) plan.headers['content-length'] = String(Buffer.byteLength(body));

    const answer = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
      const send = plan.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send({
        protocol: plan.protocol,
        hostname: plan.hostname,
        ...(plan.port === undefined ? {} : { port: plan.port }),
        path: plan.path,
        method: init.method ?? 'GET',
        headers: plan.headers,
        ...(plan.protocol === 'https:'
          ? {
            servername: plan.servername,
            ...(options.ca === undefined ? {} : { ca: options.ca }),
            ...(options.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
          }
          : {}),
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: headerRecord(response.headers),
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });

    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  };
}

/** Request headers as a plain record; a `Headers` instance and arrays are both accepted. */
function headerRecord(headers: RequestInit['headers'] | Record<string, string | string[] | undefined>): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (typeof (headers as Headers).forEach === 'function' && typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    (headers as Headers).forEach((value, name) => { record[name.toLowerCase()] = value; });
    return record;
  }
  for (const [ name, value ] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (value === undefined) continue;
    record[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return record;
}
