#!/usr/bin/env bash
set -euo pipefail

sdk_tag=${REQUESTED_SDK_TAG:-}
prior_sdk_digest=${PRIOR_SDK_DIGEST:-}
inputs_tag=${QELEVER_INPUTS_TAG:-}
normal_selection=${QELEVER_NORMAL_SELECTION:-}
reuse_identical_inputs=${REUSE_IDENTICAL_INPUTS:-true}
sdk_image=${SDK_IMAGE:-${RUNTIME_IMAGE:-}}
sdk_profile=${SDK_PROFILE:-}
[[ -n "$sdk_image" ]] || { echo 'SDK_IMAGE or RUNTIME_IMAGE is required' >&2; exit 64; }
source_commit=${XPOD_SOURCE_COMMIT:-${GITHUB_SHA:?GITHUB_SHA is required when XPOD_SOURCE_COMMIT is unset}}
github_output=${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}

build=true
runtime_dockerfile=${RUNTIME_DOCKERFILE:-./docker/qlever-runtime-sdk/Dockerfile}
dockerfile="$runtime_dockerfile"
prior_image=""
reused_inputs=false
image_ref=""

selection_image() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, re, sys
path, tag, expected_source = sys.argv[1], sys.argv[2], sys.argv[3]
value = json.load(open(path))
if value.get('schemaVersion') != 1 or value.get('kind') != 'qlever-sdk-normal-selection' or value.get('model') != 'normal-build-v1' or value.get('verified') is not True:
    raise SystemExit('shared normal SDK selection differs')
if value.get('inputHash') != tag.removeprefix('qlever-inputs-'):
    raise SystemExit('shared normal SDK selection input hash differs')
image = value.get('image', {}).get('referenceByDigest')
if not isinstance(image, str) or not re.fullmatch(r'ghcr\.io/undefinedsco/xpod-qlever-sdk@sha256:[a-f0-9]{64}', image):
    raise SystemExit('shared normal SDK selection image differs')
sdk = value.get('sdk', {})
if not isinstance(sdk.get('sourceSha'), str) or not re.fullmatch(r'[a-f0-9]{40}', sdk['sourceSha']):
    raise SystemExit('shared normal SDK selection source differs')
if expected_source and sdk['sourceSha'] != expected_source:
    raise SystemExit('shared normal SDK selection source differs from the requested immutable tag')
artifact = value.get('artifact', {})
if not isinstance(artifact.get('id'), int) or artifact['id'] <= 0 or not re.fullmatch(r'[a-f0-9]{64}', str(artifact.get('digest', ''))):
    raise SystemExit('shared normal SDK selection artifact differs')
master = artifact.get('master', {})
if master.get('path') != 'materials.json' or not isinstance(master.get('bytes'), int) or master['bytes'] <= 0 or not re.fullmatch(r'[a-f0-9]{64}', str(master.get('sha256', ''))):
    raise SystemExit('shared normal SDK selection master differs')
print(image)
PY
}

if [[ -n "$sdk_tag" && -n "$prior_sdk_digest" ]]; then
  echo "runtime_sdk_tag and prior_runtime_sdk_digest are mutually exclusive" >&2
  exit 64
fi

if [[ -n "$sdk_tag" ]]; then
  if [[ ! "$sdk_tag" =~ ^sha-[0-9a-f]{40}$ ]]; then
    echo "runtime_sdk_tag must be an immutable sha-<40 hex> tag" >&2
    exit 64
  fi
  if [[ "$sdk_profile" == service-trixie ]]; then
    # A raw tag is not artifact/master custody. The ordinary service route may
    # reuse only the exact shared verified normal selection for the same full
    # input identity and the tag's actual immutable digest.
    [[ -n "$normal_selection" ]] || { echo 'service-trixie runtime_sdk_tag requires a matching verified normal SDK selection artifact' >&2; exit 64; }
    [[ -n "$inputs_tag" ]] || { echo 'service-trixie runtime_sdk_tag requires the canonical full input identity' >&2; exit 64; }
    tag_digest="$(docker buildx imagetools inspect "${sdk_image}:${sdk_tag}" --format '{{json .Manifest.Digest}}' | tr -d '"')"
    [[ "$tag_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'service-trixie runtime_sdk_tag must resolve to an immutable OCI digest' >&2; exit 64; }
    proof_image=$(selection_image "$normal_selection" "$inputs_tag" "${sdk_tag#sha-}")
    [[ "${proof_image##*@}" == "$tag_digest" ]] || { echo 'service-trixie runtime_sdk_tag digest differs from the verified normal SDK selection' >&2; exit 64; }
    image_ref="$proof_image"
    build=false
    reused_inputs=true
  else
    docker buildx imagetools inspect "${sdk_image}:${sdk_tag}" >/dev/null
    build=false
  fi
else
  if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "XPOD_SOURCE_COMMIT must be a 40 hex commit" >&2
    exit 64
  fi
  sdk_tag="sha-${source_commit}"
  # The ordinary SDK is a pure function of its full canonical build inputs. A
  # retained normal-build-v1 proof names that exact 64-hex input identity, an
  # immutable OCI digest and a trusted GitHub artifact origin. A tag alone never
  # authorizes reuse: the proof is parsed and checked here before build=false.
  if [[ "$reuse_identical_inputs" == "true" && "$build" == "true" && -n "$inputs_tag" ]]; then
    if [[ ! "$inputs_tag" =~ ^qlever-inputs-[0-9a-f]{64}$ ]]; then
      echo "QELEVER_INPUTS_TAG must look like qlever-inputs-<64 hex>" >&2
      exit 64
    fi
    if [[ -n "$normal_selection" ]]; then
      proof_image=$(selection_image "$normal_selection" "$inputs_tag" "")
      docker buildx imagetools inspect "$proof_image" >/dev/null
      image_ref="$proof_image"
      sdk_tag="sha-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sdk"]["sourceSha"])' "$normal_selection")"
      build=false
      reused_inputs=true
    fi
  fi
  if [[ -n "$prior_sdk_digest" && "$build" == "true" ]]; then
    if [[ ! "$prior_sdk_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "prior_runtime_sdk_digest must be an immutable sha256:<64 hex> digest" >&2
      exit 64
    fi
    docker buildx imagetools inspect "${sdk_image}@${prior_sdk_digest}" >/dev/null
    dockerfile="${runtime_dockerfile}.incremental"
    [[ -f "$dockerfile" ]] || { echo "normal incremental recipe does not exist: $dockerfile" >&2; exit 64; }
    prior_image="${sdk_image}@${prior_sdk_digest}"
  fi
fi

{
  printf 'tag=%s\n' "$sdk_tag"
  printf 'build=%s\n' "$build"
  printf 'dockerfile=%s\n' "$dockerfile"
  printf 'prior_image=%s\n' "$prior_image"
  printf 'reused_inputs=%s\n' "$reused_inputs"
  printf 'image_ref=%s\n' "$image_ref"
} >>"$github_output"
