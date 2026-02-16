# Launcher Contract (v1)

This document defines the stable launcher contract consumed by external products such as LinX.

## Scope

- xpod owns process orchestration and readiness semantics.
- Callers own user-facing config collection and UI orchestration.

## Commands

### `xpod run`

Start xpod in foreground mode.

```bash
xpod run --env <path> --mode <local|cloud> --port <number>
```

Options:
- `--env, -e`: optional env file path
- `--mode, -m`: optional run mode
- `--config, -c`: optional config path, overrides `--mode`
- `--port, -p`: optional gateway port, default `3000`
- `--host`: optional host, default `localhost`

Backward compatibility:
- Legacy invocation without command still works, e.g. `xpod --mode local --port 3000`.

### `xpod status`

Return runtime status.

```bash
xpod status --env <path> --json
```

`--json` payload:

```json
{
  "schemaVersion": "1.0",
  "running": true,
  "ready": true,
  "baseUrl": "http://localhost:3000/",
  "publicUrl": "https://pods.undefineds.co",
  "port": 3000,
  "mode": "local",
  "pid": 12345,
  "version": "0.1.0"
}
```

`publicUrl` and `pid` are optional.

### `xpod health`

Return service-level health checks.

```bash
xpod health --env <path> --json
```

`--json` payload:

```json
{
  "schemaVersion": "1.0",
  "healthy": true,
  "checks": {
    "gateway": "pass",
    "css": "pass",
    "api": "pass"
  },
  "timestamp": "2026-02-10T12:00:00.000Z"
}
```

### `xpod stop`

Stop the runtime process tracked by the same `--env` context.

```bash
xpod stop --env <path> --timeout 10000 --json
```

Options:
- `--timeout`: graceful stop timeout in milliseconds (default `10000`)

## Exit Codes

- `0`: success
- `10`: runtime not running
- `20`: configuration/contract input error
- `50`: internal/runtime error

## Runtime Context & PID Tracking

xpod stores runtime metadata in:

- `.xpod/runtime/<instance-key>.json`

`instance-key` is derived from `--env` absolute path hash. This allows multiple caller contexts to run independently.

## Health Semantics

- `status.running`: process exists
- `status.ready`: `gateway && css && api` health passes
- `health.healthy`: service-level checks pass
  - `gateway`: `GET /_gateway/status`
  - `css`: `HEAD /`
  - `api`: `GET /api/ready`

## Compatibility Policy

- `schemaVersion: "1.0"` fields are stable for minor/patch releases.
- New fields may be appended in backward-compatible manner.
