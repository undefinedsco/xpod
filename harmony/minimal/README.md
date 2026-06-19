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

This repository machine does not include `hvigor` / DevEco Studio, so the committed project is source-only.

To build a real `.hap`:

1. Open this `harmony/minimal` directory in DevEco Studio.
2. Let DevEco sync the Harmony SDK and hvigor dependencies.
3. Build the `entry` module.
4. Install the generated HAP on a Harmony/OpenHarmony device.

If `hvigorw` is available after DevEco sync, you can also run from this directory:

```bash
./hvigorw assembleHap --mode module -p module=entry@default
```
