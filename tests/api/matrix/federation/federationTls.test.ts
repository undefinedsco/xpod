import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { createNodeFederationFetch } from '../../../../src/api/matrix/federation/federationFetch';

/**
 * A certificate for `alice.example`, and nothing else.
 *
 * Delegation is the case this is about: the endpoint is reached at one address while the name the
 * connection has to prove is another. A certificate that covers the *address* would prove nothing,
 * so the fixture deliberately covers only the server name — which is what the specification asks a
 * delegated host to present.
 */
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUVdAKErR5TyDxTpVFiwCpjaep5pQwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNYWxpY2UuZXhhbXBsZTAeFw0yNjA5MjcxNTM1MzlaFw0z
NjA5MjQxNTM1MzlaMBgxFjAUBgNVBAMMDWFsaWNlLmV4YW1wbGUwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDjcKnQhjMd29JgQmL8r5BB4BMHQjHbxKuE
Wl/iX8g2QPPbc02OiX8R/5w7NedPND13NgWA3Tm2TzvyRWLDuTraJeFmI2tuT9S6
qiyKCs2LTfxD3Q98rw60dlIvCnH8yttbTVFkuKDOT9DR8/2TtBtHELaHkkkqfIpp
AeSM5OnsprOGNaRgxhIpOcALNJk0dkFwVHI3m3CfgWFqU2IaO2PSZwHdCAh3OR3O
LngBdtrBejNFwd3g4uX4Gjr2/IYDefoaxth1CmW1DsyUvA6KKkFEdYvBPoAgpXyq
CP6oJ0/yiXpDNmcfxizWYXwSfBkdTdnLI5/uC451mJcu//527IpvAgMBAAGjbTBr
MB0GA1UdDgQWBBThURIMqlrhmij8RxddxFWLnttu5DAfBgNVHSMEGDAWgBThURIM
qlrhmij8RxddxFWLnttu5DAPBgNVHRMBAf8EBTADAQH/MBgGA1UdEQQRMA+CDWFs
aWNlLmV4YW1wbGUwDQYJKoZIhvcNAQELBQADggEBAIE03laMEZho0ENGN21u2MTG
5uyv0cZ/ZdUDYfXY8MOAysg12B5ok7TuTUUbF+Vlgeu/7af0NrflpcOrtrlKI/xt
9sB3Y7loWyJDn8udLkb67KbFncyThlzC8wsKDLI9Nhtm6XpC2lt1yLE6Ac7Z7294
u2xnKbGcXK2A6Kvlbc3vCjuKAtv6buv/awaJBP6b1wKmEObmkouJ8BmFXtwUP/Un
oBmVSJ9/Iu5rfzgxKNk9v+Ml2EdTwPdx/f0YQ240blonXLESwvC1G2kEdqmuWD4S
rbidLjUVBVU4xvemFHBEGdya/xDV5+NnCAZPbIjtQCCEBEM2p7R7s8iom+MHIGs=
-----END CERTIFICATE-----`;

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDjcKnQhjMd29Jg
QmL8r5BB4BMHQjHbxKuEWl/iX8g2QPPbc02OiX8R/5w7NedPND13NgWA3Tm2Tzvy
RWLDuTraJeFmI2tuT9S6qiyKCs2LTfxD3Q98rw60dlIvCnH8yttbTVFkuKDOT9DR
8/2TtBtHELaHkkkqfIppAeSM5OnsprOGNaRgxhIpOcALNJk0dkFwVHI3m3CfgWFq
U2IaO2PSZwHdCAh3OR3OLngBdtrBejNFwd3g4uX4Gjr2/IYDefoaxth1CmW1DsyU
vA6KKkFEdYvBPoAgpXyqCP6oJ0/yiXpDNmcfxizWYXwSfBkdTdnLI5/uC451mJcu
//527IpvAgMBAAECggEAEkEcoAvlVmQqQmeRok5E+cSOQmrhrY3fZkQKphSh8RjN
ebOLagFHHZ6yX144Lnc257aCQpF+7E73tL406xiWzKN1r8jv+m6V2FWINZwgWynr
MVcwwwUZ3QoSFox0EaIGcRGHktnuriBh1jgLBivSdKW2wLLRBIPyZ/Mq8NP+omuo
CIBuPV2DK98jx1gJ7WXOqY8bgXmCnQ6hhfu305HeZfq28e/qSj3+TUgEb/wdyala
f7ytmc9vG42GrulZ1ROu82d+pECTIMW0U6F5QJNXf7zxIGq1nXHdTrqhwqXucWVx
wQgnln/KXkPzGXBjlMlhzEeA4m+5SWpGK1ZnH2iU4QKBgQD0Hn+jpm6zlKobKMde
MPcdjED1WlzJvZAkjqr0UMsJow50ttpVr23xsUqt22O6F6d8Rq4IJQVdtOc5vWRx
eOjs+HFqZ1yMnvWhjQ6y04t2KJZzCy03mkKsxrRSmG9P6dAb3fvppcYKnFQoFfT3
+lzq/VymtVmzq5oi9ORg/tU6MwKBgQDuglvtwcBGLajGP323V5wk5Sh2BbAk6IAz
GCRZkzx484alEApzZ83fDl7vuKOvqg9AYpjtwK6SC699NnpCLBMYFJZaNW5p3D0h
Oy3NTgzIO8bqHghsiFurdF4v/W8jTaUp6Ccv3bSOj8quo2QJt9Jv/QU2pRmhf6YX
Sad3zu5q1QKBgQDW8he/F6d3ldnlyhUpeYHM0ZbMskDrHW9S0Q/zyUPNe3YaDHrY
YXw0CMBRrs/zpipBwdYws7Ay3zuNWpabVzP4m5T5dINIChsLoTElAiFU6831BA1P
XROCH//cjf3M5nnoX6AVDXMAGr/6/8JPqnGwM2AmJZ4TFnDEgM6qHRfQgwKBgHf8
6NaBpIMpsUCa7FnyH0GIb4SAdA79UJFj0dWmdsO6b8BWg4tva2iNyED9OIvFGAsi
DyF8z9X1PwHVCEiF980jfkg/nR5wh+hR50bjvxZ0zCs3lLFVIBjvX/rwmpq+Exs0
CZLRDGaz/BlDZa5l5d4lAhxtjqlqmFoa2b8yQUtJAoGBALkqSFkpdFfZE+l+5zja
zXdShMKZMmpRHOgUeweiL4oFT0b0K61dVy5QxtM6kDdo/9diESRzgP/wfjTPW8MD
nFve4UPERDYKQBuzAccx9ucpto+agx9vpT1r0gZMC1B4dNjyV/karcmr27n1rcs6
hfTvdBiaairunKoKXLN5w3KI
-----END PRIVATE KEY-----`;

describe('a real TLS handshake under delegation', () => {
  it('proves the server name to the peer, not the address it connected to', async () => {
    const names: (string | undefined)[] = [];
    const hosts: (string | undefined)[] = [];
    const context = createSecureContext({ key: PRIVATE_KEY, cert: CERTIFICATE });
    const server = createHttpsServer({
      key: PRIVATE_KEY,
      cert: CERTIFICATE,
      SNICallback: (name, callback) => {
        names.push(name);
        callback(null, context);
      },
    }, (request, response) => {
      hosts.push(request.headers.host);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ server: { name: 'xpod' } }));
    });
    await listen(server);
    const port = addressOf(server);
    try {
      const fetchTarget = createNodeFederationFetch({ ca: CERTIFICATE });
      const response = await fetchTarget({
        url: `https://127.0.0.1:${port}/_matrix/federation/v1/version`,
        // The endpoint is at the loopback address; the name it must prove is alice.example.
        target: { baseUrl: `https://127.0.0.1:${port}`, hostHeader: 'alice.example' },
        init: { method: 'GET' },
      });

      expect(response.status).toBe(200);
      // The peer saw the name twice over: as the SNI it was asked for, and as `Host`.
      expect(names).toEqual([ 'alice.example' ]);
      expect(hosts).toEqual([ 'alice.example' ]);
    } finally {
      await close(server);
    }
  });

  it('refuses a certificate that does not cover the name being asked for', async () => {
    const context = createSecureContext({ key: PRIVATE_KEY, cert: CERTIFICATE });
    const server = createHttpsServer({
      key: PRIVATE_KEY,
      cert: CERTIFICATE,
      SNICallback: (_name, callback) => callback(null, context),
    }, (_request, response) => { response.writeHead(200); response.end('{}'); });
    await listen(server);
    const port = addressOf(server);
    try {
      const fetchTarget = createNodeFederationFetch({ ca: CERTIFICATE });
      // The address is fine and the CA is trusted, but the name asked for is not the name the
      // certificate is for — which is the whole point of validating against the server name.
      await expect(fetchTarget({
        url: `https://127.0.0.1:${port}/_matrix/federation/v1/version`,
        target: { baseUrl: `https://127.0.0.1:${port}`, hostHeader: 'bob.example' },
        init: { method: 'GET' },
      })).rejects.toThrow(/bob\.example/u);
    } finally {
      await close(server);
    }
  });
});

function listen(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function addressOf(server: HttpsServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the test server did not bind a port');
  return address.port;
}

function close(server: HttpsServer): Promise<void> {
  return new Promise(resolve => { server.close(() => resolve()); });
}
