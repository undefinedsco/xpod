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
URL.

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
