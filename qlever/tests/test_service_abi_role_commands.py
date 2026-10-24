"""Unit tests for the pure service ABI role Docker command constructor."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sdk-service-abi-role-commands.py"
_SPEC = importlib.util.spec_from_file_location("sdk_service_abi_role_commands", _SCRIPT)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - defensive
    raise RuntimeError("cannot load " + str(_SCRIPT))
commands = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = commands
_SPEC.loader.exec_module(commands)

IMAGE = "ghcr.io/undefinedsco/xpod@sha256:" + "a" * 64
NONCE = "0123456789abcdef0123456789abcdef"
CID = "f" * 64
PROBE = "/tmp/sdk-service-abi-role-probe.mjs"

BUN_ROLES = ("bun-node-addon", "bun-sqlite-extension")
ROLES = ("bun-node-addon", "bun-sqlite-extension", "inngest-cli")
OPERATIONS = ("create", "inspect", "start", "wait", "remove", "absent", "recover")

ISOLATION = (
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


_DEFAULT_PROBE = object()


def create_cmd(role, probe=_DEFAULT_PROBE, image=IMAGE, nonce=NONCE):
    if probe is _DEFAULT_PROBE:
        probe = PROBE
    return commands.command(role, "create", image=image, nonce=nonce, probe=probe)


def cid_cmd(role, operation, cid=CID, image=IMAGE, nonce=NONCE):
    return commands.command(role, operation, image=image, nonce=nonce, cid=cid)


class RolesAndOperationsTest(unittest.TestCase):
    def test_roles_exact(self):
        self.assertEqual(tuple(commands.ROLES), ROLES)

    def test_operations_exact(self):
        self.assertEqual(tuple(commands.OPERATIONS), OPERATIONS)

    def test_unknown_role_rejected_for_every_operation(self):
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                with self.assertRaises(ValueError):
                    commands.command(
                        "qlever-collector",
                        operation,
                        image=IMAGE,
                        nonce=NONCE,
                        cid=None if operation in ("create","recover") else CID,
                        probe=PROBE if operation == "create" else None,
                    )

    def test_role_is_exact_and_case_sensitive(self):
        for role in ("Bun-node-addon", "bun-node-addon ", "", "inngest"):
            with self.subTest(role=role):
                with self.assertRaises(ValueError):
                    create_cmd(role)

    def test_unknown_operation_rejected(self):
        for operation in ("exec", "logs", "CREATE", "", "kill"):
            with self.subTest(operation=operation):
                with self.assertRaises(ValueError):
                    commands.command(
                        "bun-node-addon", operation, image=IMAGE, nonce=NONCE, probe=PROBE
                    )


class ImageIdentityTest(unittest.TestCase):
    def test_accepts_immutable_digest(self):
        cmd = create_cmd("bun-node-addon")
        self.assertIn(IMAGE, cmd)

    def test_rejects_malformed_images(self):
        cases = (
            "ghcr.io/undefinedsco/xpod:latest",
            "ghcr.io/undefinedsco/xpod@sha256:" + "A" * 64,
            "ghcr.io/undefinedsco/xpod@sha256:" + "a" * 63,
            "ghcr.io/undefinedsco/xpod@sha256:" + "a" * 65,
            "ghcr.io/undefinedsco/xpod@sha256:" + "g" * 64,
            "ghcr.io/undefinedsco/xpod@md5:" + "a" * 64,
            "docker.io/undefinedsco/xpod@sha256:" + "a" * 64,
            "ghcr.io/undefinedsco/xpod@sha256:" + "a" * 64 + "\n",
            "",
        )
        for image in cases:
            with self.subTest(image=image):
                with self.assertRaises(ValueError):
                    commands.command(
                        "bun-node-addon", "create", image=image, nonce=NONCE, probe=PROBE
                    )

    def test_rejects_non_string_image(self):
        for image in (None, 1, ["x"]):
            with self.subTest(image=image):
                with self.assertRaises(ValueError):
                    commands.command(
                        "bun-node-addon", "create", image=image, nonce=NONCE, probe=PROBE
                    )


class NonceTest(unittest.TestCase):
    def test_accepts_32_lower_hex(self):
        cmd = create_cmd("bun-node-addon", nonce=NONCE)
        self.assertIn("xpod-service-abi-bun-node-addon-" + NONCE, cmd)

    def test_rejects_malformed_nonces(self):
        cases = (
            NONCE[:-1],
            NONCE + "0",
            NONCE.upper(),
            "0" * 31 + "g",
            "",
            " " + NONCE,
            NONCE + "\x00",
            None,
            123,
        )
        for nonce in cases:
            with self.subTest(nonce=nonce):
                with self.assertRaises(ValueError):
                    create_cmd("bun-node-addon", nonce=nonce)


class CidTest(unittest.TestCase):
    def test_accepts_full_64_hex_cid(self):
        self.assertEqual(cid_cmd("inngest-cli", "wait"), ["docker", "wait", CID])

    def test_rejects_malformed_cids(self):
        cases = (
            CID[:-1],
            CID + "0",
            "f" * 12,
            CID.upper(),
            "f" * 63 + "g",
            "",
            " " + CID,
            CID + "\n",
            None,
            0,
        )
        for operation in ("inspect", "start", "wait", "remove", "absent"):
            for cid in cases:
                with self.subTest(operation=operation, cid=cid):
                    with self.assertRaises(ValueError):
                        commands.command(
                            "bun-node-addon", operation, image=IMAGE, nonce=NONCE, cid=cid
                        )

    def test_recovery_is_exact_source_owner_and_rejects_caller_cid(self):
        command=commands.command("inngest-cli","recover",image=IMAGE,nonce=NONCE)
        self.assertIn("--no-trunc",command)
        self.assertIn("name=^/xpod-service-abi-inngest-cli-"+NONCE+"$",command)
        self.assertIn("label=org.xpod.service-abi-owner="+NONCE,command)
        self.assertIn("label=org.xpod.service-abi-role=inngest-cli",command)
        with self.assertRaises(ValueError):
            commands.command("inngest-cli","recover",image=IMAGE,nonce=NONCE,cid=CID)

    def test_other_operations_require_cid(self):
        for operation in ("inspect", "start", "wait", "remove", "absent"):
            with self.subTest(operation=operation):
                with self.assertRaises(ValueError):
                    commands.command("bun-node-addon", operation, image=IMAGE, nonce=NONCE)

    def test_create_rejects_cid(self):
        with self.assertRaises(ValueError):
            commands.command(
                "bun-node-addon",
                "create",
                image=IMAGE,
                nonce=NONCE,
                cid=CID,
                probe=PROBE,
            )


class CreateCommandTest(unittest.TestCase):
    def test_bun_role_create_is_exact(self):
        self.assertEqual(
            create_cmd("bun-node-addon"),
            [
                "docker", "create",
                "--name", "xpod-service-abi-bun-node-addon-" + NONCE,
                "--label", "org.xpod.service-abi-owner=" + NONCE,
                "--label", "org.xpod.service-abi-role=bun-node-addon",
                *ISOLATION,
                "--mount", "type=bind,src=" + PROBE + ",dst=/probe.mjs,readonly",
                "--entrypoint", "/usr/local/bin/bun",
                IMAGE, "/probe.mjs", "bun-node-addon", NONCE,
            ],
        )

    def test_every_role_create_is_exact(self):
        for role in ROLES:
            with self.subTest(role=role):
                cmd = create_cmd(role)
                self.assertEqual(cmd[:2], ["docker", "create"])
                self.assertEqual(cmd[2:4], ["--name", "xpod-service-abi-" + role + "-" + NONCE])
                self.assertEqual(cmd[4:8], [
                    "--label", "org.xpod.service-abi-owner=" + NONCE,
                    "--label", "org.xpod.service-abi-role=" + role,
                ])
                self.assertEqual(cmd[8:8 + len(ISOLATION)], list(ISOLATION))
                self.assertEqual(cmd.count(IMAGE), 1)
                self.assertIn("org.xpod.service-abi-role=" + role, cmd)

    def test_create_has_no_shell_or_execution_tokens(self):
        for role in ROLES:
            with self.subTest(role=role):
                cmd = create_cmd(role)
                self.assertNotIn("sh", cmd)
                self.assertNotIn("bash", cmd)
                self.assertNotIn("exec", cmd)
                self.assertNotIn("&", cmd)
                self.assertNotIn(";", cmd)
                self.assertTrue(all(isinstance(part, str) for part in cmd))

    def test_bun_roles_mount_probe_and_use_bun_entrypoint(self):
        for role in ROLES:
            with self.subTest(role=role):
                cmd = create_cmd(role)
                mount_index = cmd.index("--mount")
                self.assertEqual(
                    cmd[mount_index + 1],
                    "type=bind,src=" + PROBE + ",dst=/probe.mjs,readonly",
                )
                entry_index = cmd.index("--entrypoint")
                self.assertEqual(cmd[entry_index + 1], "/usr/local/bin/bun")
                tail = cmd[entry_index + 2:]
                self.assertEqual(tail, [IMAGE, "/probe.mjs", role, NONCE])

    def test_inngest_uses_same_owned_handshake_probe(self):
        cmd = create_cmd("inngest-cli")
        self.assertEqual(cmd[-6:], ["--entrypoint", "/usr/local/bin/bun", IMAGE,
                                  "/probe.mjs", "inngest-cli", NONCE])
        self.assertEqual(cmd[cmd.index("--mount")+1], "type=bind,src="+PROBE+",dst=/probe.mjs,readonly")

    def test_inngest_missing_probe_is_rejected(self):
        with self.assertRaises(ValueError):
            create_cmd("inngest-cli", probe=None)

    def test_bun_roles_require_probe(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaises(ValueError):
                    create_cmd(role, probe=None)


class ProbePathTest(unittest.TestCase):
    def test_accepts_canonical_absolute_path(self):
        cmd = create_cmd("bun-sqlite-extension", probe="/var/lib/xpod/" + commands.PROBE_BASENAME)
        self.assertIn(
            "type=bind,src=/var/lib/xpod/" + commands.PROBE_BASENAME + ",dst=/probe.mjs,readonly",
            cmd,
        )

    def test_rejects_wrong_basename(self):
        for probe in ("/tmp/probe.mjs", "/tmp/sdk-service-abi-role-probe.js", "/tmp/"):
            with self.subTest(probe=probe):
                with self.assertRaises(ValueError):
                    create_cmd("bun-node-addon", probe=probe)

    def test_rejects_relative_and_non_canonical_paths(self):
        for probe in (
            "",
            "tmp/" + commands.PROBE_BASENAME,
            "./" + commands.PROBE_BASENAME,
            "/tmp/../tmp/" + commands.PROBE_BASENAME,
            "/tmp/./" + commands.PROBE_BASENAME,
            "/tmp//" + commands.PROBE_BASENAME,
            "/tmp/" + commands.PROBE_BASENAME + "/",
            "//tmp/" + commands.PROBE_BASENAME,
        ):
            with self.subTest(probe=probe):
                with self.assertRaises(ValueError):
                    create_cmd("bun-node-addon", probe=probe)

    def test_rejects_comma_and_control_characters(self):
        for probe in (
            "/tmp/probe," + commands.PROBE_BASENAME,
            "/tmp/" + commands.PROBE_BASENAME + "\n",
            "/tmp/\x00" + commands.PROBE_BASENAME,
            "/tmp/\x7f" + commands.PROBE_BASENAME,
            "/tmp/\t" + commands.PROBE_BASENAME,
        ):
            with self.subTest(probe=probe):
                with self.assertRaises(ValueError):
                    create_cmd("bun-node-addon", probe=probe)

    def test_rejects_non_string_probe(self):
        for probe in (1, Path(PROBE), ["x"]):
            with self.subTest(probe=probe):
                with self.assertRaises(ValueError):
                    create_cmd("bun-node-addon", probe=probe)

    def test_rejects_dot_components_anywhere(self):
        for probe in (
            "/tmp/.." + commands.PROBE_BASENAME,
            "/tmp/." + commands.PROBE_BASENAME,
            "/../tmp/" + commands.PROBE_BASENAME,
        ):
            with self.subTest(probe=probe):
                with self.assertRaises(ValueError):
                    create_cmd("bun-node-addon", probe=probe)


class CidOperationCommandTest(unittest.TestCase):
    def test_inspect_exact_for_every_role(self):
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(cid_cmd(role, "inspect"), ["docker", "inspect", CID])

    def test_start_exact(self):
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    cid_cmd(role, "start"),
                    ["docker", "start", "--attach", "--interactive", CID],
                )

    def test_wait_exact(self):
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(cid_cmd(role, "wait"), ["docker", "wait", CID])

    def test_remove_exact(self):
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(cid_cmd(role, "remove"), ["docker", "rm", "-f", CID])

    def test_absent_exact(self):
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    cid_cmd(role, "absent"),
                    ["docker", "ps", "-a", "--filter", "id=" + CID, "--format", "{{.ID}}"],
                )

    def test_cid_operations_reject_probe(self):
        for role in ROLES:
            for operation in ("inspect", "start", "wait", "remove", "absent"):
                with self.subTest(role=role, operation=operation):
                    with self.assertRaises(ValueError):
                        commands.command(
                            role,
                            operation,
                            image=IMAGE,
                            nonce=NONCE,
                            cid=CID,
                            probe=PROBE,
                        )

    def test_operations_stay_deterministic_across_calls(self):
        for role in ROLES:
            with self.subTest(role=role):
                for operation in ("inspect", "start", "wait", "remove", "absent"):
                    first = cid_cmd(role, operation)
                    second = cid_cmd(role, operation)
                    self.assertEqual(first, second)
                    self.assertIsNot(first, second)
                    first.append("mutated")
                    self.assertEqual(cid_cmd(role, operation), second)


class FixedIsolationTest(unittest.TestCase):
    def test_isolation_flags_present_for_every_role(self):
        for role in ROLES:
            with self.subTest(role=role):
                cmd = create_cmd(role, probe=PROBE)
                for token in ISOLATION:
                    self.assertIn(token, cmd)

    def test_no_capability_added_or_privileged(self):
        forbidden = (
            "--privileged",
            "--cap-add",
            "--pid=host",
            "--network=host",
            "--userns=host",
            "--device",
            "--volume",
            "-v",
        )
        for role in ROLES:
            with self.subTest(role=role):
                cmd = create_cmd(role, probe=PROBE)
                for token in forbidden:
                    self.assertNotIn(token, cmd)

    def test_only_two_tmpfs_and_one_mount(self):
        for role in ROLES:
            with self.subTest(role=role):
                cmd = create_cmd(role, probe=PROBE)
                self.assertEqual(cmd.count("--tmpfs"), 2)
                self.assertEqual(cmd.count("--network"), 1)
                self.assertEqual(cmd.count("--read-only"), 1)
                self.assertEqual(cmd.count("--cap-drop"), 1)
                self.assertEqual(cmd.count("--security-opt"), 1)
                self.assertEqual(cmd.count("--mount"), 1)

    def test_create_replays_identically_for_same_inputs(self):
        for role in ROLES:
            with self.subTest(role=role):
                first = create_cmd(role)
                second = create_cmd(role)
                self.assertEqual(first, second)
                self.assertIsNot(first, second)
                first.clear()
                self.assertEqual(create_cmd(role), second)

    def test_module_has_no_execution_surface(self):
        source = _SCRIPT.read_text(encoding="utf-8")
        for token in ("subprocess", "os.system", "os.exec", "os.spawn", "eval(", "exec("):
            with self.subTest(token=token):
                self.assertNotIn(token, source)

    def test_name_and_labels_derive_from_role_and_nonce(self):
        cmd = create_cmd("inngest-cli", probe=PROBE)
        self.assertEqual(cmd[3], "xpod-service-abi-inngest-cli-" + NONCE)
        self.assertEqual(cmd[5], "org.xpod.service-abi-owner=" + NONCE)
        self.assertEqual(cmd[7], "org.xpod.service-abi-role=inngest-cli")


if __name__ == "__main__":
    unittest.main()
