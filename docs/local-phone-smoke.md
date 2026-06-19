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
binds the gateway to `0.0.0.0`, and prints the phone URL.

To preview without starting the server:

```bash
node scripts/local-phone-smoke.cjs --print
```

If auto-detection picks the wrong network interface, pass the IP explicitly:

```bash
node scripts/local-phone-smoke.cjs --ip 192.168.3.161 --port 3000
```

## Verify from the phone

1. Put the phone and Mac on the same Wi-Fi.
2. Open the printed `Phone URL`, for example:

   ```text
   http://192.168.3.161:3000/
   ```

3. Optional health endpoint:

   ```text
   http://192.168.3.161:3000/.well-known/openid-configuration
   ```

If the phone can open the URL, Local Pod LAN reachability is verified at the
transport level.

## Troubleshooting

- Do not use `localhost` on the phone. It points to the phone itself.
- If Mac can open the LAN URL but the phone cannot, check macOS firewall and
  router/AP client-isolation settings.
- If the script cannot detect the LAN IP, pass `--ip <address>` explicitly.
- If port `3000` is occupied, pass `--port <port>` and use the printed URL.

## Relation to Harmony package

For this minimal verification, no app installation is required. The Harmony
sample under `harmony/minimal/` remains a native verifier source package for
later device-app testing when a DevEco/Harmony SDK toolchain is available.
