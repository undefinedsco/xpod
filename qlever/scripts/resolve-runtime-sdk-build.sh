#!/usr/bin/env bash
set -euo pipefail

sdk_tag=${REQUESTED_SDK_TAG:-}
prior_sdk_digest=${PRIOR_SDK_DIGEST:-}
inputs_tag=${QELEVER_INPUTS_TAG:-}
reuse_identical_inputs=${REUSE_IDENTICAL_INPUTS:-true}
sdk_image=${SDK_IMAGE:?SDK_IMAGE is required}
source_commit=${XPOD_SOURCE_COMMIT:-${GITHUB_SHA:?GITHUB_SHA is required when XPOD_SOURCE_COMMIT is unset}}
github_output=${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}

build=true
dockerfile="./docker/qlever-runtime-sdk/Dockerfile"
prior_image=""
reused_inputs=false

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
  # The C++ build is compile-bound and takes 36-39 minutes cold. Its identity is
  # a pure function of the QLever build inputs, so an image already built from the
  # same inputs (published under a tag named for them) is the same SDK: reusing it
  # costs nothing and skipping the build cannot change what ships. Inputs that did
  # change are not reused - the incremental Dockerfile only accepts a prior image
  # whose source manifest matches, so a stale alias would fail the run rather than
  # quietly produce a different binary.
  if [[ "$reuse_identical_inputs" == "true" && "$build" == "true" && -n "$inputs_tag" ]]; then
    if [[ ! "$inputs_tag" =~ ^qlever-inputs-[0-9a-f]{12}$ ]]; then
      echo "QELEVER_INPUTS_TAG must look like qlever-inputs-<12 hex>" >&2
      exit 64
    fi
    if docker buildx imagetools inspect "${sdk_image}:${inputs_tag}" >/dev/null 2>&1; then
      sdk_tag="$inputs_tag"
      build=false
      reused_inputs=true
    fi
  fi
  if [[ -n "$prior_sdk_digest" && "$build" == "true" ]]; then
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
  printf 'reused_inputs=%s\n' "$reused_inputs"
} >>"$github_output"
