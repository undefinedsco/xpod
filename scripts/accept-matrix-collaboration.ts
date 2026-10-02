/** Real Gateway acceptance with deterministic runtimes. Run with Bun; no model calls. */
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

class AcceptanceError extends Error {}

export type RequestState = 'inflight' | 'headers' | 'body' | 'done' | 'error' | 'cancelled';

/** Sanitized, monotonic per-request timing. Never carries token/query/body/raw response. */
export interface RequestTiming {
  id: number;
  step: string;
  method: string;
  path: string;
  state: RequestState;
  startMs: number;
  elapsedMs: number;
  status: number | null;
  headersStartMs?: number;
  headersEndMs?: number;
  headersMs?: number;
  bodyStartMs?: number;
  bodyEndMs?: number;
  bodyMs?: number;
  error?: string;
}

export interface StepTiming { step: string; ms: number; requests: number; }
export type InflightTiming = Pick<RequestTiming, 'id' | 'step' | 'method' | 'path' | 'state' | 'startMs' | 'elapsedMs'>;

export interface DiagnosticsSnapshot {
  status: string;
  nowMs: number;
  elapsedMs: number;
  steps: StepTiming[];
  requests: RequestTiming[];
  inflight: InflightTiming[];
  note?: string;
}

/**
 * Request/phase timing on a monotonic clock. `now` defaults to `performance.now()` so elapsed and
 * deadline evidence never depends on wall time. Header receipt and `response.json()` body reading
 * are recorded as separate phases; pending, errored and cancelled requests all stay in `snapshot()`.
 */
export class RequestTracker {
  private readonly now: () => number;
  private readonly records: RequestTiming[] = [];
  private readonly steps: StepTiming[] = [];
  private readonly stepRequestCount = new Map<string, number>();
  private readonly startedAtMs: number;
  private step = 'startup';
  private stepStartedAtMs: number;
  private nextId = 1;

  public constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.startedAtMs = now();
    this.stepStartedAtMs = this.startedAtMs;
  }

  public beginStep(step: string): void {
    const at = this.now();
    if (this.step !== 'startup') {
      this.steps.push({ step: this.step, ms: at - this.stepStartedAtMs, requests: this.stepRequestCount.get(this.step) ?? 0 });
    }
    this.step = step;
    this.stepStartedAtMs = at;
    this.stepRequestCount.set(step, 0);
  }

  public start(method: string, path: string): number {
    const id = this.nextId++;
    // The single recording entry strips the query string, so no caller can leak it into evidence.
    const sanitizedPath = path.split('?')[0];
    this.records.push({ id, step: this.step, method, path: sanitizedPath, state: 'inflight', startMs: this.now(), elapsedMs: 0, status: null });
    this.stepRequestCount.set(this.step, (this.stepRequestCount.get(this.step) ?? 0) + 1);
    return id;
  }

  public headersReceived(id: number, status: number): void {
    const record = this.find(id);
    if (!record) return;
    const at = this.now();
    record.status = status;
    record.headersStartMs = record.startMs;
    record.headersEndMs = at;
    record.headersMs = at - record.startMs;
    record.state = 'headers';
    record.elapsedMs = at - record.startMs;
  }

  public bodyStarted(id: number): void {
    const record = this.find(id);
    if (!record) return;
    record.bodyStartMs = this.now();
    record.state = 'body';
    record.elapsedMs = record.bodyStartMs - record.startMs;
  }

  public bodyFinished(id: number): void {
    const record = this.find(id);
    if (!record) return;
    const at = this.now();
    record.bodyEndMs = at;
    record.bodyMs = record.bodyStartMs === undefined ? undefined : at - record.bodyStartMs;
    record.state = 'done';
    record.elapsedMs = at - record.startMs;
  }

  public finished(id: number, state: 'error' | 'cancelled', error: string): void {
    const record = this.find(id);
    if (!record) return;
    const at = this.now();
    record.state = state;
    record.error = error;
    // A body read that was cancelled or failed still gets its body-phase duration.
    if (record.bodyStartMs !== undefined && record.bodyEndMs === undefined) {
      record.bodyEndMs = at;
      record.bodyMs = at - record.bodyStartMs;
    }
    record.elapsedMs = at - record.startMs;
  }

  public inflight(): InflightTiming[] {
    const at = this.now();
    return this.records
      .filter((record) => record.state === 'inflight' || record.state === 'headers' || record.state === 'body')
      .map((record) => ({ id: record.id, step: record.step, method: record.method, path: record.path,
        state: record.state, startMs: record.startMs, elapsedMs: at - record.startMs }));
  }

  public snapshot(status: string, note?: string): DiagnosticsSnapshot {
    const at = this.now();
    return {
      status, nowMs: at, elapsedMs: at - this.startedAtMs,
      steps: [ ...this.steps, { step: this.step, ms: at - this.stepStartedAtMs, requests: this.stepRequestCount.get(this.step) ?? 0 } ],
      requests: this.records.map((record) => ({
        ...record,
        elapsedMs: record.state === 'done' || record.state === 'error' || record.state === 'cancelled'
          ? record.elapsedMs : at - record.startMs,
      })),
      inflight: this.inflight(),
      ...(note ? { note } : {}),
    };
  }

  private find(id: number): RequestTiming | undefined {
    return this.records.find((record) => record.id === id);
  }
}

// Sanitized trace hook: written next to --output so a SIGTERM timeout (the
// harness kills the child at 900s) still leaves where each phase spent time.
let persistDiagnostics: ((status: string, note?: string) => void) | undefined;

const help = `Usage: bun scripts/accept-matrix-collaboration.ts --url <gateway> [--webid <caller-WebID>] [--pod <registered-Pod>] [--token-env XPOD_MATRIX_TOKEN] [--output .test-data/matrix-collaboration/result.json]

Requires a running Gateway and its existing Solid/API credential in the named environment variable.
Creates a persistent acceptance room, Agent grants, messages and execution records in the selected Pod.
Runs two deterministic scripted runtimes; does not call an LLM or prove model/tool quality.
When --pod is omitted, whoami must advertise co.undefineds.pod_url for the sole owned Pod.
Output never includes credentials, job lease fencing tokens, or HTTP response dumps.`;

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
    help: { type: 'boolean' }, url: { type: 'string' }, webid: { type: 'string' },
    pod: { type: 'string' }, 'token-env': { type: 'string', default: 'XPOD_MATRIX_TOKEN' },
    output: { type: 'string' },
  } });
  if (values.help) { console.log(help); return; }
  if (!values.url) throw new AcceptanceError('--url is required; use --help');
  const base = new URL(values.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new AcceptanceError('--url must be an HTTP(S) URL without credentials, query or fragment');
  }
  const token = process.env[values['token-env']!];
  if (!token || /[\r\n]/u.test(token)) throw new AcceptanceError('The selected credential environment variable is missing or invalid');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    ...(values.pod ? { 'X-Xpod-Pod-Url': values.pod } : {}),
  };
  const output = values.output ? await outputPath(values.output) : undefined;

  const tracker = new RequestTracker();
  const beginStep = (name: string): void => tracker.beginStep(name);
  persistDiagnostics = (status: string, note?: string): void => {
    if (!output) return;
    try {
      writeFileSync(`${output}.diagnostics.json`, `${JSON.stringify(tracker.snapshot(status, note), null, 2)}\n`);
    } catch { /* diagnostics are best-effort and must never mask the acceptance outcome */ }
  };
  // SIGTERM/SIGINT snapshots retain every in-flight method/path/start/elapsed, so a killed run still
  // shows what was pending when it stopped. Never writes token, query, body or raw response.
  process.once('SIGTERM', () => { persistDiagnostics?.('killed', 'SIGTERM'); process.exit(143); });
  process.once('SIGINT', () => { persistDiagnostics?.('killed', 'SIGINT'); process.exit(130); });

  async function api(path: string, method = 'GET', body?: unknown, status = 200): Promise<any> {
    const requestPath = path.split('?')[0];
    const id = tracker.start(method, requestPath);
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // Generous, but still bounded: the fixture shares a machine with the rest
        // of the integration suite, and a busy host used to trip a tight per-request
        // budget (120s) while the exact same run passed on its own.
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      const kind = error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
      // A timeout/abort never completed; keep it as a cancelled request, other failures as errors.
      tracker.finished(id, kind === 'TimeoutError' || kind === 'AbortError' ? 'cancelled' : 'error', kind);
      persistDiagnostics?.('request-error', `${method} ${requestPath}`);
      throw new AcceptanceError(`${method} ${requestPath} failed (${kind}; request budget 300s)`);
    }
    // Fetch resolution is header receipt; `response.json()` below is timed as a separate body phase.
    tracker.headersReceived(id, response.status);
    if (response.status !== status) {
      tracker.finished(id, 'error', `expected ${status}`);
      persistDiagnostics?.('unexpected-status', `${method} ${requestPath} -> ${response.status}`);
      throw new AcceptanceError(`${method} ${requestPath} returned ${response.status}; expected ${status}`);
    }
    tracker.bodyStarted(id);
    try {
      const parsed = await response.json();
      tracker.bodyFinished(id);
      persistDiagnostics?.('running');
      return parsed;
    } catch (error) {
      const kind = error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
      tracker.finished(id, 'error', kind);
      persistDiagnostics?.('body-error', `${method} ${requestPath}`);
      throw new AcceptanceError('Gateway returned a non-JSON response');
    }
  }
  const assert = (condition: unknown, label: string): void => { if (!condition) throw new AcceptanceError(`Acceptance failed: ${label}`); };
  beginStep('identity');
  const account = await api('/_matrix/client/v3/account/whoami');
  assert(typeof account.user_id === 'string', 'whoami user_id');
  const webId = account['co.undefineds.webid'] ?? values.webid;
  assert(typeof webId === 'string' && webId.length > 0, 'provide --webid or expose co.undefineds.webid from whoami');
  assert(!values.webid || values.webid === webId, 'explicit WebID matches authenticated identity');
  const podRoot = account['co.undefineds.pod_url'] ?? values.pod;
  assert(typeof podRoot === 'string', 'provide --pod or expose co.undefineds.pod_url from whoami');
  const pod = new URL(podRoot.endsWith('/') ? podRoot : `${podRoot}/`).toString();
  headers['X-Xpod-Pod-Url'] = pod;
  const tag = crypto.randomUUID();
  const agents = ['author', 'reviewer'].map(name => new URL(`.data/agents/matrix-accept-${tag}-${name}.ttl#this`, pod).toString());
  beginStep('create-room');
  const room = await api('/_matrix/client/v3/createRoom', 'POST', { name: `Matrix collaboration acceptance ${tag}`, visibility: 'private' });
  assert(typeof room.room_id === 'string', 'created room ID');
  const roomId: string = room.room_id;
  const roomPath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  beginStep('agent-grants');
  await api(`${roomPath}/state/co.undefineds.agents`, 'PUT', { agents: agents.map((agent, index) => ({
    agent, executor: webId, workspace: pod, allowedActors: [webId], handoffTo: index === 0 ? [agents[1]] : [],
  })) });

  const savedGrants = await api(`${roomPath}/state/co.undefineds.agents`);
  assert(Array.isArray(savedGrants.agents) && savedGrants.agents.length === 2 && savedGrants.agents[0].agent === agents[0], 'agent grants survive Pod persistence');

  beginStep('baseline-sync');
  const initialSync = await api('/_matrix/client/v3/sync?limit=7');
  assert(typeof initialSync.next_batch === 'string', 'baseline sync returns cursor');
  const startingCursor: string = initialSync.next_batch;
  const prompt = `Review deterministic collaboration sample ${tag}`;
  const sendPath = `${roomPath}/send/m.room.message/${encodeURIComponent(`accept-${tag}`)}`;
  const sendBody = { msgtype: 'm.text', body: prompt, mentions: [agents[0]] };
  beginStep('message-idempotency');
  const original = await api(sendPath, 'PUT', sendBody);
  const duplicate = await api(sendPath, 'PUT', sendBody);
  assert(original.event_id === duplicate.event_id, 'transaction retry preserves event ID');

  const resultBodies = [`Scripted author result ${tag}`, `Scripted reviewer accepted ${tag}`];
  const results: Array<{ eventId: string; run: string }> = [];
  beginStep('agent-runs');
  for (let index = 0; index < agents.length; index++) {
    const request = { roomId, agent: agents[index], runtimeId: `accept-${tag}-${index}`, leaseMs:180_000 };
    const claimed = await api('/v1/agent-wakes/claim', 'POST', request);
    assert(claimed.job?.id && claimed.job?.fencingToken, `agent ${index + 1} has a fenced lease`);
    assert(typeof claimed.input?.content === 'string' && claimed.input.content.includes(index === 0 ? prompt : resultBodies[0]), 'runtime receives predecessor input');
    const lease = { ...request, id: claimed.job.id, fencingToken: claimed.job.fencingToken };
    await api('/v1/agent-wakes/renew', 'POST', lease);
    const completion = { ...lease, body: resultBodies[index], evidence: [index === 0 ? original.event_id : results[0].eventId],
      ...(index === 0 ? { handoffTo: agents[1] } : {}),
    };
    const result = await api('/v1/agent-wakes/complete', 'POST', completion);
    assert(typeof result.eventId === 'string' && typeof result.run === 'string', 'completion returns event and run identities');
    results.push(result);
    await api('/v1/agent-wakes/complete', 'POST', completion, 409);
  }

  // Remove grants so backlog verification creates no unrelated pending agent work.
  beginStep('clear-grants');
  await api(`${roomPath}/state/co.undefineds.agents`, 'PUT', { agents: [] });
  const expected = new Map<string, string>([[original.event_id, prompt], ...results.map((result, index) => [result.eventId, resultBodies[index]] as [string, string])]);
  // Four concurrent senders exercise same-document append while keeping load bounded.
  beginStep('backlog-63');
  for (let batch = 0; batch < 60; batch += 4) {
    await Promise.all(Array.from({length:4}, async (_, offset) => {
      const index = batch + offset;
      const body = `Backlog ${tag} ${index}`;
      const event = await api(`${roomPath}/send/m.room.message/${encodeURIComponent(`backlog-${tag}-${index}`)}`, 'PUT', {msgtype:'m.text',body});
      expected.set(event.event_id,body);
    }));
  }
  beginStep('pagination-sync');
  let since: string | undefined = startingCursor;
  const seen = new Set<string>();
  let pages = 0;
  for (; pages < 200 && seen.size < expected.size; pages++) {
    const params = new URLSearchParams({ limit: '7' });
    if (since) params.set('since', since);
    const sync = await api(`/_matrix/client/v3/sync?${params}`);
    assert(typeof sync.next_batch === 'string', 'sync returns cursor');
    const events = sync.rooms?.join?.[roomId]?.timeline?.events ?? [];
    for (const event of events) {
      if (expected.has(event.event_id)) {
        assert(event.content?.body === expected.get(event.event_id), 'event body survives projection');
        seen.add(event.event_id);
      }
    }
    if (since === sync.next_batch && seen.size < expected.size) throw new AcceptanceError('Sync cursor stalled before all acceptance events were returned');
    since = sync.next_batch;
  }
  assert(seen.size === expected.size, 'all 63 events survive sync with limit 7');
  const report = {
    status: 'passed', mode: 'deterministic-runtime', gateway: base.origin, pod, roomId,
    agents, originalEventId: original.event_id, results, expectedEvents: expected.size, observedEvents: seen.size, syncPages: pages,
    checks: ['transaction-idempotency', 'claim-renew-complete', 'explicit-handoff', 'stale-completion-409', 'sync-body-projection', 'backlog-no-loss'],
    evidenceScope: 'Real Gateway and Pod HTTP persistence; scripted output, no LLM, no external tool execution, one authenticated executor.',
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  persistDiagnostics?.('passed');
  if (output) await writeFile(output, json);
  console.log(json);
}

async function outputPath(path: string): Promise<string> {
  const root = resolve('.test-data');
  const target = resolve(path);
  const inside = (base: string, candidate: string): boolean => { const tail = relative(base, candidate); return Boolean(tail) && tail !== '..' && !tail.startsWith('../') && !isAbsolute(tail); };
  if (!inside(root, target)) throw new AcceptanceError('--output must be a file under .test-data/');
  await mkdir(dirname(target), { recursive: true });
  const realRoot = await realpath(root);
  const realParent = await realpath(dirname(target));
  if (realParent !== realRoot && !inside(realRoot, realParent)) throw new AcceptanceError('--output must not escape .test-data/ via a symlink');
  const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing?.isSymbolicLink()) throw new AcceptanceError('--output must not be a symbolic link');
  return target;
}

// Importable for tests: only run the acceptance when executed directly under Bun.
if (import.meta.main) {
  main().catch(error => {
    // Do not dump caught fetch errors, headers, server responses or credential-bearing URLs.
    const message = error instanceof AcceptanceError ? error.message : 'unexpected-error';
    persistDiagnostics?.('failed', message);
    console.error(error instanceof AcceptanceError ? error.message : 'Matrix collaboration acceptance failed. Check Gateway logs and command arguments; no credentials or response bodies were printed.');
    process.exitCode = 1;
  });
}
