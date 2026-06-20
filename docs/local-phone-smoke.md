# Local Phone Smoke Verification

This document covers two phone-side smoke paths:

1. **LAN direct mode** — phone and Mac are on the same Wi-Fi, useful for proving
   the local gateway is reachable.
2. **Public Cloud-ingress registration mode** — phone opens Cloud for identity,
   discovers the user's `solid:storage`, and then verifies Pod access on the
   public SP domain. This is the path to use when validating access after
   registration from cellular or an external network.

A Harmony/iOS app is not required for either path. The native shells in this repo
are only WebView wrappers around the same browser pages.

## Start Local for LAN access

From the repository root:

```bash
node scripts/local-phone-smoke.cjs
```

The script detects the Mac LAN IPv4 address, sets `CSS_BASE_URL` to that LAN URL,
binds the gateway to `0.0.0.0`, and prints the phone URL plus browser verifier
URLs.

To preview without starting the server:

```bash
node scripts/local-phone-smoke.cjs --print
```

If auto-detection picks the wrong network interface, pass the IP explicitly:

```bash
node scripts/local-phone-smoke.cjs --ip 192.168.3.161 --port 3000
```

To prefill a different resource in the verifier:

```bash
node scripts/local-phone-smoke.cjs --path /alice/a.txt
```

To prefill a node id in the signaling verifier:

```bash
node scripts/local-phone-smoke.cjs --node-id node-0000 --path /alice/a.txt
```

## Verify LAN reachability from the phone

1. Put the phone and Mac on the same Wi-Fi.
2. Open the printed `Verifier URL`, for example:

   ```text
   http://192.168.3.161:3000/app/reachability.html?path=%2F.well-known%2Fopenid-configuration
   ```

3. Tap `Fetch 验证`. The page fetches the resource from the same origin, so the
   browser automatically uses the visible host. No custom `Host` header, CORS
   bypass, or `/v1/relay/...` share URL is involved.

4. Optional direct resource and health endpoints:

   ```text
   http://192.168.3.161:3000/.well-known/openid-configuration
   http://192.168.3.161:3000/alice/a.txt
   ```

`/.well-known/openid-configuration` should be public and is the default smoke
path. A private Pod resource such as `/alice/a.txt` may correctly return `401`
until the user logs in.

## Verify public access, Cloud registration, and Local SP Pod access

Use this mode for the Cloud IdP + Local SP path. The phone registers/logs in on
Cloud because Cloud is the identity provider. Pod resource reads/writes then go
to the public SP domain that routes to this local node.

The public SP domain must already route to this local node through public direct
access, user tunnel, or explicit Cloud ingress/relay.

```bash
node scripts/local-phone-smoke.cjs \
  --sp-base-url https://node-0000.undefineds.co/ \
  --idp-base-url https://id.undefineds.co/ \
  --storage-path .data/inrupt-smoke/probe.ttl#this
```

`--public-base-url` is still accepted as an alias for `--sp-base-url`.

The script prints these important URLs:

```text
Public SP URL: https://node-0000.undefineds.co/
Cloud IdP URL: https://id.undefineds.co/
Register URL:  https://id.undefineds.co/.account/login/password/register/
Login URL:     https://id.undefineds.co/.account/login/password/
Account URL:   https://id.undefineds.co/.account/
Inrupt URL:    https://id.undefineds.co/app/inrupt-smoke.html?issuer=https%3A%2F%2Fid.undefineds.co%2F&storagePath=.data%2Finrupt-smoke%2Fprobe.ttl%23this
Storage Path:  .data/inrupt-smoke/probe.ttl#this
```

Validation flow:

1. On the phone, disconnect Wi-Fi if you want to prove external reachability.
2. Open the printed `Register URL` on the **Cloud IdP** origin.
3. Register the account and complete the Cloud account flow.
4. Open the printed `Inrupt URL`. The page is served from the **Cloud IdP**
   origin so the browser login and redirect stay under `https://id.undefineds.co/`.
5. Log in through Cloud.
6. Tap `Discover Storage Home`. The page reads the WebID profile, extracts
   `solid:storage`, and fills `Pod Home / Storage URL` with the Local SP storage
   root, for example `https://node-0000.undefineds.co/alice/`.
7. Tap `Drizzle Read/Write/Delete`. The page creates a drizzle-solid db with
   `podUrl` set to that storage home and writes, reads, then deletes the RDF
   smoke record at the storage-relative path shown by `Storage Path`.
8. Optional: tap `session.fetch SP Resource` to fetch the derived concrete SP
   resource URL directly with the same Inrupt session.

For this mode, local xpod's `CSS_BASE_URL` must be the **public SP** origin, not
the LAN address, and `oidcIssuer` must be the **Cloud IdP** origin. Otherwise the
flow may generate `192.168.x.x` resource IRIs or use the wrong account authority
from cellular/external networks.

This mode is ordinary browser HTTP(S) to a public SP route plus Cloud IdP login.
It does not require P2P hole punching. P2P remains a managed-client optimization
for avoiding Cloud as the data path after discovery/coordination.

If you omit `--idp-base-url`, the script assumes single-origin standalone mode:
registration/login and Pod resources are on the same origin.

## Verify with Inrupt browser SDK

Use the printed `Inrupt URL` when the goal is to validate a standard Solid client
flow:

```text
http://192.168.3.161:3000/app/inrupt-smoke.html?issuer=http%3A%2F%2F192.168.3.161%3A3000%2F&sp=http%3A%2F%2F192.168.3.161%3A3000%2F.well-known%2Fopenid-configuration
```

That page runs `@inrupt/solid-client-authn-browser`, logs into the configured
OIDC issuer, discovers `solid:storage` from the WebID profile, then uses that
storage as the Pod home. The direct `session.fetch` button can fetch the derived
SP resource URL, and the drizzle button loads `@undefineds.co/drizzle-solid` on
demand, sets `podUrl` to the discovered storage home, and verifies
insert/find/delete against a storage-relative RDF resource. For public Cloud IdP
+ Local SP validation, use the `Inrupt URL` printed by
`--sp-base-url ... --idp-base-url ...`; in that mode the URL is on the Cloud IdP
origin and does not hardcode an SP resource URL.

## Verify basic Pod access through signaling

Use the printed `Signal URL` when the goal is to validate the Xpod signaling
service, not just a direct browser fetch:

```text
http://192.168.3.161:3000/app/signal-pod.html?path=%2Falice%2Fa.txt&nodeId=node-0000
```

The page performs the smoke flow in this order:

1. `GET /v1/signal/nodes/:nodeId/routes`
2. Optional `POST /v1/signal/nodes/:nodeId/sessions`
3. Select a returned `nodeCandidates` / route entry
4. `GET` the configured Pod resource through that returned route

If the node requires authentication for `sessions`, fill the node token in
the page. Without a token, the page can still verify public route discovery and
public resource fetch when those routes are exposed.

Current boundary: this validates signaling telemetry, session creation,
candidate return, route selection, and Pod resource HTTP access. It does not by
itself prove a full P2P data tunnel until the worker/client side implements
candidate exchange and connection establishment.

For external SP-domain validation, use the same verifier path on the SP domain:

```text
https://node-0000.undefineds.co/app/reachability.html?path=%2F.well-known%2Fopenid-configuration
```

That validates the browser data plane: `node-0000.undefineds.co` -> Cloud
gateway/ingress -> node tunnel entrypoint -> local resource.

## Verify non-browser P2P data plane

Browser pages can validate Cloud IdP, SP routes, signaling metadata, session
creation, and ordinary HTTP(S) access to Pod resources. They do not prove the
managed-client raw TCP P2P data plane. Ordinary browsers do not expose raw TCP
sockets, local same-port bind, or TCP simultaneous open. Chrome Isolated Web Apps expose Direct Sockets, but that is an installed-app runtime
research path for custom TCP transport, not ordinary browser support and not the
current acceptance target.

Current non-browser data-plane verification is local-runtime only:

```bash
./scripts/run-vitest-safe.sh --run tests/edge/reachability/TcpP2PDataPlaneTransport.test.ts
```

That test starts a real local TCP server and client, sends canonical Solid HTTP
requests as `xpod-p2p-http/1` frames over the TCP stream, and verifies the local
node handler forwards the request to the configured CSS/SP base URL while
preserving canonical URL headers.

Raw TCP cross-NAT acceptance still needs a packaged native/CLI/mobile runtime
that can:

1. read `/v1/signal/nodes/:nodeId/sessions`;
2. compute the shared hole-punch bucket, rendezvous time, and candidate ports;
3. bind candidate local TCP ports with the required socket options;
4. run TCP simultaneous open against the peer-observed public address;
5. select one winning socket and upgrade it to `TcpP2PDataPlaneTransport`;
6. run the same canonical Solid HTTP request over that socket.

Until that runtime smoke exists, public-network phone validation should use the
SP-domain browser flow above. That validates product-visible Solid behavior, but
it is not proof of raw TCP P2P data-plane success.

## Troubleshooting

- Do not use `localhost` on the phone. It points to the phone itself.
- LAN mode requires the phone and Mac to be on the same Wi-Fi.
- Cloud registration mode requires the Cloud IdP URL to be reachable and the public
  SP domain to route to this local node before fetching SP resources.
- If Mac can open the LAN URL but the phone cannot, check macOS firewall and
  router/AP client-isolation settings.
- If the script cannot detect the LAN IP, pass `--ip <address>` explicitly.
- If port `3000` is occupied, pass `--port <port>` and use the printed URL.
- If registration/login redirects back to `192.168.x.x`, open the Cloud IdP
  `Register URL`; if SP resource URLs contain `192.168.x.x`, restart with
  `--sp-base-url https://<sp-domain>/ --idp-base-url https://<cloud-idp>/`.
- Browser verification works for normal HTTP(S) routes, including SP-domain
  tunnel/proxy routes. It does not prove P2P hole punching or private
  localhost/LAN route selection behind a canonical URL; those still require a
  managed client such as Desktop / CLI / Native app.

## Relation to mobile packages

For basic CSS reachability, Cloud registration, and SP resource smoke checks, no
native app installation is required. The browser page under
`/app/reachability.html` can be added to the phone home screen as a lightweight
PWA shortcut.

For standard Solid SDK validation, use `/app/inrupt-smoke.html` directly or load
it inside the minimal Harmony/iOS WebView shells under `harmony/minimal/` and
`ios/InruptSmoke/`. These shells do not implement Solid themselves; the verifier
page runs the Inrupt browser SDK, discovers storage, and uses drizzle-solid for
the write/read/delete smoke. A deeper native app is only needed when validating
managed-client capabilities such as P2P candidate exchange or OS-level local
network behavior.
