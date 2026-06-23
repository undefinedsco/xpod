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
./scripts/run-vitest-safe.sh --run \
  tests/edge/reachability/ManagedClientP2PLocalE2E.test.ts \
  tests/edge/reachability/ManagedClientP2PSmoke.test.ts \
  tests/edge/reachability/TcpP2PDataPlaneTransport.test.ts \
  tests/edge/reachability/TcpP2PSignalingSession.test.ts \
  tests/edge/reachability/ManagedClientFetch.test.ts \
  tests/edge/EdgeNodeAgent.test.ts \
  tests/scripts/p2p-dual-smoke.test.ts
```

These tests cover the repository-backed local signal API, node heartbeat route
advertisement, signaled client/node candidate exchange, the local TCP frame
transport, the managed-client fetch adapters, and the `EdgeNodeAgent` accept
loop that attaches an accepted socket to `XPOD_P2P_TARGET_BASE_URL`. The
dual-script smoke additionally runs the node accept runner and managed-client
runner as two subprocesses against the same signal API, proving the CLI/script
contract remains compatible instead of only exercising library functions. The local
E2E smoke starts an in-process signal API, a target HTTP server standing in for
CSS/SP, a real `EdgeNodeAgent`, and a managed client. It uses deterministic
socket injection at the raw socket boundary so CI and developer laptops can
reproduce the orchestration path without depending on a particular NAT.

The high-level adapter also fetches `/v1/signal/nodes/:nodeId/routes` before
creating the P2P session, so native/CLI/mobile clients do not need to duplicate
route-set lookup. They send canonical Solid HTTP requests as `xpod-p2p-http/1`
frames over the TCP stream and verify the local node handler forwards the
request to the configured CSS/SP base URL while preserving canonical URL
headers.
The default Node connector is also covered for delayed peer availability: it
keeps retrying within `connectTimeoutMs` from the same candidate local TCP port
instead of failing after one refused connection. The local E2E suite now has two
modes:

- `deterministic-injection` (default): starts `EdgeNodeAgent` and injects a
  pre-connected socket pair at the raw TCP boundary. This is stable for CI and
  proves route discovery, signaling, node accept orchestration, and canonical
  HTTP frame forwarding.
- `real-tcp-listener`: publishes the same P2P route through the repository-backed
  signal API, answers client candidates, starts a real loopback TCP listener, and
  lets the managed client connect through actual Node TCP sockets. It uses
  different client/node local ports on the same bucket because one host cannot
  bind the client local port to the same port already used by the listener. This
  proves local TCP data-plane wiring, but not cross-NAT simultaneous open.

For a one-command local orchestration smoke that starts the signal API, node
registry, target CSS/SP stand-in, and managed client in one process, use:

```bash
bun run smoke:p2p:local-e2e
```

This prints JSON evidence including `smoke.route`, selected raw TCP candidate
plan, client/node connect attempts, target HTTP requests, and explicit caveats.
It is deterministic and useful for development/regression work, but it injects
the already-connected socket pair at the raw socket boundary. It proves the
control-plane and managed-client data-plane wiring, not real cross-NAT TCP
simultaneous open.

For a stronger local integration boundary, run the Docker bridge smoke:

```bash
bun run smoke:p2p:docker-e2e
```

This starts three Docker containers on the same Docker bridge network:

1. `signal`: repository-backed signal API plus a target HTTP server standing in
   for the local CSS/SP.
2. `node`: node-side non-browser TCP data-plane listener. It publishes only a
   port-only node candidate; the signal API must enrich it to a
   `signal-observed` Docker bridge address.
3. `client`: managed-client smoke. It publishes only port-only client
   candidates, discovers the node candidate through signal, and fetches the
   canonical Solid resource through the raw TCP data plane.

The JSON result must show `smokeOk: true`, `route.kind: "p2p"`,
`clientAddress: "signal-observed"`, node `accepted[].nodeAddress:
"signal-observed"`, and a target request with the canonical URL headers. This
proves real non-browser TCP data-plane sockets across Docker bridge containers.
It still does **not** prove real cross-NAT TCP simultaneous open; phone/cellular
or another external native runtime remains the final realnet acceptance step.
Cloudflare Tunnel and FRP/SakuraFRP remain fallback routes and are not replaced
by this smoke.

To exercise real local TCP sockets instead of the injected socket pair:

```bash
bun run smoke:p2p:local-e2e -- --socket-mode real-tcp-listener
```

This mode returns `evidence.dataPlane = real-local-tcp-listener` and reports both
`clientPlan` and `nodePlan`. It still runs on loopback and is not a substitute
for packaged native/mobile cross-network validation.

For a two-runner local smoke that keeps the production script boundary, run:

```bash
./scripts/run-vitest-safe.sh --run tests/scripts/p2p-dual-smoke.test.ts
```

That test launches `scripts/edge-node-p2p-accept-smoke.ts` and
`scripts/managed-client-p2p-smoke.ts` as separate processes, then checks:

1. the managed client selected `route.kind = p2p`;
2. the canonical Solid resource body came back through `xpod-p2p-http/1`;
3. the node runner emitted an `accepted` event for the same session/client;
4. the node runner's JSON result still declares Cloudflare Tunnel and
   FRP/SakuraFRP as preserved fallback routes.

For a CLI/native-style smoke against a running signal API and a node with
`XPOD_P2P_ENABLED=true`, use:

```bash
bun run smoke:p2p:managed -- \
  --api-base-url https://api.undefineds.co/ \
  --node-id node-0000 \
  --token "$XPOD_SERVICE_TOKEN" \
  --client-id "cli-$(hostname)" \
  --winner-selection-window-ms 50 \
  --resource-url https://node-0000.undefineds.co/.well-known/openid-configuration
```

The command performs route discovery, creates a P2P session through signaling,
waits for node raw TCP candidates, then sends the canonical Solid HTTP request
through the selected managed-client fetch route. Managed/native clients can omit
`--host` and `--address`: the signal API injects the observed client address for
port-only candidates from `X-Forwarded-For`, `X-Real-IP`, or the socket remote
address. Use `--host` or `--address` only as an explicit debug override. It
prints a JSON result with `route`, HTTP status, headers, and body. By default it
exits non-zero unless the selected route is `p2p`; pass `--allow-fallback` only
when you intentionally want to validate public/user-tunnel fallback behavior
instead of raw TCP P2P.
The local node side follows the same rule: when no explicit node host/address is
configured, node candidates can also be port-only and rely on the signal API to
inject the observed node address.
When multiple candidate sockets connect almost together, `--winner-selection-window-ms`
lets the managed client collect a short success set and keep the deterministic
candidate-pair winner instead of racing on first completion. Set
`XPOD_P2P_WINNER_SELECTION_WINDOW_MS=50` on the local node agent as well when the
smoke is meant to prove both peers use the same deterministic winner policy.

This native P2P path is additive. Existing Cloudflare Tunnel and FRP/SakuraFRP
paths remain the browser/public `user-tunnel` fallback and are not replaced by
raw TCP P2P.

当前手机/实网验证进度记录在
[`docs/p2p-mobile-verification-progress.md`](p2p-mobile-verification-progress.md)。
其中 Harmony Mate 80 路径已构建并完成 OpenHarmony 本地签名，但商用设备拒绝
OpenHarmony Root CA，安装阶段被阻塞；Docker、本机 smoke 不能被解释为手机 P2P
验收完成。

To avoid hand-copying mismatched node/client arguments during external
validation, generate the paired commands first:

```bash
bun run smoke:p2p:realnet -- plan \
  --api-base-url https://api.undefineds.co/ \
  --node-id node-0000 \
  --node-token "$XPOD_NODE_TOKEN" \
  --base-url https://node-0000.undefineds.co/ \
  --target-base-url http://127.0.0.1:3000/ \
  --client-id "phone-$(date +%s)" \
  --token "$XPOD_SERVICE_TOKEN" \
  --resource-url https://node-0000.undefineds.co/.well-known/openid-configuration \
  --winner-selection-window-ms 50
```

Run the printed node command on the local/SP machine and the printed client
command from another non-browser runtime/network. Save both JSON outputs, then
combine them into one acceptance verdict:

By default the generated node and client commands omit host/address. Each peer
still connects to signal, so the signal API injects the observed address for
port-only raw TCP candidates. Add `--node-host` / `--node-address` or
`--client-host` / `--client-address` only when you intentionally need an
explicit debug override. Observing an address does not prove the advertised port
is reachable through every NAT type.

```bash
bun run smoke:p2p:realnet -- verify \
  --client-id "$CLIENT_ID" \
  --node-result-file node-result.json \
  --client-result-file client-result.json \
  --expected-status 200
```

The verifier requires node-side accept evidence, a client-selected `p2p` route,
a raw TCP connector success event, `clientAddress = signal-observed`,
`accepted[].nodeAddress = signal-observed` for the same `clientId`, and explicit
evidence that Cloudflare Tunnel and FRP/SakuraFRP remain preserved fallback
routes. For mobile read/write smoke, pass `--require-put-status-2xx` so the
verdict also proves the PUT write completed before the GET read. If either peer used `--host` / `--address`, the run can still be useful
for debugging but does not satisfy the default port-only acceptance gate. The
verifier still cannot manufacture cross-NAT success; it only makes the external
evidence check repeatable.

The relevant success evidence should look like this:

```json
{
  "client": {
    "smokeOk": true,
    "route": { "kind": "p2p" },
    "putStatus": 200,
    "clientAddress": "signal-observed",
    "connectorEvents": [{ "type": "success" }]
  },
  "node": {
    "accepted": [
      {
        "clientId": "phone-...",
        "nodeAddress": "signal-observed"
      }
    ]
  }
}
```

Raw TCP cross-NAT acceptance now has two non-browser runtime paths:

1. CLI/native script smoke: run the generated `smoke:p2p:node-accept` command
   on the SP machine and the generated `smoke:p2p:managed` command from another
   non-browser runtime/network.
2. Mobile smoke: run the `LinX P2P Smoke` Android package or the iOS React
   Native host with `--p2p-smoke` on a true phone. The app binds candidate local
   TCP ports, logs in through the configured IDP, creates a signal session with
   port-only candidates, sends canonical Solid HTTP frames over
   `xpod-p2p-http/1`, and returns JSON evidence compatible with the same
   `smoke:p2p:realnet -- verify` gate.

For Android, the companion launcher can prefill the smoke fields and capture
the verifier JSON from logcat automatically:

```bash
cd /Users/ganlu/develop/linx-mobile
npm run p2p:android:launch -- \
  --adb /opt/homebrew/bin/adb \
  --adb-server-port 5041 \
  --idp-url https://id.undefineds.co/ \
  --storage-url https://node-0000.undefineds.co/ \
  --client-id phone-1 \
  --resource-path /alice/.data/linx-mobile-p2p-smoke.txt \
  --capture-result mobile-result.json \
  --skip-build
```

From the Xpod repo, the Android real-network smoke can also be orchestrated as
one command. It writes `plan.json`, `node-result.json`, and
`mobile-result.json` under `.test-data/p2p-android-realnet/`, then runs the same
file-based verifier:

```bash
cd /Users/ganlu/develop/xpod
bun run smoke:p2p:android-realnet -- \
  --linx-mobile-root /Users/ganlu/develop/linx-mobile \
  --api-base-url https://api.undefineds.co/ \
  --node-id node-0000 \
  --node-token "$XPOD_NODE_TOKEN" \
  --base-url https://node-0000.undefineds.co/ \
  --target-base-url http://127.0.0.1:3000/ \
  --client-id phone-1 \
  --resource-url https://node-0000.undefineds.co/alice/.data/linx-mobile-p2p-smoke.txt \
  --adb /opt/homebrew/bin/adb \
  --adb-server-port 5041 \
  --skip-build
```

Use `--dry-run` first to inspect the generated node, mobile, and verifier
commands without requiring an attached phone. During the real run, the phone
still needs to complete `Login to IDP` and `Run P2P write/read smoke` in the
`LinX P2P Smoke` app; ADB only installs, launches, prefills fields, and captures
the `RESULT_JSON` log marker.

The Android native bridge logs `RESULT_JSON <json>` through the
`XpodP2PSmoke` logcat tag; `--capture-result` writes that payload to
`mobile-result.json`. For iOS, run the React Native host from Xcode on a true
iPhone with the `--p2p-smoke` launch argument, then search the Xcode console for
`RESULT_JSON ` and copy the JSON payload into `mobile-result.json`.

Phone USB, ADB/HDB, and Xcode are only install / launch / log-collection control
paths. Simulator and browser checks are useful for UI, Solid login, and public
SP-route validation, but they are not final evidence for raw TCP P2P data-plane
success. Final acceptance still requires real node/client JSON from separate
network contexts showing `route.kind = "p2p"`, connector `success`,
`clientAddress = "signal-observed"`, and node `accepted[].nodeAddress =
"signal-observed"`.

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
