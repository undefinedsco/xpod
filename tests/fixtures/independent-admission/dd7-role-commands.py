"""Pure Docker command constructor for the xpod service ABI role harness.

This module only builds argument vectors.  It performs no I/O, imports no
process API, never invokes Docker, and carries no issuing authority.

``probe`` validation here is deliberately lexical and pure.  A caller that
holds the source file must separately resolve symlinks and verify that the
resolved path is the regular file it intends to mount before passing it in.
"""

from __future__ import annotations

import re

ROLES = (
    "bun-node-addon",
    "bun-sqlite-extension",
    "inngest-cli",
)
OPERATIONS = ("create", "inspect", "start", "wait", "remove", "absent", "recover")

PROBE_BASENAME = "sdk-service-abi-role-probe.mjs"

_IMAGE_RE = re.compile(r"ghcr\.io/undefinedsco/xpod@sha256:[0-9a-f]{64}")
_NONCE_RE = re.compile(r"[0-9a-f]{32}")
_CID_RE = re.compile(r"[0-9a-f]{64}")

_BUN_ROLES = frozenset(("bun-node-addon", "bun-sqlite-extension"))
_BUN_ENTRYPOINT = "/usr/local/bin/bun"
_INNGEST_ENTRYPOINT = "/app/node_modules/inngest-cli/bin/inngest"

_CREATE_PREFIX = (
    "docker",
    "create",
)

_ISOLATION_ARGS = (
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--init",
    "--pids-limit",
    "64",
    "--memory",
    "536870912",
    "--cpus",
    "1",
    "--restart",
    "no",
    "--interactive",
    "--tmpfs",
    "/scratch:rw,noexec,nosuid,nodev,size=8388608,mode=0700",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=0700",
)


def _require_image(image: object) -> str:
    if not isinstance(image, str) or _IMAGE_RE.fullmatch(image) is None:
        raise ValueError(
            "image must be the immutable "
            "ghcr.io/undefinedsco/xpod@sha256:<64 lowercase hex> reference"
        )
    return image


def _require_nonce(nonce: object) -> str:
    if not isinstance(nonce, str) or _NONCE_RE.fullmatch(nonce) is None:
        raise ValueError("nonce must be exactly 32 lowercase hex characters")
    return nonce


def _require_cid(cid: object) -> str:
    if not isinstance(cid, str) or _CID_RE.fullmatch(cid) is None:
        raise ValueError("cid must be exactly 64 lowercase hex characters")
    return cid


def _require_role(role: object) -> str:
    if not isinstance(role, str) or role not in ROLES:
        raise ValueError("role is not a supported service ABI role")
    return role


def _require_operation(operation: object) -> str:
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise ValueError("operation is not a supported service ABI operation")
    return operation


def _require_probe(probe: object) -> str:
    """Validate a canonical, absolute, lexically normalized probe path.

    Commas and control characters are rejected because the value is embedded
    in a Docker ``--mount`` argument.  Dot components, duplicate separators,
    trailing separators, relative paths, and any basename other than the fixed
    probe basename are rejected as well.  Symlink resolution is intentionally
    the caller's responsibility.
    """
    if not isinstance(probe, str) or not probe:
        raise ValueError("probe must be a canonical absolute probe path")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in probe):
        raise ValueError("probe must not contain control characters")
    if "," in probe:
        raise ValueError("probe must not contain a comma")
    if not probe.startswith("/") or probe.startswith("//") or probe.endswith("/"):
        raise ValueError("probe must be a canonical absolute path")

    parts = probe.split("/")
    if any(part in ("", ".", "..") for part in parts[1:]):
        raise ValueError("probe must not contain '.' or '..' path components")
    if parts[-1] != PROBE_BASENAME:
        raise ValueError("probe basename must be " + PROBE_BASENAME)
    return probe


def _name(role: str, nonce: str) -> str:
    return "xpod-service-abi-" + role + "-" + nonce


def _create(role: str, image: str, nonce: str, probe: object) -> list[str]:
    probe_path = _require_probe(probe)
    # All roles use the same finite source-bound handshake. For Inngest the
    # probe owns and waits for the real product child, whose PID is observed.
    role_args = ["--mount", "type=bind,src=" + probe_path + ",dst=/probe.mjs,readonly",
                 "--entrypoint", _BUN_ENTRYPOINT, image, "/probe.mjs", role, nonce]

    return [
        *_CREATE_PREFIX,
        "--name",
        _name(role, nonce),
        "--label",
        "org.xpod.service-abi-owner=" + nonce,
        "--label",
        "org.xpod.service-abi-role=" + role,
        *_ISOLATION_ARGS,
        *role_args,
    ]


def command(
    role: str,
    operation: str,
    *,
    image: str,
    nonce: str,
    cid: str | None = None,
    probe: str | None = None,
) -> list[str]:
    """Return the exact Docker argument vector for a role operation.

    ``create`` accepts no ``cid``.  Every other operation requires a full
    container id and accepts no ``probe``.  The returned list is freshly
    allocated on every call, so callers cannot mutate future commands through
    a previous result.
    """
    role = _require_role(role)
    operation = _require_operation(operation)
    image = _require_image(image)
    nonce = _require_nonce(nonce)

    if operation == "recover":
        if cid is not None or probe is not None:
            raise ValueError("recovery takes only exact source role/name/nonce")
        return ["docker", "ps", "-a", "--no-trunc", "--filter", "name=^/"+_name(role,nonce)+"$",
                "--filter", "label=org.xpod.service-abi-owner="+nonce,
                "--filter", "label=org.xpod.service-abi-role="+role, "--format", "{{.ID}}"]

    if operation == "create":
        if cid is not None:
            raise ValueError("create does not accept a cid")
        return _create(role, image, nonce, probe)

    if probe is not None:
        raise ValueError("only create accepts a probe")
    container_id = _require_cid(cid)

    if operation == "inspect":
        return ["docker", "inspect", container_id]
    if operation == "start":
        return ["docker", "start", "--attach", "--interactive", container_id]
    if operation == "wait":
        return ["docker", "wait", container_id]
    if operation == "remove":
        return ["docker", "rm", "-f", container_id]
    return [
        "docker",
        "ps",
        "-a",
        "--filter",
        "id=" + container_id,
        "--format",
        "{{.ID}}",
    ]
