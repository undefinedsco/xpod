#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentDirectoryClient, type AgentDirectoryRequest } from '../src/agent-directory/client/AgentDirectoryClient';
import { normalizePodRoot } from '../src/cli/agent-fs/roots';

export interface LiveDirectoryOptions {
  /** Canonical Xpod root that hosts the optional CSS/API/AFS modules. */
  baseUrl: string;
  /** Explicit canonical storage URL; never inferred from the WebID. */
  podRoot: string;
  write?: boolean;
  discover: AgentDirectoryRequest;
  authenticate: () => Promise<{ webId: string; request: AgentDirectoryRequest }>;
}

export interface LiveDirectoryReport {
  status: 'pass' | 'fail';
  phase: 'preflight' | 'pod-http-contract';
  target: { baseUrl: string; podRoot: string; webId?: string };
  checks: { name: string; status: 'pass' | 'fail'; code?: string }[];
  cleanup: { status: 'not-needed' | 'pass' | 'retained'; retained: string[] };
  mount: 'not-run';
}

export interface AcceptanceTarget {
  baseUrl: string;
  podRoot: string;
  write: boolean;
  report?: string;
  help: boolean;
}

export class AcceptanceArgumentError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AcceptanceArgumentError';
  }
}

class CheckFailure extends Error {
  public constructor(public readonly code: string) { super(code); }
}

function insist(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CheckFailure(code);
}

function canonicalRoot(value: string): string {
  const result = normalizePodRoot(value);
  insist(result, 'invalid_target_url');
  return result;
}

function requiredCanonicalRoot(value: string, label: string): string {
  const result = normalizePodRoot(value);
  if (!result) {
    throw new AcceptanceArgumentError(
      'invalid_target_url',
      `${label} must be a canonical http(s) container URL with no query, fragment or userinfo.`,
    );
  }
  return result;
}

/**
 * Resolve the acceptance target from arguments and environment only.
 *
 * Priority is exactly explicit `--base_url` over `XPOD_BASE_URL`. `CSS_BASE_URL`
 * is the server's own canonical/actual-port configuration and is deliberately
 * not an acceptance fallback: an instance serving a local `CSS_BASE_URL` must
 * still accept a remote `XPOD_BASE_URL` target.
 */
export function resolveAcceptanceTarget(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): AcceptanceTarget {
  const removed = argv.find((arg) => arg === '--gateway' || arg.startsWith('--gateway='));
  if (removed) {
    throw new AcceptanceArgumentError(
      'removed_argument_gateway',
      '`--gateway` has been removed; pass `--base_url <Xpod root URL>` instead.',
    );
  }
  const values = (() => {
    try {
      return parseArgs({ args: [ ...argv ], options: {
        base_url: { type: 'string' }, 'pod-root': { type: 'string' },
        write: { type: 'boolean', default: false }, report: { type: 'string' }, help: { type: 'boolean', default: false },
      } }).values;
    } catch (error) {
      throw new AcceptanceArgumentError(
        'invalid_arguments',
        error instanceof Error ? error.message : 'Invalid acceptance arguments.',
      );
    }
  })();
  if (values.help) {
    return { baseUrl: '', podRoot: '', write: false, report: values.report, help: true };
  }
  const baseUrl = requiredCanonicalRoot(values.base_url ?? env.XPOD_BASE_URL ?? '', 'base URL');
  const podRoot = requiredCanonicalRoot(values['pod-root'] ?? '', 'Pod root');
  return { baseUrl, podRoot, write: values.write ?? false, report: values.report, help: false };
}

/**
 * Bind the stored CLI login to the explicit target before authenticated Pod requests.
 *
 * The stored login is read first and compared against the canonical target.
 * The target must never be forced into the auth context to bypass this check.
 */
export function assertStoredLoginTarget(storedBaseUrl: string, targetBaseUrl: string): void {
  const stored = normalizePodRoot(storedBaseUrl);
  insist(stored !== undefined && stored === targetBaseUrl, 'stored_login_base_url_mismatch');
}

function strongVersion(response: Response): string {
  const version = response.headers.get('etag');
  insist(version && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(version), 'missing_strong_etag');
  return version;
}

function ok(response: Response): void {
  insist(response.ok, `http_${response.status}`);
}

/** Real transport is supplied by main; injected unit transports do not count as live evidence. */
export async function acceptLiveDirectory(options: LiveDirectoryOptions): Promise<LiveDirectoryReport> {
  const baseUrl = canonicalRoot(options.baseUrl);
  const podRoot = canonicalRoot(options.podRoot);
  const report: LiveDirectoryReport = {
    status: 'fail', phase: options.write ? 'pod-http-contract' : 'preflight',
    target: { baseUrl, podRoot }, checks: [],
    cleanup: { status: 'not-needed', retained: [] }, mount: 'not-run',
  };
  // Only a successful create receipt establishes ownership. Unknown outcomes remain for inspection.
  const attempted = new Set<string>();
  const owned = new Map<string, string>();
  let request: AgentDirectoryRequest | undefined;
  let client: AgentDirectoryClient | undefined;
  let directory: string | undefined;
  let directoryCreated = false;
  let failed = false;
  const check = async (name: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      report.checks.push({ name, status: 'pass' });
    } catch (error) {
      failed = true;
      report.checks.push({ name, status: 'fail', code: error instanceof CheckFailure ? error.code : 'request_failed' });
      throw error;
    }
  };
  try {
    await check('oidc-discovery', async () => {
      const response = await options.discover(new URL('.well-known/openid-configuration', baseUrl).href, { method: 'GET' });
      ok(response);
      const config = await response.json() as { issuer?: unknown; token_endpoint?: unknown };
      insist(typeof config.issuer === 'string' && typeof config.token_endpoint === 'string', 'invalid_discovery');
      canonicalRoot(config.issuer);
      canonicalRoot(config.token_endpoint);
    });
    await check('cli-authentication', async () => {
      const auth = await options.authenticate();
      insist(typeof auth.webId === 'string' && auth.webId.length > 0, 'missing_webid');
      report.target.webId = auth.webId;
      request = auth.request;
      client = new AgentDirectoryClient({ baseUrl, request });
    });
    await check('pod-read-access', async () => { ok(await request!(podRoot, { method: 'HEAD' })); });
    await check('directory-api', async () => {
      const listing = await client!.list({ root: podRoot, limit: 1 });
      insist(listing.root === podRoot && Array.isArray(listing.entries) && listing.complete === true, 'invalid_directory_response');
      insist(listing.entries.every((entry) => canonicalRoot(entry.url).startsWith(podRoot)), 'out_of_scope_entry');
    });
    if (options.write) {
      directory = new URL(`xpod-cli-acceptance-${randomUUID()}/`, podRoot).href;
      const file = new URL('sample.txt', directory).href;
      const original = `XPOD_DIRECTORY_ORIGINAL_${randomUUID()}\n`;
      const external = `XPOD_DIRECTORY_EXTERNAL_${randomUUID()}\n`;
      const mutate = async (url: string, init: RequestInit): Promise<Response> => {
        const previous = owned.get(url);
        owned.delete(url);
        const response = await request!(url, init);
        // A definitive conflict leaves the earlier receipt intact; unknown outcomes do not.
        if (previous && (response.status === 409 || response.status === 412)) owned.set(url, previous);
        return response;
      };
      const put = async (url: string, body: string, condition: Record<string, string>, container = false): Promise<Response> =>
        mutate(url, {
          method: 'PUT', headers: {
            'Content-Type': container ? 'text/turtle' : 'text/plain', ...condition,
            ...(container ? { Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' } : {}),
          }, body,
        });
      await check('isolated-container-create', async () => {
        attempted.add(directory!);
        ok(await put(directory!, '', { 'If-None-Match': '*' }, true));
        directoryCreated = true;
      });
      await check('conditional-file-create', async () => {
        attempted.add(file);
        const response = await put(file, original, { 'If-None-Match': '*' });
        ok(response);
        owned.set(file, strongVersion(response));
      });
      const firstVersion = owned.get(file)!;
      await check('create-conflict', async () => {
        const response = await put(file, 'MUST_NOT_OVERWRITE', { 'If-None-Match': '*' });
        insist(response.status === 412 || response.status === 409, 'create_not_conditional');
      });
      await check('range-read', async () => {
        const response = await request!(file, { method: 'GET', headers: { Range: 'bytes=5-15', 'If-Match': firstVersion } });
        insist(response.status === 206, `range_http_${response.status}`);
        insist(response.headers.get('content-range') === `bytes 5-15/${Buffer.byteLength(original)}`, 'incorrect_content_range');
        insist(strongVersion(response) === firstVersion && await response.text() === original.slice(5, 16), 'incorrect_range_body_or_version');
      });
      await check('directory-list-and-search', async () => {
        const listing = await client!.listAll({ root: directory! });
        insist(listing.root === directory && listing.complete && listing.entries.length === 1, 'incomplete_isolated_listing');
        const entry = listing.entries[0];
        insist(entry.path === 'sample.txt' && entry.url === file && entry.type === 'file', 'incorrect_isolated_entry');
        const search = await client!.searchAll({ root: directory!, query: original.trim() });
        insist(search.root === directory && search.complete && !search.hasUnscannedScope && search.matches.length === 1, 'incomplete_literal_search');
        const match = search.matches[0];
        insist(match.url === file && match.path === 'sample.txt' && match.line === 1 && match.text === original.trim(), 'incorrect_literal_match');
      });
      await check('external-update', async () => {
        const response = await put(file, external, { 'If-Match': firstVersion });
        ok(response);
        const version = strongVersion(response);
        insist(version !== firstVersion, 'unchanged_version_after_write');
        owned.set(file, version);
      });
      await check('stale-write-and-delete-conflict', async () => {
        const write = await put(file, 'MUST_NOT_OVERWRITE', { 'If-Match': firstVersion });
        insist(write.status === 412, 'stale_write_not_rejected');
        const deletion = await mutate(file, { method: 'DELETE', headers: { 'If-Match': firstVersion } });
        insist(deletion.status === 412, 'stale_delete_not_rejected');
        const read = await request!(file, { method: 'GET', headers: { 'If-Match': owned.get(file)! } });
        ok(read);
        insist(strongVersion(read) === owned.get(file) && await read.text() === external, 'external_update_not_preserved');
      });
    }
  } catch {
    // Fixed check codes only: never serialize server bodies, tokens or exception messages.
    failed = true;
  } finally {
    if (request && directory) {
      const deleteConfirmed = async (url: string, version: string): Promise<boolean> => {
        const response = await request!(url, { method: 'DELETE', headers: { 'If-Match': version } });
        return (response.ok || response.status === 404) && (await request!(url, { method: 'HEAD' })).status === 404;
      };
      for (const [ url, version ] of owned) {
        try {
          if (await deleteConfirmed(url, version)) attempted.delete(url);
        } catch { /* No blind retry or unconditional deletion after an unknown result. */ }
      }
      if (directoryCreated && attempted.size === 1 && attempted.has(directory)) {
        try {
          // Bind the empty-directory observation to its earlier version, never a later HEAD.
          const head = await request(directory, { method: 'HEAD' });
          ok(head);
          const version = strongVersion(head);
          const listing = await client!.listAll({ root: directory });
          if (listing.root === directory && listing.complete && listing.entries.length === 0) {
            if (await deleteConfirmed(directory, version)) attempted.delete(directory);
          }
        } catch { /* Preserve a directory whose empty view or version cannot be confirmed. */ }
      }
      report.cleanup = { status: attempted.size ? 'retained' : 'pass', retained: [...attempted] };
      failed = failed || attempted.size > 0;
    }
  }
  report.status = failed ? 'fail' : 'pass';
  return report;
}

async function main(): Promise<void> {
  let target: AcceptanceTarget;
  try {
    target = resolveAcceptanceTarget(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof AcceptanceArgumentError ? error.message
      : 'Live directory acceptance failed before reporting: check arguments and local CLI login.');
    process.exitCode = 1;
    return;
  }
  if (target.help) {
    console.log('bun scripts/accept-live-agent-directory.ts --base_url <Xpod root URL> --pod-root <canonical Pod URL> [--write] [--report <path>]\nDefaults to read-only preflight. --write tests Pod HTTP in a random isolated directory. Does not mount or create accounts. Uses the existing CLI login.');
    return;
  }
  const report = await acceptLiveDirectory({
    baseUrl: target.baseUrl, podRoot: target.podRoot, write: target.write,
    discover: (url, init) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) }),
    authenticate: async () => {
      const { authFetch, requireAuthContext } = await import('../src/cli/lib/auth-context');
      // Read the stored login first: the target never overrides the auth context.
      const auth = await requireAuthContext();
      assertStoredLoginTarget(auth.baseUrl, target.baseUrl);
      return { webId: auth.webId, request: (url, init) => authFetch(auth, url, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      }) };
    },
  });
  const destination = path.resolve(target.report ?? `.test-data/agent-directory-workers/live-directory/${Date.now()}-${randomUUID()}.json`);
  const checkerPath = fileURLToPath(import.meta.url);
  const checker: { sha256: string; sourceSHA: string | null; dirty: boolean | null } = {
    sha256: createHash('sha256').update(readFileSync(checkerPath)).digest('hex'), sourceSHA: null, dirty: null,
  };
  try {
    const cwd = path.dirname(path.dirname(checkerPath));
    checker.sourceSHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    checker.dirty = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).length > 0;
  } catch { /* A source archive without Git records unknown identity, never a clean-source claim. */ }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify({ ...report, checker, recordedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, phase: report.phase, checks: report.checks, report: destination, mount: report.mount }));
  process.exitCode = report.status === 'pass' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Live directory acceptance failed before reporting: check arguments and local CLI login.');
    process.exitCode = 1;
  });
}
