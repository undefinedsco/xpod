# Xpod Reachability Smoke - Harmony Minimal

This is a minimal Harmony/OpenHarmony verification project for the Xpod Local Reachability Signaling API.

## What it verifies

The single page lets a tester enter:

- API Base URL, for example `https://api.example/v1`
- Node ID
- Node Token

Then it can call:

- `GET /nodes/{nodeId}/routes`
- `POST /nodes/{nodeId}/p2p-sessions`
- `POST /nodes/{nodeId}/relay-sessions`

The app sends node authentication headers:

```text
Authorization: Bearer <nodeToken>
X-Node-Id: <nodeId>
```

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

This repository machine can run a registry-provided Hvigor CLI, but it does not
have a valid HarmonyOS SDK (`DEVECO_SDK_HOME`) or usable JDK installed. Therefore
the local artifact is an importable source verifier package, not a signed or
installable `.hap`.
