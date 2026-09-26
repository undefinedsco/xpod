import {
  assertPublicProbeTarget,
  createPinnedHeadProbeRequest,
  type HeadProbeRequest,
  type ResolveAddresses,
} from '../../edge/ProbeTargetGuard';

/**
 * "Is my public entry actually serving?" — asked on demand, never on a timer (audit N12).
 *
 * The settings page used to answer only "the address is configured". The operator now gets a
 * real measurement, but the probe is deliberately narrow, because it makes the node issue an
 * outbound request to a configured address:
 *
 *   - it only ever runs when the operator asks (the diagnose action), never periodically;
 *   - only `https` targets are accepted: an entry that serves plaintext is a configuration
 *     error, and probing it would put the operator's traffic on the wire unencrypted;
 *   - every resolved address must be public (the same guard the Cloud probe uses), so the
 *     entry cannot bounce the node into loopback, RFC1918, link-local or the metadata
 *     endpoint, and each redirect hop is validated again;
 *   - the connection is pinned to the address that was validated, so a second DNS answer
 *     cannot swap in a private address between check and connect;
 *   - the verdict says "reachable from this node" and nothing more: many networks do not
 *     support NAT hairpin, so a node failing to reach its own public entry is not proof that
 *     remote users cannot, and vice versa.
 */

export interface EndpointReachabilityProbeOptions {
  resolveAddresses?: ResolveAddresses;
  headRequest?: HeadProbeRequest;
  timeoutMs?: number;
  maxRedirects?: number;
  now?: () => Date;
}

export type EndpointReachabilityVerdict = 'reachable-from-this-node' | 'unreachable' | 'blocked';

export interface EndpointReachabilityResult {
  target: string;
  verdict: EndpointReachabilityVerdict;
  /** Present whenever the entry answered at all (including 4xx: the entry is serving). */
  httpStatus?: number;
  /** Time from the first request to the final answer, including redirects. */
  latencyMs?: number;
  reason?: string;
  detail: string;
  checkedAt: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REDIRECTS = 3;

export async function probeEndpointReachability(
  endpoint: string,
  options: EndpointReachabilityProbeOptions = {},
): Promise<EndpointReachabilityResult> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxRedirects = Math.max(0, Math.trunc(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
  const resolveAddresses = options.resolveAddresses;
  const headRequest = options.headRequest ?? createPinnedHeadProbeRequest();

  const startUrl = parseEndpointUrl(endpoint);
  if (!startUrl) {
    return {
      target: endpoint,
      verdict: 'blocked',
      reason: 'invalid-url',
      detail: 'cannot probe: the address is not a usable URL',
      checkedAt,
    };
  }

  // Plaintext entries are not probed: the point of the check is the entry users reach, and an
  // operator needs to fix the scheme before anything else is meaningful.
  if (startUrl.protocol !== 'https:') {
    return {
      target: startUrl.toString(),
      verdict: 'blocked',
      reason: `insecure-scheme:${startUrl.protocol}`,
      detail: 'not probed: only https entries are probed',
      checkedAt,
    };
  }

  const startedAt = Date.now();
  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const decision = await assertPublicProbeTarget(url, resolveAddresses);
    if (!decision.allowed) {
      return {
        target: startUrl.toString(),
        verdict: 'blocked',
        reason: `blocked-target:${decision.reason}`,
        detail: `not probed: ${decision.reason}（只对公网地址发探测）`,
        checkedAt,
      };
    }

    let response: Awaited<ReturnType<HeadProbeRequest>>;
    try {
      response = await headRequest(url, { address: decision.address, timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed? ?out|ETIMEDOUT|aborted/iu.test(message);
      return {
        target: startUrl.toString(),
        verdict: 'unreachable',
        reason: timedOut ? 'timeout' : `connection-error:${message}`,
        latencyMs: Date.now() - startedAt,
        detail: timedOut
          ? `unreachable from this node: no answer within ${timeoutMs}ms`
          : `unreachable from this node: ${message}`,
        checkedAt,
      };
    }

    if (response.status >= 300 && response.status < 400 && response.location) {
      const next = safeUrl(response.location, url);
      if (!next) {
        return {
          target: startUrl.toString(),
          verdict: 'unreachable',
          reason: 'invalid-redirect',
          latencyMs: Date.now() - startedAt,
          detail: 'unreachable from this node: the entry redirected to an unusable address',
          checkedAt,
        };
      }
      url = next;
      continue;
    }

    const latencyMs = Date.now() - startedAt;
    return {
      target: startUrl.toString(),
      verdict: 'reachable-from-this-node',
      httpStatus: response.status,
      latencyMs,
      detail: `reachable from this node: HTTP ${response.status} in ${latencyMs}ms`
        + '（网络可能不支持回环，不代表外部用户可达）',
      checkedAt,
    };
  }

  return {
    target: startUrl.toString(),
    verdict: 'unreachable',
    reason: 'too-many-redirects',
    latencyMs: Date.now() - startedAt,
    detail: `unreachable from this node: more than ${maxRedirects} redirects`,
    checkedAt,
  };
}

function parseEndpointUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed);
  } catch {
    try {
      return new URL(`https://${trimmed}`);
    } catch {
      return undefined;
    }
  }
}

function safeUrl(value: string, base: URL): URL | undefined {
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
