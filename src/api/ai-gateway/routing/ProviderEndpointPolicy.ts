import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { GatewayProtocolError } from '../errors';

export interface ProviderEndpointPolicyOptions {
  allowPrivateNetwork: boolean;
  resolve?: typeof lookup;
}

export async function assertAllowedProviderEndpoint(
  rawUrl: string,
  options: ProviderEndpointPolicyOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalidEndpoint('Provider endpoint must be an absolute URL');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw invalidEndpoint('Provider endpoint must use HTTP(S) without embedded credentials');
  }
  if (!options.allowPrivateNetwork && url.protocol !== 'https:') {
    throw invalidEndpoint('Cloud provider endpoints must use HTTPS');
  }
  if (options.allowPrivateNetwork) {
    return;
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateAddress(hostname)) {
    throw invalidEndpoint('Cloud provider endpoints cannot target private network addresses');
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await (options.resolve ?? lookup)(hostname, { all: true, verbatim: true });
  } catch {
    throw invalidEndpoint('Provider endpoint hostname could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw invalidEndpoint('Cloud provider endpoints cannot resolve to private network addresses');
  }
}

function invalidEndpoint(message: string): GatewayProtocolError {
  return new GatewayProtocolError(message, {
    code: 'invalid_request',
    status: 400,
  });
}

function isPrivateAddress(value: string): boolean {
  const normalized = value.toLowerCase().split('%', 1)[0];
  const version = isIP(normalized);
  if (version === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (version === 6) {
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/u.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return false;
}
