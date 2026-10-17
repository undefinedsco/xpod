import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RefreshProfile } from './browserRefreshPolicy';
import { createSolidLocalRouteFetch, discoverSolidLocalRoute, resolveSolidLocalRouteUrl } from '../../packages/solid-sdk/src/local-route-fetch';

const { validateInput } = createRequire(import.meta.url)('../../scripts/lib/service-image-session-contract.cjs');

// The shape is for TypeScript callers only. The central contract owns validation.
export interface ExternalRefreshInput {
  schemaVersion: number;
  sourceSha: string;
  mode: 'cloud' | 'local' | 'standalone';
  baseUrl: string;
  issuer: string;
  image: { reference: string; platform: string; id: string };
  profile: { kind: RefreshProfile; accessTokenTtl: number; refreshTokenTtl: number; originalConfigSHA256: string; derivedConfigSHA256: string };
  binding: { webId: string; podUrl: string };
  ownershipRoot: string;
  accountFile: string;
  outputDirectory: string;
}

/** Reject symlinks in every ancestor, not just a lexical path prefix. */
export function assertPlainPath(filename: string, kind: 'file' | 'directory', privateFile = false): void {
  const absolute = path.resolve(filename);
  let cursor = path.parse(absolute).root;
  const parts = absolute.slice(cursor.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error('Unsafe fixture path');
  }
  const stat = lstatSync(absolute);
  if (kind === 'file' ? !stat.isFile() || stat.size > 65536 : !stat.isDirectory()) throw new Error('Invalid fixture file');
  if (privateFile && (stat.mode & 0o777) !== 0o600) throw new Error('Fixture file must have mode 0600');
}

export function readExternalRefreshFixture(filename: string, createOutput = false): {
  input: ExternalRefreshInput;
  ready: { baseUrl: string; account: { email: string; password: string; webId: string; podUrl: string }; accessTokenTtl: number; refreshTokenTtl: number };
} {
  if (!filename) throw new Error('External refresh manifest is empty');
  assertPlainPath(filename, 'file', true);
  const input = validateInput(JSON.parse(readFileSync(filename, 'utf8'))) as ExternalRefreshInput;
  assertPlainPath(input.ownershipRoot, 'directory');
  const root = realpathSync(input.ownershipRoot);
  for (const item of [filename, input.accountFile, input.outputDirectory]) {
    const relative = path.relative(root, path.resolve(item));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture path outside owned root');
  }
  assertPlainPath(input.accountFile, 'file', true);
  assertPlainPath(path.dirname(input.outputDirectory), 'directory');
  const account = JSON.parse(readFileSync(input.accountFile, 'utf8')) as Record<string, unknown>;
  if (typeof account.email !== 'string' || !account.email || typeof account.password !== 'string' || !account.password
    || account.webId !== input.binding.webId || account.podUrl !== input.binding.podUrl) throw new Error('Fixture account binding mismatch');
  // B owns the one non-recursive 0700 output creation; A passes an unused path.
  if (createOutput && !existsSync(input.outputDirectory)) mkdirSync(input.outputDirectory, { mode: 0o700 });
  assertPlainPath(input.outputDirectory, 'directory');
  return { input, ready: { baseUrl: input.baseUrl, account: {
    email: account.email, password: account.password, ...input.binding,
  }, accessTokenTtl: input.profile.accessTokenTtl, refreshTokenTtl: input.profile.refreshTokenTtl } };
}

export function externalRefreshPrivateRoot(input: ExternalRefreshInput): string {
  return path.join(path.dirname(input.accountFile), 'private-session');
}

/** Reuse the SDK's authoritative local-route contract; never infer a Pod origin. */
export async function verifyExternalRefreshStorage(input: ExternalRefreshInput, transport: typeof fetch = fetch): Promise<typeof fetch> {
  if (input.mode !== 'local') {
    if (new URL(input.binding.podUrl).origin !== new URL(input.baseUrl).origin) throw new Error('Pod is not bound to the storage deployment');
    return transport;
  }
  const route = await discoverSolidLocalRoute({ fetch: transport, localBaseUrl: input.baseUrl,
    statusUrl: new URL('provision/status', input.baseUrl).href });
  const mapped = route && resolveSolidLocalRouteUrl(input.binding.podUrl, [route]);
  if (!route || !mapped || mapped.origin !== new URL(input.baseUrl).origin
    || new URL(input.binding.podUrl).origin === new URL(input.issuer).origin) {
    throw new Error('Pod is not bound to the verified managed Local route');
  }
  return createSolidLocalRouteFetch({ fetch: transport, routes: () => [route] });
}

export function externalRefreshFromEnvironment(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof readExternalRefreshFixture> | undefined {
  // Presence, including an empty value, selects external mode. Never fall back.
  return Object.prototype.hasOwnProperty.call(env, 'XPOD_E2E_REFRESH_MANIFEST') ? readExternalRefreshFixture(env.XPOD_E2E_REFRESH_MANIFEST!) : undefined;
}
