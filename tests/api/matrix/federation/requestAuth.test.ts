import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authenticateXMatrixRequest,
  buildXMatrixAuthorization,
  keyPairSigner,
  parseXMatrixAuthorization,
  xMatrixSignedObject,
} from '../../../../src/api/matrix/federation/requestAuth';
import {
  parseServerKeyResponse,
  type MatrixServerKeySource,
} from '../../../../src/api/matrix/federation/serverKeys';
import { signJson } from '../../../../src/api/matrix/protocol/eventIntegrity';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';

const US = 'pod.example';
const THEM = 'remote.example';
const NOW = 1_700_000_000_000;

function serverName(name: string) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const identity = new MatrixServiceIdentity({ serverName: name, activeKey: { keyId: 'ed25519:1', privateKeyPem }, now: () => NOW });
  return { privateKeyPem, keys: parseServerKeyResponse(identity.serverKeyResponse(), { expectedServerName: name, now: NOW }) };
}

function keySource(keys: Record<string, ReturnType<typeof serverName>['keys']>): MatrixServerKeySource {
  return { keysFor: async name => keys[name] };
}

const request = { method: 'PUT', uri: '/_matrix/federation/v1/send/txn-1?x=1', content: { pdus: [] } };

describe('X-Matrix request authentication', () => {
  it('round-trips a signed request and exposes exactly the signed fields', () => {
    const them = serverName(THEM);
    const authorization = buildXMatrixAuthorization({ ...request, origin: THEM, destination: US }, keyPairSigner({ keyId: 'ed25519:1', privateKeyPem: them.privateKeyPem }));

    expect(authorization.startsWith('X-Matrix origin="remote.example",destination="pod.example",key="ed25519:1",sig="')).toBe(true);
    const parsed = parseXMatrixAuthorization(authorization);
    expect(parsed).toMatchObject({ origin: THEM, destination: US, keyId: 'ed25519:1' });
    expect(parsed?.signature).toBeTruthy();
    expect(Object.keys(xMatrixSignedObject({ ...request, origin: THEM, destination: US }))).toEqual([ 'method', 'uri', 'origin', 'destination', 'content' ]);
  });

  it('accepts a request that verifies against the origin key', async () => {
    const them = serverName(THEM);
    const authorization = buildXMatrixAuthorization({ ...request, origin: THEM, destination: US }, keyPairSigner({ keyId: 'ed25519:1', privateKeyPem: them.privateKeyPem }));

    await expect(authenticateXMatrixRequest({
      authorization, ...request, keys: keySource({ [THEM]: them.keys }), serverName: US,
    })).resolves.toMatchObject({ valid: true, origin: THEM });
  });

  it('refuses a request addressed to a different server', async () => {
    const them = serverName(THEM);
    const authorization = buildXMatrixAuthorization({ ...request, origin: THEM, destination: 'other.example' }, keyPairSigner({ keyId: 'ed25519:1', privateKeyPem: them.privateKeyPem }));

    const result = await authenticateXMatrixRequest({
      authorization, ...request, keys: keySource({ [THEM]: them.keys }), serverName: US,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/addressed to other\.example/u);
  });

  it('still accepts a pre-v1.3 sender that sends no destination parameter', async () => {
    const them = serverName(THEM);
    // v1.3 added `destination`; older senders signed an object without it and sent no
    // such parameter, and recipients must still accept those requests.
    const legacySignature = signJson(
      { method: request.method, uri: request.uri, origin: THEM, content: request.content },
      { keyId: 'ed25519:1', privateKeyPem: them.privateKeyPem },
    );
    const header = `X-Matrix origin="${THEM}",key="ed25519:1",sig="${legacySignature}"`;

    await expect(authenticateXMatrixRequest({
      authorization: header, ...request, keys: keySource({ [THEM]: them.keys }), serverName: US,
    })).resolves.toMatchObject({ valid: true, origin: THEM });
  });

  it('binds the method, the target including its query, and the body', async () => {
    const them = serverName(THEM);
    const authorization = buildXMatrixAuthorization({ ...request, origin: THEM, destination: US }, keyPairSigner({ keyId: 'ed25519:1', privateKeyPem: them.privateKeyPem }));
    const keys = keySource({ [THEM]: them.keys });

    await expect(authenticateXMatrixRequest({ authorization, method: 'GET', uri: request.uri, content: request.content, keys, serverName: US })).resolves.toMatchObject({ valid: false });
    await expect(authenticateXMatrixRequest({ authorization, method: request.method, uri: '/_matrix/federation/v1/send/txn-1', content: request.content, keys, serverName: US })).resolves.toMatchObject({ valid: false });
    await expect(authenticateXMatrixRequest({ authorization, method: request.method, uri: request.uri, content: { pdus: [ 'tampered' ] }, keys, serverName: US })).resolves.toMatchObject({ valid: false });
  });

  it('rejects a signature from a key the origin does not publish', async () => {
    const them = serverName(THEM);
    const other = serverName(THEM);
    const authorization = buildXMatrixAuthorization({ ...request, origin: THEM, destination: US }, keyPairSigner({ keyId: 'ed25519:1', privateKeyPem: other.privateKeyPem }));

    const result = await authenticateXMatrixRequest({
      authorization, ...request, keys: keySource({ [THEM]: them.keys }), serverName: US,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not verify/u);
  });

  it('never lets a retired key authenticate a request', async () => {
    const them = serverName(THEM);
    const authorization = buildXMatrixAuthorization({ ...request, origin: THEM, destination: US }, keyPairSigner({ keyId: 'ed25519:1', privateKeyPem: them.privateKeyPem }));
    const retired = { ...them.keys, verifyKeys: {}, oldVerifyKeys: { 'ed25519:1': { verifyKey: them.keys.verifyKeys['ed25519:1'], expiredTs: NOW + 1 } } };

    const result = await authenticateXMatrixRequest({
      authorization, ...request, keys: keySource({ [THEM]: retired }), serverName: US,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no active key/u);
  });

  it('reports an unknown origin as unverifiable rather than unsigned', async () => {
    const them = serverName(THEM);
    const authorization = buildXMatrixAuthorization({ ...request, origin: THEM, destination: US }, keyPairSigner({ keyId: 'ed25519:1', privateKeyPem: them.privateKeyPem }));

    const result = await authenticateXMatrixRequest({ authorization, ...request, keys: keySource({}), serverName: US });
    expect(result).toEqual({ valid: false, origin: THEM, reason: `no verify keys available for ${THEM}` });
  });

  it('refuses an origin that is not a server name', async () => {
    const result = await authenticateXMatrixRequest({
      authorization: 'X-Matrix origin="169.254.169.254/latest/meta-data",key="ed25519:1",sig="x"',
      ...request, keys: keySource({}), serverName: US,
    });
    expect(result).toMatchObject({ valid: false });
    expect(result.reason).toMatch(/not a server name/u);
  });

  it('parses the header per RFC 9110 regardless of case, spacing, quoting and order', () => {
    expect(parseXMatrixAuthorization('x-matrix ORIGIN="a.example", Key="ed25519:1" , sig="s"')).toMatchObject({ origin: 'a.example', keyId: 'ed25519:1', signature: 's' });
    expect(parseXMatrixAuthorization('X-Matrix\tsig=s,key=ed25519:1,origin=a.example')).toMatchObject({ origin: 'a.example', keyId: 'ed25519:1', signature: 's' });
    // `signature` is the name used by the specification's prose; implementations send `sig`.
    expect(parseXMatrixAuthorization('X-Matrix origin="a.example",key="ed25519:1",signature="s",unknown="ignored"')).toMatchObject({ origin: 'a.example', signature: 's' });
    // Quoted values unescape backslash pairs.
    expect(parseXMatrixAuthorization('X-Matrix origin="a\\"b",key="k",sig="s"')?.origin).toBe('a"b');
  });

  it('treats a missing, malformed or incomplete header as no authorization at all', () => {
    expect(parseXMatrixAuthorization(undefined)).toBeUndefined();
    expect(parseXMatrixAuthorization('Bearer abc')).toBeUndefined();
    expect(parseXMatrixAuthorization('X-Matrix origin="a.example",key="k"')).toBeUndefined();
    expect(parseXMatrixAuthorization('X-Matrix origin="unterminated,key="k",sig="s"')).toBeUndefined();
    expect(parseXMatrixAuthorization('X-Matrix origin="a.example",key="k",sig')).toBeUndefined();
  });
});
