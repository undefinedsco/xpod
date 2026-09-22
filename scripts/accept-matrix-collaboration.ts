/** Real Gateway acceptance with deterministic runtimes. Run with Bun; no model calls. */
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

class AcceptanceError extends Error {}

/** Diagnostics for slow or contended Pod runs; no credential or body content. */
const phaseMs: Record<string, number> = {};
let backlogRetries = 0;

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

  async function api(path: string, method = 'GET', body?: unknown, status = 200, budgetMs = 120_000): Promise<any> {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(budgetMs),
      });
    } catch (error) {
      const kind = error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
      throw new AcceptanceError(`${method} ${path.split('?')[0]} failed (${kind}; request budget ${Math.round(budgetMs / 1000)}s)`);
    }
    if (response.status !== status) throw new AcceptanceError(`${method} ${path.split('?')[0]} returned ${response.status}; expected ${status}`);
    try { return await response.json(); } catch { throw new AcceptanceError('Gateway returned a non-JSON response'); }
  }
  // Page-burst writes can outlast one request budget when the Pod is busy. The
  // transaction ID makes the retry safe: the same txn resolves to one event.
  async function sendWithRetry(path: string, body: unknown, attempts = 3): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await api(path, 'PUT', body, 200, 240_000);
      } catch (error) {
        if (!(error instanceof AcceptanceError) || !/request budget/u.test(error.message) || attempt >= attempts) throw error;
        backlogRetries += 1;
        console.error(`Backlog send retry ${attempt} after an unanswered request`);
      }
    }
  }
  const phaseRecord = phaseMs;
  async function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try { return await run(); } finally { phaseRecord[name] = Date.now() - started; }
  }
  const assert = (condition: unknown, label: string): void => { if (!condition) throw new AcceptanceError(`Acceptance failed: ${label}`); };
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
  const room = await api('/_matrix/client/v3/createRoom', 'POST', { name: `Matrix collaboration acceptance ${tag}`, visibility: 'private' });
  assert(typeof room.room_id === 'string', 'created room ID');
  const roomId: string = room.room_id;
  const roomPath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  await api(`${roomPath}/state/co.undefineds.agents`, 'PUT', { agents: agents.map((agent, index) => ({
    agent, executor: webId, workspace: pod, allowedActors: [webId], handoffTo: index === 0 ? [agents[1]] : [],
  })) });

  const savedGrants = await api(`${roomPath}/state/co.undefineds.agents`);
  assert(Array.isArray(savedGrants.agents) && savedGrants.agents.length === 2 && savedGrants.agents[0].agent === agents[0], 'agent grants survive Pod persistence');

  const initialSync = await phase('baseline-sync', async () => api('/_matrix/client/v3/sync?limit=7'));
  assert(typeof initialSync.next_batch === 'string', 'baseline sync returns cursor');
  const startingCursor: string = initialSync.next_batch;
  const prompt = `Review deterministic collaboration sample ${tag}`;
  const sendPath = `${roomPath}/send/m.room.message/${encodeURIComponent(`accept-${tag}`)}`;
  const sendBody = { msgtype: 'm.text', body: prompt, mentions: [agents[0]] };
  const original = await phase('transaction-idempotency', async () => {
    const first = await api(sendPath, 'PUT', sendBody);
    const duplicate = await api(sendPath, 'PUT', sendBody);
    assert(first.event_id === duplicate.event_id, 'transaction retry preserves event ID');
    return first;
  });

  const resultBodies = [`Scripted author result ${tag}`, `Scripted reviewer accepted ${tag}`];
  const results: Array<{ eventId: string; run: string }> = [];
  await phase('claim-handoff-complete', async () => {
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
  });

  // Remove grants so backlog verification creates no unrelated pending agent work.
  await api(`${roomPath}/state/co.undefineds.agents`, 'PUT', { agents: [] });
  const expected = new Map<string, string>([[original.event_id, prompt], ...results.map((result, index) => [result.eventId, resultBodies[index]] as [string, string])]);
  // Four concurrent senders exercise same-document append while keeping load bounded.
  await phase('backlog-writes', async () => {
    for (let batch = 0; batch < 60; batch += 4) {
      await Promise.all(Array.from({length:4}, async (_, offset) => {
        const index = batch + offset;
        const body = `Backlog ${tag} ${index}`;
        const event = await sendWithRetry(`${roomPath}/send/m.room.message/${encodeURIComponent(`backlog-${tag}-${index}`)}`, {msgtype:'m.text',body});
        expected.set(event.event_id,body);
      }));
    }
  });
  let since: string | undefined = startingCursor;
  const seen = new Set<string>();
  let pages = 0;
  await phase('incremental-sync', async () => {
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
  });
  assert(seen.size === expected.size, 'all 63 events survive sync with limit 7');
  const report = {
    status: 'passed', mode: 'deterministic-runtime', gateway: base.origin, pod, roomId,
    agents, originalEventId: original.event_id, results, expectedEvents: expected.size, observedEvents: seen.size, syncPages: pages,
    checks: ['transaction-idempotency', 'claim-renew-complete', 'explicit-handoff', 'stale-completion-409', 'sync-body-projection', 'backlog-no-loss'],
    evidenceScope: 'Real Gateway and Pod HTTP persistence; scripted output, no LLM, no external tool execution, one authenticated executor.',
    phaseMs, backlogRetries,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await Bun.write(output, json);
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

main().catch(error => {
  // Do not dump caught fetch errors, headers, server responses or credential-bearing URLs.
  console.error(error instanceof AcceptanceError ? error.message : 'Matrix collaboration acceptance failed. Check Gateway logs and command arguments; no credentials or response bodies were printed.');
  const observed = Object.entries(phaseMs).map(([name, ms]) => `${name}=${Math.round(ms / 1000)}s`);
  if (observed.length || backlogRetries) {
    console.error(`Matrix acceptance progress: ${[...observed, `backlogRetries=${backlogRetries}`].join(' ')}`);
  }
  process.exitCode = 1;
});
