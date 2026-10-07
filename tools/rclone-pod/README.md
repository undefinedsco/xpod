# rclone PodHTTP backend (engine-selection study)

Experimental rclone v1.75.1 backend that exposes an Xpod Pod as an rclone
remote. This is a **study fixture** for
`docs/xpod-cli-engine-selection.md`; it is not a product component and carries
no support commitment.

## Pinned upstream

- Go module: `github.com/rclone/rclone v1.75.1`
- Module sum: `h1:kIxQcoDLj2Gke/gMSHK7OnxhX1Gu1cJBLP1kJZoaFp0=`
- License: MIT (module `COPYING`)
- Build: Go 1.26.1, `CGO_ENABLED=0`, `GOPROXY=https://proxy.golang.org,direct`

## Layout

```
podhttp/     rclone Fs/Object backend + Go unit tests (real HTTP fixture)
podfixture/  in-process HTTP fixture: agent-directory list + LDP resource semantics
cmd/xpod-pod-fixture/  standalone fixture server (for the CLI/mount experiments)
scripts/     reproducible experiments (CLI, real TS handler contract, Docker FUSE)
docker/      study-only Alpine+fuse3 image for the Linux mount experiment
```

## Build

```sh
# host binary (adds the podhttp backend to rclone v1.75.1)
env -u HTTP_PROXY -u HTTPS_PROXY GOPROXY=https://proxy.golang.org,direct \
  CGO_ENABLED=0 go build -o bin/xpod-rclone .

# linux/arm64 fixture for the Docker FUSE experiment
env -u HTTP_PROXY -u HTTPS_PROXY GOPROXY=https://proxy.golang.org,direct \
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o bin/linux-arm64/xpod-rclone .
```

## Tests and experiments

```sh
env -u HTTP_PROXY -u HTTPS_PROXY GOPROXY=https://proxy.golang.org,direct \
  CGO_ENABLED=0 go test -race ./...

bash scripts/run-cli-experiment.sh          # CLI mutations + raw HTTP log
bun  scripts/real-handler-contract.mjs      # Go List() vs the real TS handler
bash scripts/run-mount-experiment.sh        # Docker Linux FUSE mount + native files
```

Evidence logs land in `.test-data/agent-directory-workers/rclone/`.

## Config

```
[pod]
type = podhttp
url = http://127.0.0.1:3000/alice/
metadata_path = /-/agent-directory
token = <prototype only>
```

`token` is a **prototype-only** bearer injection. Production must bridge the
existing Xpod CLI authenticated request pipeline instead of a static token.
