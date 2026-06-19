# Local Phone Smoke Verification

This is the minimal phone-side verification for Local Pod reachability. It does
not require a Harmony HAP. A phone browser is enough to prove that the Local
Xpod gateway is reachable on the LAN.

## Start Local for phone access

From the repository root:

```bash
node scripts/local-phone-smoke.cjs
```

The script detects the Mac LAN IPv4 address, sets `CSS_BASE_URL` to that LAN URL,
binds the gateway to `0.0.0.0`, and prints the phone URL plus a browser verifier
URL. It also prints a signaling-driven verifier URL when you want the phone
browser to enter through `/v1/signal` first.

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

## Verify from the phone

1. Put the phone and Mac on the same Wi-Fi.
2. Open the printed `Verifier URL`, for example:

   ```text
   http://192.168.3.161:3000/app/reachability.html?path=%2Falice%2Fa.txt
   ```

3. Tap `Fetch 验证`. The page fetches the resource from the same origin, so the
   browser automatically uses the visible host. No custom `Host` header, CORS
   bypass, or `/v1/relay/...` share URL is involved.

4. Optional direct resource and health endpoints:

   ```text
   http://192.168.3.161:3000/alice/a.txt
   http://192.168.3.161:3000/.well-known/openid-configuration
   ```

If the phone can open the URL, Local Pod LAN reachability is verified at the
transport level.

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
http://node-0000.undefineds.co/app/reachability.html?path=%2Falice%2Fa.txt
```

That validates the browser data plane: `node-0000.undefineds.co` -> Cloud
gateway/ingress -> node tunnel entrypoint -> local resource.

## Troubleshooting

- Do not use `localhost` on the phone. It points to the phone itself.
- If Mac can open the LAN URL but the phone cannot, check macOS firewall and
  router/AP client-isolation settings.
- If the script cannot detect the LAN IP, pass `--ip <address>` explicitly.
- If port `3000` is occupied, pass `--port <port>` and use the printed URL.
- Browser verification works for normal HTTP(S) routes, including SP-domain
  tunnel/proxy routes. It does not prove P2P hole punching or private
  localhost/LAN route selection behind a canonical URL; those still require a
  managed client such as Desktop / CLI / Native app.

## Relation to Harmony package

For this minimal verification, no native app installation is required. The
browser page under `/app/reachability.html` can be added to the phone home screen
as a lightweight PWA shortcut. A real native app is only needed when validating
managed-client capabilities such as P2P candidate exchange or OS-level local
network behavior.
