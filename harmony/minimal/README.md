# Xpod Inrupt Smoke - Harmony Minimal

This is a minimal Harmony/OpenHarmony WebView shell for the shared Xpod Inrupt verifier page.

## What it verifies

The Harmony app itself does not reimplement Solid, OIDC, signaling, or P2P. It loads:

```text
/app/inrupt-smoke.html
```

That page runs the Inrupt browser SDK (`@inrupt/solid-client-authn-browser`) and verifies:

1. Login against the Cloud OIDC issuer.
2. Complete the OIDC redirect in the same WebView.
3. Use `session.fetch` to access an SP resource.

Typical verifier URL:

```text
http://192.168.3.15:3000/app/inrupt-smoke.html?issuer=http%3A%2F%2F192.168.3.15%3A3000%2F&sp=http%3A%2F%2F192.168.3.15%3A3000%2Falice%2Fa.txt
```

For a Cloud/SP deployment, set `issuer` to the Cloud issuer and `sp` to the SP resource URL.

## Build

This project is a minimal DevEco/Hvigor project using model version `26.0.0`.

To build a real `.hap`, the machine must have:

- DevEco Studio or HarmonyOS command line tools with Hvigor.
- `DEVECO_SDK_HOME` pointing to the HarmonyOS SDK directory.
- A usable JDK on `PATH`.

From the repository root:

```bash
node scripts/build-harmony-minimal.cjs
```

If Hvigor is not on `PATH`, set:

```bash
XPOD_HVIGOR_CLI=/path/to/hvigor node scripts/build-harmony-minimal.cjs
```

The script runs `assembleHap --mode module -p module=entry@default` and copies the generated `.hap` into `.artifacts/harmony-minimal/`.

## Current local packaging status

This repository machine does not currently expose `DEVECO_SDK_HOME`, Hvigor, or a usable JDK. Therefore local packaging may only produce an importable source verifier package, not a signed or installable `.hap`.
