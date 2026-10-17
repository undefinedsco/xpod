import { OBJECT_STORE_PORT } from './dockerObjectStore';

/** Host publications only: container ports and application configuration stay unchanged. */
export function resolveFullIntegrationInfra(env: NodeJS.ProcessEnv = process.env) {
  const definitions = {
    postgres: ['XPOD_FULL_POSTGRES_PORT', 5432],
    redis: ['XPOD_FULL_REDIS_PORT', 6379],
    objectStore: ['XPOD_FULL_OBJECT_STORE_PORT', OBJECT_STORE_PORT],
  } as const;
  const hostEnv: Record<string, string> = {};
  const ports = {} as Record<keyof typeof definitions, number>;
  for (const name of Object.keys(definitions) as (keyof typeof definitions)[]) {
    const [key, fallback] = definitions[name];
    const raw = env[key];
    if (raw !== undefined && (!/^[1-9]\d{0,4}$/u.test(raw) || Number(raw) > 65535)) {
      throw new Error(`Invalid ${key}: expected a decimal host port from 1 to 65535`);
    }
    ports[name] = raw === undefined ? fallback : Number(raw);
    hostEnv[key] = String(ports[name]);
  }
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) {
    throw new Error('Full infrastructure host ports must be distinct');
  }
  let postgresUrl = env.XPOD_FULL_PG_URL ?? `postgres://xpod:xpod@localhost:${ports.postgres}/xpod`;
  let parsed: URL;
  try { parsed = new URL(postgresUrl); } catch { throw new Error('Invalid XPOD_FULL_PG_URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    || Number(parsed.port || '5432') !== ports.postgres
    // pg-connection-string lets query parameters override the URL authority.
    || parsed.searchParams.getAll('host').some(host => !['localhost', '127.0.0.1', '::1'].includes(host))
    || parsed.searchParams.getAll('port').some(port => port !== String(ports.postgres))) {
    // Never include the URL: it can contain user credentials.
    throw new Error('XPOD_FULL_PG_URL must address the selected loopback PostgreSQL host port');
  }
  // An explicit port also prevents pg's PGPORT fallback from selecting foreign infra.
  if (!parsed.port) { parsed.port = String(ports.postgres); postgresUrl = parsed.toString(); }
  return { ports, hostEnv, postgresUrl };
}
