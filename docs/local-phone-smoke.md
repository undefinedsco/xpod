# Local Phone Smoke Verification

This document covers two phone-side smoke paths:

1. **LAN direct mode** — phone and Mac are on the same Wi-Fi, useful for proving
   the local gateway is reachable.
2. **Public Cloud-ingress registration mode** — phone opens the public SP domain,
   registers/logs in, and then verifies Pod access. This is the path to use when
   validating access after registration from cellular or an external network.

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

## Verify public access, registration, and Pod access

Use this mode when the phone should access the local node through the public SP
domain and then register/login. The public domain must already route to this
local node through Cloud ingress/tunnel.

```bash
node scripts/local-phone-smoke.cjs \
  --public-base-url https://node-0000.undefineds.co/
```

The script prints these important URLs:

```text
Public URL:   https://node-0000.undefineds.co/
Register URL: https://node-0000.undefineds.co/.account/login/password/register/
Login URL:    https://node-0000.undefineds.co/.account/login/password/
Account URL:  https://node-0000.undefineds.co/.account/
Inrupt URL:   https://node-0000.undefineds.co/app/inrupt-smoke.html?...
```

Validation flow:

1. On the phone, disconnect Wi-Fi if you want to prove external reachability.
2. Open the printed `Register URL`.
3. Register the account and create/open the Pod through the normal CSS account
   flow.
4. Open the printed `Inrupt URL`.
5. Log in with the same public issuer.
6. Set `SP Resource URL` to an actual Pod resource on the same public origin,
   for example `https://node-0000.undefineds.co/alice/profile/card` or another
   resource created during registration.
7. Run `session.fetch` from the page.

For this mode, `CSS_BASE_URL` must be the **public** origin, not the LAN address.
Otherwise CSS/OIDC may generate issuer, redirect, WebID, or Pod URLs containing
`192.168.x.x`, which will fail from cellular/external networks.

This mode is ordinary browser HTTP(S) through Cloud ingress. It does not require
P2P hole punching. P2P remains a managed-client optimization for avoiding Cloud
as the data path after discovery/coordination.

## Verify with Inrupt browser SDK

Use the printed `Inrupt URL` when the goal is to validate a standard Solid client
flow:

```text
http://192.168.3.161:3000/app/inrupt-smoke.html?issuer=http%3A%2F%2F192.168.3.161%3A3000%2F&sp=http%3A%2F%2F192.168.3.161%3A3000%2F.well-known%2Fopenid-configuration
```

That page runs `@inrupt/solid-client-authn-browser`, logs into the configured
OIDC issuer, then uses `session.fetch` to access the configured SP resource. For
public registration validation, use the public `Inrupt URL` printed by
`--public-base-url` so both `issuer` and `sp` use the external SP origin.

## Verify basic Pod access through signaling

Use the printed `Signal URL` when the goal is to validate the Xpod signaling
service, not just a direct browser fetch:

```text
http://192.168.3.161:3000/app/signal-pod.html?path=%2Falice%2Fa.txt&nodeId=node-0000
```

The page performs the smoke flow in this order:

1. `GET /v1/signal/nodes/:nodeId/routes`
2. Optional `POST /v1/signal/nodes/:nodeId/p2p-sessions`
3. Select a returned `nodeCandidates` / route entry
4. `GET` the configured Pod resource through that returned route

If the node requires authentication for `p2p-sessions`, fill the node token in
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

## Troubleshooting

- Do not use `localhost` on the phone. It points to the phone itself.
- LAN mode requires the phone and Mac to be on the same Wi-Fi.
- Public registration mode requires the public SP domain to route to this local
  node before opening the registration URL.
- If Mac can open the LAN URL but the phone cannot, check macOS firewall and
  router/AP client-isolation settings.
- If the script cannot detect the LAN IP, pass `--ip <address>` explicitly.
- If port `3000` is occupied, pass `--port <port>` and use the printed URL.
- If registration/login redirects back to `192.168.x.x`, restart with
  `--public-base-url https://<sp-domain>/` so `CSS_BASE_URL` is public.
- Browser verification works for normal HTTP(S) routes, including SP-domain
  tunnel/proxy routes. It does not prove P2P hole punching or private
  localhost/LAN route selection behind a canonical URL; those still require a
  managed client such as Desktop / CLI / Native app.

## Relation to mobile packages

For basic CSS reachability and public registration, no native app installation is
required. The browser page under `/app/reachability.html` can be added to the
phone home screen as a lightweight PWA shortcut.

For standard Solid SDK validation, use `/app/inrupt-smoke.html` directly or load
it inside the minimal Harmony/iOS WebView shells under `harmony/minimal/` and
`ios/InruptSmoke/`. These shells do not implement Solid themselves; the verifier
page runs the Inrupt browser SDK. A deeper native app is only needed when
validating managed-client capabilities such as P2P candidate exchange or OS-level
local network behavior.
