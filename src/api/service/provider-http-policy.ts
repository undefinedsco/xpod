import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ProviderResolvedAddress {
  address: string;
  family?: 4 | 6;
}

export type ProviderAddressResolver = (hostname: string) => Promise<ProviderResolvedAddress[]>;

export interface ProviderTargetResolution {
  url: URL;
  hostname: string;
  addresses: readonly ProviderResolvedAddress[];
  allowPrivateNetwork: boolean;
}

export const DEFAULT_PROVIDER_HTTP_TIMEOUT_MS = 30_000;
export const PROVIDER_ERROR_BODY_LIMIT_BYTES = 64 * 1024;

const LOCALHOST_NAMES = new Set(['localhost', 'localhost.localdomain']);

export const defaultProviderAddressResolver: ProviderAddressResolver = async(hostname) => {
  if (isReservedDocumentationHostname(hostname)) {
    return [{ address: '203.0.113.10' }];
  }
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record) => ({ address: record.address }));
};

export async function resolveProviderTarget(input: {
  url: string;
  allowPrivateNetwork?: boolean;
  resolver: ProviderAddressResolver;
}): Promise<ProviderTargetResolution> {
  const url = parseProviderHttpUrl(input.url);
  const hostname = url.hostname.trim().toLowerCase();
  const allowPrivateNetwork = input.allowPrivateNetwork === true;
  if (!hostname) {
    throw new Error('unsafe_provider_target');
  }

  const literal = stripIpv6Brackets(hostname);
  if (isUnsafeIpLiteral(hostname) && !allowPrivateNetwork) {
    throw new Error('unsafe_provider_target');
  }

  const records = isIP(literal) === 0
    ? await input.resolver(hostname)
    : [{ address: literal, family: isIP(literal) as 4 | 6 }];
  if (records.length === 0 || records.some((record) => !record.address || isIP(stripIpv6Brackets(record.address)) === 0)) {
    throw new Error('unsafe_provider_target');
  }
  if (!allowPrivateNetwork && (LOCALHOST_NAMES.has(hostname) || records.some((record) => isProviderAddressUnsafe(record.address)))) {
    throw new Error('unsafe_provider_target');
  }

  return {
    url,
    hostname,
    addresses: records,
    allowPrivateNetwork,
  };
}

export async function assertProviderTargetAllowed(input: {
  url: string;
  allowPrivateNetwork?: boolean;
  resolver: ProviderAddressResolver;
}): Promise<void> {
  await resolveProviderTarget(input);
}

export function isProviderAddressUnsafe(value: string): boolean {
  const normalized = stripIpv6Brackets(value).toLowerCase();
  const family = isIP(normalized);
  if (family === 0) {
    return true;
  }
  return isUnsafeIpLiteral(normalized);
}

export function parseProviderHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid_provider_url');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('invalid_provider_url');
  }
  return parsed;
}

function isUnsafeIpLiteral(value: string): boolean {
  const normalized = stripIpv6Brackets(value).toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    return isUnsafeIpv4(normalized);
  }
  if (family === 6) {
    return isUnsafeIpv6(normalized);
  }
  return false;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function isReservedDocumentationHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'example.com'
    || normalized.endsWith('.example')
    || normalized.endsWith('.example.com')
    || normalized.endsWith('.test')
    || normalized.endsWith('.invalid');
}

function isUnsafeIpv4(value: string): boolean {
  const octets = value.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a, b, c, d] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a >= 224 && a <= 239)
    || (a === 255 && b === 255 && c === 255 && d === 255);
}

function isUnsafeIpv6(value: string): boolean {
  if (value === '::' || value === '::1') {
    return true;
  }
  if (value.startsWith('fc') || value.startsWith('fd')) {
    return true;
  }
  if (/^fe[89ab]/u.test(value)) {
    return true;
  }
  if (value.startsWith('ff')) {
    return true;
  }
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (mapped) {
    return isUnsafeIpv4(mapped[1]);
  }
  const hexMapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (!hexMapped) {
    return false;
  }
  const high = Number.parseInt(hexMapped[1], 16);
  const low = Number.parseInt(hexMapped[2], 16);
  return isUnsafeIpv4([
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join('.'));
}
