import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { MembershipPolicyObserver, isMembershipAcpObservation,
  type MembershipPolicyObservation, type MembershipRoomObservation } from '../../../src/api/matrix/membershipPolicyObservation';
import { membershipPolicyFixture, fixtureNegotiationMedia } from '../../helpers/MembershipPolicyFixture';

type Fixture = Parameters<Parameters<typeof membershipPolicyFixture>[0]>[0];
const asWac = (observation: MembershipRoomObservation): MembershipPolicyObservation => {
  if (isMembershipAcpObservation(observation)) throw new Error('Unexpected ACP observation in a WAC fixture');
  return observation;
};

const observer = (f: Fixture, limits?: ConstructorParameters<typeof MembershipPolicyObserver>[0]['limits']) =>
  new MembershipPolicyObserver({ ...f.observationOptions, limits });

/** Bounded real-HTTP diagnosis of the stalled-headers physical request contract.
 * No fake timers; every measurement is wall-clock around a real loopback socket. */
describe('own real-HTTP stalled headers physical contract', () => {
  it('runtime probe: aborting a fetch before headers retires the server socket', async() => {
    const events: Array<[string, number]> = [];
    const t0 = performance.now();
    const at = (): number => Math.round((performance.now() - t0) * 100) / 100;
    let received = false;
    let abortAt: number | undefined;
    let closedAt: number | undefined;
    const server = createServer((request) => {
      received = true;
      events.push([ 'server-request', at() ]);
      request.socket.once('close', () => { closedAt = at(); events.push([ 'socket-close', closedAt ]); });
      request.on('aborted', () => events.push([ 'request-aborted', at() ]));
      request.on('close', () => events.push([ 'request-close', at() ]));
      // Never write headers and never end the response: intentional headers stall.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Runtime probe port unavailable');
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/stall`, { signal: controller.signal })
      .catch((error: Error) => { events.push([ `fetch-reject:${error.name}`, at() ]); return undefined; });
    setTimeout(() => { abortAt = at(); events.push([ 'client-abort', abortAt ]); controller.abort(new Error('request-deadline')); }, 120);
    await pending;
    await new Promise(resolve => setTimeout(resolve, 300));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // eslint-disable-next-line no-console
    console.log('RUNTIME_STALL_TRACE', JSON.stringify({ received, abortAt, closedAt,
      closeFromAbort: closedAt !== undefined && abortAt !== undefined ? Math.round((closedAt - abortAt) * 100) / 100 : undefined, events }));
    // Same physical-shutdown bound as the root case; keep cleanup before the asserts.
    expect(received).toBe(true);
    expect(abortAt).toBeDefined();
    expect(closedAt).toBeDefined();
    expect(closedAt!).toBeLessThan(200);
    expect(closedAt! - abortAt!).toBeLessThan(200);
  });

  it('product probe: the stalled policy GET is reached and the socket closes while the lease is rechecked', async() => {
    await membershipPolicyFixture(async f => {
      f.set('GET', f.roomPolicy, { status: 200, stall: 'headers' });
      const lease = vi.spyOn(f.credentials, 'lease');
      const hasPolicyGet = (): boolean => f.requests.some(r => r.method === 'GET' && r.url === f.roomPolicy);
      const start = performance.now();
      const at = (): number => Math.round((performance.now() - start) * 100) / 100;
      // Independent wall-clock watcher samples real request entry and real socket close without
      // editing the root-owned fixture. 2ms sampling bounds each timestamp to +2ms.
      let requestAt: number | undefined;
      let closeAt: number | undefined;
      let watching = true;
      const sample = (): void => {
        if (requestAt === undefined && hasPolicyGet()) requestAt = at();
        if (closeAt === undefined && f.closedStalls.includes(f.roomPolicy)) closeAt = at();
      };
      const watcher = (async() => {
        while (watching) { sample(); await new Promise(resolve => setTimeout(resolve, 2)); }
        sample();
      })();
      const result = asWac(await observer(f, { requestTimeoutMs: 120, totalTimeoutMs: 2000 }).observe(f.roomId, f.actorContext, 'join'));
      const elapsed = at();
      const requestsAtStop = f.requests.length;
      await new Promise(resolve => setTimeout(resolve, 250));
      watching = false;
      await watcher;
      const requestsSettled = f.requests.length;
      // eslint-disable-next-line no-console
      console.log('PRODUCT_STALL_TRACE', JSON.stringify({ reached: requestAt !== undefined, requestAt,
        closeAt, closedFromRequest: closeAt !== undefined && requestAt !== undefined ? Math.round((closeAt - requestAt) * 100) / 100 : undefined,
        elapsed, leaseRechecks: lease.mock.calls.length, coverage: result.coverage,
        state: result.policies.find(p => p.iri === f.roomPolicy)?.state,
        posts: f.requests.filter(r => r.method === 'POST').length,
        policyRequests: f.requests.filter(r => r.url === f.roomPolicy).map(r => r.method),
        requestsAtStop, requestsSettled }));
      expect(requestAt).toBeDefined();
      expect(result.coverage).toBe('incomplete');
      expect(result.policies.find(p => p.iri === f.roomPolicy)?.state).toBe('unknown');
      expect(f.requests.every(r => r.method !== 'POST' || r.media === fixtureNegotiationMedia)).toBe(true);
      // Fair physical-shutdown bound: server received the stalled GET then the socket retired well
      // inside the same 200ms the root acceptance allows after the observation returns.
      expect(closeAt).toBeDefined();
      expect(closeAt!).toBeLessThan(200);
      expect(closeAt! - requestAt!).toBeLessThan(200);
      // No further physical call (privileged or otherwise) after the observation stopped.
      expect(requestsSettled).toBe(requestsAtStop);
    });
  });

  it('contention probe: a slow preceding reply past requestTimeoutMs makes the later stall unreachable', async() => {
    await membershipPolicyFixture(async f => {
      f.replies.get(`HEAD ${f.room}`)!.before = async() => { await new Promise(resolve => setTimeout(resolve, 250)); };
      f.set('GET', f.roomPolicy, { status: 200, stall: 'headers' });
      const start = performance.now();
      const result = asWac(await observer(f, { requestTimeoutMs: 120, totalTimeoutMs: 2000 }).observe(f.roomId, f.actorContext, 'join'));
      const elapsed = Math.round(performance.now() - start);
      const reached = f.requests.some(r => r.method === 'GET' && r.url === f.roomPolicy);
      // eslint-disable-next-line no-console
      console.log('CONTENTION_STALL_TRACE', JSON.stringify({ reached, elapsed, coverage: result.coverage,
        closed: f.closedStalls.includes(f.roomPolicy), posts: f.requests.filter(r => r.method === 'POST').length,
        requestOrder: f.requests.map(r => `${r.method} ${r.url === f.room ? 'room' : r.url === f.roomPolicy ? 'policy' : 'other'}`) }));
      expect(result.coverage).toBe('incomplete');
      expect(reached).toBe(false);
      expect(f.closedStalls).toHaveLength(0);
      expect(f.requests.every(r => r.method !== 'POST' || r.media === fixtureNegotiationMedia)).toBe(true);
    });
  });
});
