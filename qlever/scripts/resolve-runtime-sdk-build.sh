#!/usr/bin/env bash
set -euo pipefail

sdk_tag=${REQUESTED_SDK_TAG:-}
prior_sdk_digest=${PRIOR_SDK_DIGEST:-}
sdk_image=${SDK_IMAGE:?SDK_IMAGE is required}
source_commit=${XPOD_SOURCE_COMMIT:-${GITHUB_SHA:?GITHUB_SHA is required when XPOD_SOURCE_COMMIT is unset}}
github_output=${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}

build=true
dockerfile="./docker/qlever-runtime-sdk/Dockerfile"
prior_image=""

if [[ -n "$sdk_tag" && -n "$prior_sdk_digest" ]]; then
  echo "runtime_sdk_tag and prior_runtime_sdk_digest are mutually exclusive" >&2
  exit 64
fi

if [[ -n "$sdk_tag" ]]; then
  if [[ ! "$sdk_tag" =~ ^sha-[0-9a-f]{40}$ ]]; then
    echo "runtime_sdk_tag must be an immutable sha-<40 hex> tag" >&2
    exit 64
  fi
  docker buildx imagetools inspect "${sdk_image}:${sdk_tag}" >/dev/null
  build=false
else
  if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "XPOD_SOURCE_COMMIT must be a 40 hex commit" >&2
    exit 64
  fi
  sdk_tag="sha-${source_commit}"
  if [[ -n "$prior_sdk_digest" ]]; then
    if [[ ! "$prior_sdk_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "prior_runtime_sdk_digest must be an immutable sha256:<64 hex> digest" >&2
      exit 64
    fi
    docker buildx imagetools inspect "${sdk_image}@${prior_sdk_digest}" >/dev/null
    dockerfile="./docker/qlever-runtime-sdk/Dockerfile.incremental"
    prior_image="${sdk_image}@${prior_sdk_digest}"
  fi
fi

{
  printf 'tag=%s\n' "$sdk_tag"
  printf 'build=%s\n' "$build"
  printf 'dockerfile=%s\n' "$dockerfile"
  printf 'prior_image=%s\n' "$prior_image"
} >>"$github_output"
