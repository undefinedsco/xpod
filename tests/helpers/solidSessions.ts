import { SolidSessionFactory } from '../../src/api/auth/SolidSessionFactory';

/**
 * The real session factory for tests: one exchange path, with the transport injected so the
 * test can observe token traffic without touching the network.
 */
export function createTestSolidSessions(input: {
  tokenEndpoint: string;
  publicBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}): SolidSessionFactory {
  return new SolidSessionFactory({
    tokenEndpoint: input.tokenEndpoint,
    ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}
