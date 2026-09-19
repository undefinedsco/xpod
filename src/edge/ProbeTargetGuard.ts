import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import dns from 'node:dns';

/**
 * Address ranges a Cloud probe must never contact: the probe target comes from node
 * metadata, so without this an edge node could make the cluster fetch its own private
 * network, loopback services or the cloud metadata endpoint.
 */
const BLOCKED_IPV4 = new BlockList();
for (const [ network, prefix ] of [
  [ '0.0.0.0', 8 ],
  [ '10.0.0.0', 8 ],
  [ '100.64.0.0', 10 ],
  [ '127.0.0.0', 8 ],
  [ '169.254.0.0', 16 ],
  [ '172.16.0.0', 12 ],
  [ '192.0.0.0', 24 ],
  [ '192.0.2.0', 24 ],
  [ '192.168.0.0', 16 ],
  [ '198.18.0.0', 15 ],
  [ '198.51.100.0', 24 ],
  [ '203.0.113.0', 24 ],
  [ '224.0.0.0', 4 ],
  [ '240.0.0.0', 4 ],
] as const) {
  BLOCKED_IPV4.addSubnet(network, prefix, 'ipv4');
}
// IPv4-mapped addresses are normalized to IPv4 before checking, so the two families stay
// in separate lists: a mixed list makes `check(ipv4Address, 'ipv4')` match IPv6 rules.
const BLOCKED_IPV6 = new BlockList();
for (const [ network, prefix ] of [
  [ '::', 128 ],
  [ '::1', 128 ],
  [ '64:ff9b::', 96 ],
  [ 'fc00::', 7 ],
  [ 'fe80::', 10 ],
  [ 'ff00::', 8 ],
  [ '2001:db8::', 32 ],
] as const) {
  BLOCKED_IPV6.addSubnet(network, prefix, 'ipv6');
}

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

export type ProbeTargetDecision =
  | { allowed: true; address: string }
  | { allowed: false; reason: string };

/** Whether an address is a public unicast address a Cloud probe may contact. */
export function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeMappedIpv4(address);
  const family = isIP(normalized);
  if (family === 4) {
    return !BLOCKED_IPV4.check(normalized, 'ipv4');
  }
  if (family === 6) {
    return !BLOCKED_IPV6.check(normalized, 'ipv6');
  }
  return false;
}

function normalizeMappedIpv4(address: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return match ? match[1] : address;
}

/** Resolves every address of a probe hostname; injected in tests. */
export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Decides whether a probe target may be contacted.
 *
 * Every resolved address has to be public, so a hostname that mixes public and private
 * records is refused instead of racing whichever record the connection picks.
 */
export async function assertPublicProbeTarget(
  url: URL,
  resolveAddresses: ResolveAddresses = resolveHostAddresses,
): Promise<ProbeTargetDecision> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `unsupported-scheme:${url.protocol}` };
  }

  const hostname = url.hostname.replace(/^\[/u, '').replace(/\]$/u, '');
  if (isIP(hostname) !== 0) {
    return isPublicIpAddress(hostname)
      ? { allowed: true, address: hostname }
      : { allowed: false, reason: `non-public-address:${hostname}` };
  }

  let addresses: string[];
  try {
    addresses = await resolveAddresses(hostname);
  } catch (error) {
    return { allowed: false, reason: `unresolvable:${(error as Error).message}` };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: 'unresolvable' };
  }
  const blocked = addresses.find((address) => !isPublicIpAddress(address));
  if (blocked) {
    return { allowed: false, reason: `non-public-address:${blocked}` };
  }
  return { allowed: true, address: addresses[0] };
}

export interface HeadProbeRequestOptions {
  /** Address the connection is pinned to, already validated by the target policy. */
  address: string;
  timeoutMs: number;
}

export type HeadProbeRequest = (
  url: URL,
  options: HeadProbeRequestOptions,
) => Promise<{ status: number; location?: string }>;

/**
 * HEAD request pinned to a validated address.
 *
 * Pinning is what makes the DNS check meaningful: without it the client would resolve the
 * hostname a second time and a rebinding answer could still reach a private address.
 */
export function createPinnedHeadProbeRequest(): HeadProbeRequest {
  return (url, { address, timeoutMs }) => new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'HEAD',
      timeout: timeoutMs,
      lookup: (_hostname, options, callback) => {
        const entry = { address, family: isIP(address) === 6 ? 6 : 4 };
        // Node asks for every family when happy-eyeballs is enabled.
        if (options && typeof options === 'object' && options.all) {
          (callback as (error: null, addresses: typeof entry[]) => void)(null, [ entry ]);
          return;
        }
        (callback as (error: null, address: string, family: number) => void)(null, entry.address, entry.family);
      },
    }, (response) => {
      response.resume();
      resolve({
        status: response.statusCode ?? 0,
        location: typeof response.headers.location === 'string' ? response.headers.location : undefined,
      });
    });
    request.on('timeout', () => request.destroy(new Error('probe-timeout')));
    request.on('error', reject);
    request.end();
  });
}
