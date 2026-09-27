import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { handleFederationSend, transactionIdFromUri } from '../../../../src/api/matrix/federation/inboundRoute';
import { InMemoryMatrixInboundTransactionStore } from '../../../../src/api/matrix/federation/inboundTransaction';
import { buildXMatrixAuthorization } from '../../../../src/api/matrix/federation/requestAuth';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../../src/api/matrix/federation/serverKeys';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';

const US = 'bob.example';
const THEM = 'alice.example';
const NOW = Date.now();

function sender() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName: THEM,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => NOW,
  });
}

function keySource(identity: MatrixServiceIdentity): MatrixServerKeySource {
  const keys = parseServerKeyResponse(identity.serverKeyResponse(), { expectedServerName: THEM, now: NOW });
  return { keysFor: async name => (name === THEM ? keys : undefined) };
}

function signedRequest(
  identity: MatrixServiceIdentity,
  pdus: readonly unknown[],
  options: { txnId?: string; destination?: string } = {},
) {
  const txnId = options.txnId ?? 'txn-1';
  const uri = `/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`;
  const content = { origin: THEM, origin_server_ts: NOW, pdus: [ ...pdus ] };
  return {
    authorization: buildXMatrixAuthorization(
      { origin: THEM, destination: options.destination ?? US, method: 'PUT', uri, content },
      identity,
    ),
    method: 'PUT',
    uri,
    body: JSON.stringify(content),
    serverName: options.destination ?? US,
  };
}

interface RawRequest {
  authorization: string | undefined;
  method: string;
  uri: string;
  body: string;
  serverName: string;
}

function handler(options: { resolveTarget?: boolean; transactions?: InMemoryMatrixInboundTransactionStore } = {}) {
  const identity = sender();
  const transactions = options.transactions ?? new InMemoryMatrixInboundTransactionStore();
  const acceptEvent = vi.fn(async (_event: Record<string, unknown>) => undefined);
  const run = async (request: RawRequest) => await handleFederationSend({
    ...request,
    keys: keySource(identity),
    resolveTarget: async () => (options.resolveTarget === false ? undefined : {
      scope: 'https://pod.example/bob/',
      acceptEvent,
      resolveAuthEvents: async () => [],
    }),
    transactions,
    now: () => NOW,
  });
  return { identity, run, acceptEvent, transactions };
}

describe('the federation send handler', () => {
  it('accepts a signed transaction from a known server and reports each PDU', async () => {
    const { identity, run, acceptEvent } = handler();
    // A PDU is only a PDU when the sender signed it, so the fixture signs like a sender would.
    const pdu = identity.signEvent({
      type: 'm.room.create', room_id: '!r:alice.example', sender: `@u_alice:${THEM}`, state_key: '', origin_server_ts: NOW,
      content: { room_version: '11' }, prev_events: [], auth_events: [],
    });
    const result = await run(signedRequest(identity, [ pdu ]));
    expect(result.status).toBe(200);
    const [ eventId ] = Object.keys(result.body.pdus as Record<string, unknown>);
    expect(result.body.pdus).toEqual({ [eventId]: {} });
    expect(acceptEvent).toHaveBeenCalledTimes(1);
    // The receiver derives the id itself (the sender does not have to send one), so the
    // event handed over is the received one and the id is the response key.
    expect(acceptEvent.mock.calls[0][0]).toMatchObject({ type: 'm.room.create', sender: `@u_alice:${THEM}` });
  });

  it('refuses a transaction signed by a key the receiver does not know', async () => {
    const { run } = handler();
    // Signed by a second identity, while the receiver only knows the first one's keys.
    await expect(run(signedRequest(sender(), []))).resolves.toMatchObject({ status: 401 });
  });

  it('refuses a destination this deployment does not serve', async () => {
    const { identity, run } = handler({ resolveTarget: false });
    const result = await run(signedRequest(identity, [], { destination: 'nobody.example' }));
    expect(result).toMatchObject({ status: 403, body: { errcode: 'M_FORBIDDEN' } });
  });

  it('refuses a body that is not a JSON object, and one that is not signed at all', async () => {
    const { run, identity } = handler();
    await expect(run({ ...signedRequest(identity, []), body: 'not json' })).resolves.toMatchObject({ status: 400, body: { errcode: 'M_NOT_JSON' } });
    await expect(run({ ...signedRequest(identity, []), body: '[]' })).resolves.toMatchObject({ status: 400 });
    await expect(run({ ...signedRequest(identity, []), authorization: undefined })).resolves.toMatchObject({ status: 401, body: { errcode: 'M_UNAUTHORIZED' } });
  });

  it('refuses a transaction that carries too many PDUs', async () => {
    const { run, identity } = handler();
    const pdus = Array.from({ length: 51 }, () => ({}));
    await expect(run(signedRequest(identity, pdus))).resolves.toMatchObject({ status: 400, body: { errcode: 'M_TOO_LARGE' } });
  });

  it('refuses a transaction whose body claims a different origin', async () => {
    const { run, identity } = handler();
    const request = signedRequest(identity, []);
    const body = JSON.stringify({ origin: 'mallory.example', origin_server_ts: NOW, pdus: [] });
    await expect(run({ ...request, body })).resolves.toMatchObject({ status: 401 });
  });

  it('tells the sender to retry while the first attempt is still being written', async () => {
    const transactions = new InMemoryMatrixInboundTransactionStore();
    const { run, identity } = handler({ transactions });
    const request = signedRequest(identity, [], { txnId: 'pending' });
    await transactions.reserve('https://pod.example/bob/', {
      origin: THEM, transactionId: 'pending', payloadFingerprint: 'whatever', receivedAt: new Date(NOW).toISOString(),
    });
    await expect(run(request)).resolves.toMatchObject({ status: 503, body: { errcode: 'M_UNKNOWN' } });
  });

  it('reads the transaction id from the path, encoded or not', () => {
    expect(transactionIdFromUri('/_matrix/federation/v1/send/abc')).toBe('abc');
    expect(transactionIdFromUri('/_matrix/federation/v1/send/a%2Fb%20c?x=1')).toBe('a/b c');
    expect(transactionIdFromUri('/_matrix/federation/v1/send/')).toBeUndefined();
    expect(transactionIdFromUri('/_matrix/federation/v1/version')).toBeUndefined();
  });
});
