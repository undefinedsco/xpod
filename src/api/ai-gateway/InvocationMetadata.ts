import type { IncomingHttpHeaders } from 'node:http';
import { GatewayProtocolError } from './errors';

/** Per-invocation client identity/routing hints, never Pod credentials or headers. */
export interface GatewayInvocationMetadata {
  sessionId?: string;
  userAgent?: string;
}

// The sole declaration of which client metadata may cross the Gateway boundary.
const INVOCATION_HEADERS = [
  { header: 'x-opencode-session', field: 'sessionId', maxLength: 256, pattern: /^[\x21-\x2b\x2d-\x7e]+$/u },
  { header: 'user-agent', field: 'userAgent', maxLength: 512, pattern: /^[\x20-\x7e]+$/u },
] as const;

function validateValue(value: unknown, rule: typeof INVOCATION_HEADERS[number]): string {
  if (typeof value !== 'string' || !value.trim() || value.length > rule.maxLength || !rule.pattern.test(value)) {
    throw new GatewayProtocolError(`Invalid ${rule.header} invocation header`, { code: 'invalid_request', status: 400 });
  }
  return value;
}

export function readGatewayInvocationMetadata(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[] = [],
): GatewayInvocationMetadata {
  const metadata: GatewayInvocationMetadata = {};
  for (const rule of INVOCATION_HEADERS) {
    const entries = Object.entries(headers).filter(([name]) => name.toLowerCase() === rule.header);
    const wireCount = rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === rule.header).length;
    if (entries.length > 1 || wireCount > 1) {
      throw new GatewayProtocolError(`Repeated ${rule.header} invocation header`, { code: 'invalid_request', status: 400 });
    }
    if (entries.length) metadata[rule.field] = validateValue(entries[0][1], rule);
  }
  return metadata;
}

/** Rebuild only declared headers; runtime objects cannot smuggle auth or host. */
export function gatewayInvocationHeaders(metadata?: GatewayInvocationMetadata): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of INVOCATION_HEADERS) {
    const value = metadata?.[rule.field];
    if (value !== undefined) headers[rule.header] = validateValue(value, rule);
  }
  return headers;
}
