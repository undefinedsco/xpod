import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { verifyInFlightShutdown, verifyUpgradeShutdown, verifyWebSocketLogicalDrain, verifyServerInitiatedWebSocketClose } from '../helpers/apiShutdownFixture';
const execute = promisify(execFile);
describe('API shutdown drains real work before closing storage-facing transport', () => {
  it('drains upgraded connections and observes the real close event on Node', verifyUpgradeShutdown);
  it('finishes a held write and rejects new requests on Node', () => verifyInFlightShutdown(false));
  it('waits for the write even after its client disconnects on Node', () => verifyInFlightShutdown(true));
  it('waits for logical WebSocket work after the channel closes on Node', verifyWebSocketLogicalDrain);
  for (const mode of ['replacement', 'heartbeat'] as const) {
    it(`preserves ${mode} close semantics and shutdown on Node`, () => verifyServerInitiatedWebSocketClose(mode));
  }
  for (const mode of ['upgrade', 'write', 'disconnect', 'ws-logical', 'replacement', 'heartbeat']) {
    it(`drains ${mode} on the actual Bun runtime`, async () => {
      await execute('bun', ['tests/helpers/runApiShutdownFixture.ts', mode], { timeout: 20_000 });
    }, 25_000);
  }
});
