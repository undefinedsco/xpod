import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
QLEVER = ROOT / "qlever"
SDK_DOCKERFILE = ROOT / "docker/qlever-runtime-sdk/Dockerfile"
SDK_INCREMENTAL_DOCKERFILE = ROOT / "docker/qlever-runtime-sdk/Dockerfile.incremental"
BUILD_SCRIPT = QLEVER / "scripts/build-qlever-runtime-sdk.sh"
OVERLAY_MANIFEST = QLEVER / "scripts/runtime-overlay-manifest.py"
VALIDATE_PRIOR = QLEVER / "scripts/validate-prior-sdk.py"
WORKFLOW = ROOT / ".github/workflows/publish-qlever-runtime-sdk.yml"
DOCKERIGNORE = ROOT / ".dockerignore"


class QleverRuntimeSdkContractTest(unittest.TestCase):
    def test_public_qlever_sources_are_in_the_docker_build_context(self):
        patterns = DOCKERIGNORE.read_text(encoding="utf-8").splitlines()

        self.assertIn("!qlever/", patterns)

    def test_base_image_arg_is_visible_inside_the_build_stage(self):
        dockerfile = SDK_DOCKERFILE.read_text()
        self.assertRegex(
            dockerfile,
            r"FROM \$\{XPOD_QLEVER_SDK_BASE_IMAGE\} AS source-prepared\s+\n\s*ARG XPOD_QLEVER_SDK_BASE_IMAGE",
        )

    def test_sdk_image_builds_public_qlever_runtime_without_pg_components(self):
        self.assertTrue(SDK_DOCKERFILE.is_file(), SDK_DOCKERFILE)
        dockerfile = SDK_DOCKERFILE.read_text(encoding="utf-8")

        self.assertRegex(
            dockerfile.splitlines()[0],
            r"^# syntax=docker/dockerfile:1\.7@sha256:[a-f0-9]{64}$",
        )
        self.assertRegex(
            dockerfile,
            r"ARG XPOD_QLEVER_SDK_BASE_IMAGE=debian:trixie-[0-9]{8}-slim@sha256:[a-f0-9]{64}",
        )
        self.assertIn("XPOD_QLEVER_SDK_BASE_IMAGE must be an immutable digest reference", dockerfile)
        for required in [
            "clang-19",
            "cmake",
            "git",
            "libboost-container-dev",
            "libboost-iostreams-dev",
            "libboost-program-options-dev",
            "libboost-url-dev",
            "libicu-dev",
            "libssl-dev",
            "libzstd-dev",
            "lld-19",
            "python3",
        ]:
            with self.subTest(required=required):
                self.assertIn(required, dockerfile)
        for public_component in [
            "qlever/qlever.lock.json",
            "qlever/patches",
            "qlever/cmake",
            "qlever/qlever_adapter",
            "qlever/include",
            "qlever/rdf_protocol",
        ]:
            with self.subTest(public_component=public_component):
                self.assertIn(f"COPY {public_component}", dockerfile)
        self.assertIn("FROM source-prepared AS build", dockerfile)
        self.assertIn("XPOD_QLEVER_SDK_BASE_IMAGE=${XPOD_QLEVER_SDK_BASE_IMAGE}", dockerfile)
        self.assertIn("sdk-owned-runs.py sourcePrepare", dockerfile)
        self.assertIn("sdk-owned-runs.py build", dockerfile)
        inner = (QLEVER / "scripts/sdk-inner-materials.py").read_text()
        self.assertIn("scripts/build-qlever-runtime-sdk.sh", inner)
        self.assertIn("'configure-prepared'", inner)
        self.assertIn("'build-prepared'", inner)
        self.assertIn("/opt/qlever-sdk/source/src/libqlever/Qlever.h", dockerfile)
        self.assertIn("/opt/qlever-sdk/build/.xpod-build-identity", dockerfile)
        self.assertIn("/opt/qlever-sdk/build/CMakeFiles/qlever-server.dir/link.txt", dockerfile)
        self.assertIn("test -d /components/qlever/cmake", dockerfile)
        self.assertIn("COPY qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("sdk-owned-runs.py linked", dockerfile)
        registry = (QLEVER / "scripts/sdk-owned-runs.py").read_text()
        self.assertIn("install -y --no-install-recommends nodejs", registry)
        self.assertIn("RUN node --version", dockerfile)
        self.assertIn("FROM build AS linked-verification", dockerfile)
        self.assertIn("XPOD_QLEVER_CMAKE_C_COMPILER=clang-19", dockerfile)
        self.assertIn("XPOD_QLEVER_CMAKE_CXX_COMPILER=clang++-19", dockerfile)
        self.assertIn("COPY qlever/scripts/check-qlever-real-adapter-build.cjs", dockerfile)
        self.assertIn("FROM build AS runtime", dockerfile)
        self.assertNotIn("COPY --from=linked-verification /tmp/xpod-qlever-linked-verification.ok", dockerfile)
        self.assertNotIn("touch /tmp/xpod-qlever-linked-verification.ok", dockerfile)
        self.assertIn("COPY --from=linked-verification /opt/qlever-sdk/materials/linked-inner.json", dockerfile)
        self.assertIn("stages/test-adapter.raw.log", dockerfile)
        self.assertIn("stages/test-runtime.raw.log", dockerfile)
        self.assertIn("'test-adapter',['node'", inner)
        self.assertIn("'test-runtime',['node'", inner)
        self.assertIn("'--skip-prerequisites'", inner)
        self.assertIn("! command -v node", dockerfile)
        self.assertIn("test ! -e /components/qlever/qlever_pg_extension", dockerfile)
        self.assertIn("test ! -e /components/pg-rdf-extension", dockerfile)
        self.assertNotIn("postgresql-server-dev", dockerfile)
        self.assertNotIn("pg_config", dockerfile)
        self.assertNotIn("qlever_pg_extension", dockerfile.replace("test ! -e /components/qlever/qlever_pg_extension", ""))
        self.assertNotIn("pg-rdf-extension/xpod_rdf", dockerfile)

    def test_incremental_sdk_reuses_prior_digest_and_same_public_boundary(self):
        self.assertTrue(SDK_INCREMENTAL_DOCKERFILE.is_file(), SDK_INCREMENTAL_DOCKERFILE)
        dockerfile = SDK_INCREMENTAL_DOCKERFILE.read_text(encoding="utf-8")

        self.assertIn("ARG XPOD_QLEVER_PRIOR_SDK_IMAGE", dockerfile)
        self.assertIn("FROM ${XPOD_QLEVER_PRIOR_SDK_IMAGE}", dockerfile)
        self.assertIn("must be an immutable digest reference", dockerfile)
        self.assertIn("--bootstrap-missing-contract", dockerfile)
        self.assertIn("XPOD_QLEVER_INCREMENTAL_SDK=1", dockerfile)
        self.assertIn("bash /components/qlever/scripts/build-qlever-runtime-sdk.sh", dockerfile)
        self.assertIn("/opt/qlever-sdk/build/CMakeFiles/qlever-server.dir/link.txt", dockerfile)
        self.assertIn("COPY qlever/cmake /components/qlever/cmake", dockerfile)
        self.assertIn("COPY qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("test -d /components/qlever/cmake", dockerfile)
        self.assertIn("test -f /components/qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("FROM build AS linked-verification", dockerfile)
        self.assertIn("XPOD_QLEVER_CMAKE_C_COMPILER=clang-19", dockerfile)
        self.assertIn("XPOD_QLEVER_CMAKE_CXX_COMPILER=clang++-19", dockerfile)
        self.assertIn("apt-get install -y --no-install-recommends nodejs", dockerfile)
        self.assertIn("COPY qlever/scripts/check-qlever-real-adapter-build.cjs", dockerfile)
        self.assertIn("node /components/qlever/scripts/check-qlever-real-adapter-build.cjs", dockerfile)
        self.assertIn("node /components/qlever/scripts/check-qlever-real-runtime.cjs", dockerfile)
        self.assertIn("--qlever-source /opt/qlever-sdk/source", dockerfile)
        self.assertIn("--qlever-build-dir /opt/qlever-sdk/build", dockerfile)
        self.assertIn("--skip-prerequisites", dockerfile)
        self.assertIn("FROM build AS runtime", dockerfile)
        self.assertIn("COPY --from=linked-verification /tmp/xpod-qlever-linked-verification.ok", dockerfile)
        self.assertIn("! command -v node", dockerfile)
        self.assertIn("test ! -e /components/qlever/qlever_pg_extension", dockerfile)
        self.assertIn("test ! -e /components/pg-rdf-extension", dockerfile)
        self.assertNotIn("postgresql-server-dev", dockerfile)
        self.assertNotIn("pg-rdf-extension/xpod_rdf", dockerfile)

    def test_incremental_sdk_replaces_the_prior_component_tree_exactly(self):
        dockerfile = SDK_INCREMENTAL_DOCKERFILE.read_text(encoding="utf-8")
        validation = dockerfile.index("RUN python3 /tmp/validate-prior-sdk.py")
        replacement = dockerfile.index("RUN rm -rf /components/qlever")
        current_overlay = dockerfile.index(
            "COPY qlever/qlever.lock.json /components/qlever/qlever.lock.json"
        )

        self.assertLess(validation, replacement)
        self.assertLess(replacement, current_overlay)

    def test_verification_fixtures_do_not_invalidate_the_compiler_cache(self):
        verification_scripts = [
            "check-qlever-real-adapter-build.cjs",
            "check-qlever-real-runtime.cjs",
            "check-qlever-upstream-patches.cjs",
        ]

        for dockerfile_path in [SDK_DOCKERFILE, SDK_INCREMENTAL_DOCKERFILE]:
            with self.subTest(dockerfile=dockerfile_path.name):
                dockerfile = dockerfile_path.read_text(encoding="utf-8")
                prepared = dockerfile_path == SDK_DOCKERFILE
                build_index = dockerfile.index("sdk-owned-runs.py build" if prepared else
                    "RUN bash /components/qlever/scripts/build-qlever-runtime-sdk.sh")
                if prepared:
                    self.assertIn("COPY qlever/scripts/*.py qlever/scripts/*.sh /components/qlever/scripts/", dockerfile[:build_index])
                    self.assertNotIn("COPY qlever/scripts /", dockerfile[:build_index])
                verification_index = dockerfile.index("FROM build AS linked-verification")
                runtime_index = dockerfile.index("FROM build AS runtime")

                for script in verification_scripts:
                    source_copy = f"COPY qlever/scripts/{script}"
                    runtime_copy = (
                        "COPY --from=linked-verification "
                        f"/components/qlever/scripts/{script}"
                    )
                    self.assertGreater(dockerfile.index(source_copy), build_index)
                    self.assertGreater(dockerfile.index(source_copy), verification_index)
                    if prepared:
                        self.assertNotIn(runtime_copy, dockerfile)
                    else:
                        self.assertGreater(dockerfile.index(runtime_copy), runtime_index)

    def test_build_script_has_no_pg_extension_phase(self):
        self.assertTrue(BUILD_SCRIPT.is_file(), BUILD_SCRIPT)
        script = BUILD_SCRIPT.read_text(encoding="utf-8")

        self.assertIn('"component": "qlever-runtime-sdk"', script)
        self.assertIn("build-qlever-runtime-sdk", str(BUILD_SCRIPT))
        self.assertIn("apply-patches.py", script)
        self.assertIn("sync-patched-source.py", script)
        self.assertIn("runtime-overlay-manifest.py", script)
        self.assertIn("cmake --build \"$build_dir\" --target qlever-server", script)
        self.assertIn("CMakeFiles/qlever-server.dir/link.txt", script)
        self.assertIn("-DXPOD_QLEVER_ADAPTER_ENABLE_QLEVER=1", script)
        self.assertNotIn("pg_config", script)
        self.assertNotIn("postgresMajor", script)
        self.assertNotIn("qlever_pg_extension", script)
        self.assertNotIn("pg-rdf-extension", script)
        self.assertNotIn("xpod_qlever_pg_extension", script)

    def test_overlay_manifest_and_prior_validator_are_runtime_sdk_safe(self):
        self.assertTrue(OVERLAY_MANIFEST.is_file(), OVERLAY_MANIFEST)
        self.assertTrue(VALIDATE_PRIOR.is_file(), VALIDATE_PRIOR)
        overlay = OVERLAY_MANIFEST.read_text(encoding="utf-8")
        validator = VALIDATE_PRIOR.read_text(encoding="utf-8")

        self.assertIn('qlever_root / "qlever_adapter" / "src"', overlay)
        self.assertIn('qlever_root / "rdf_protocol" / "include"', overlay)
        self.assertIn('"component": "qlever-runtime-sdk"', validator)
        self.assertNotIn("postgresMajor", validator)
        self.assertNotIn("pgConfig", validator)
        self.assertNotIn("pg_config", validator)
        self.assertNotIn("maybe_tool_version", validator)

    def test_workflow_publishes_sdk_before_local_runtime_can_consume_digest(self):
        self.assertTrue(WORKFLOW.is_file(), WORKFLOW)
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("source_commit:", workflow)
        self.assertIn(
            "SDK_IMAGE: ghcr.io/${{ github.repository_owner }}/xpod-qlever-sdk",
            workflow,
        )
        self.assertIn("source_commit must be a 40-character lowercase commit SHA", workflow)
        self.assertIn("ref: ${{ steps.source.outputs.commit }}", workflow)
        self.assertIn("XPOD_SOURCE_COMMIT: ${{ steps.source.outputs.commit }}", workflow)
        self.assertIn("org.opencontainers.image.revision=${{ steps.source.outputs.commit }}", workflow)
        self.assertIn("runtime_sdk_tag:", workflow)
        self.assertIn("prior_runtime_sdk_digest:", workflow)
        self.assertIn("bash qlever/scripts/resolve-runtime-sdk-build.sh", workflow)
        self.assertIn("file: ${{ steps.resolve.outputs.dockerfile }}", workflow)
        self.assertIn("target: runtime", (ROOT / ".github/workflows/publish-qlever-local-runtime.yml").read_text(encoding="utf-8"))
        self.assertNotIn("docker push \"${tag}\"", workflow)
        self.assertIn("Push the tested SDK through BuildKit", workflow)
        self.assertIn("push: true", workflow)
        self.assertIn("[[ \"${digest}\" =~ ^sha256:[a-f0-9]{64}$ ]]", workflow)
        self.assertIn("test ! -e /components/qlever/qlever_pg_extension", workflow)
        self.assertIn("test -d /components/qlever/cmake", workflow)
        self.assertIn("test -f /components/qlever/scripts/check-qlever-real-runtime.cjs", workflow)
        self.assertIn("test -f /opt/qlever-sdk/build/CMakeFiles/qlever-server.dir/link.txt", workflow)
        self.assertIn("test ! -e /components/pg-rdf-extension", workflow)

        cache_prime = workflow.index("- name: Persist the runtime SDK compiler cache")
        runtime_build = workflow.index("- name: Build the exact runtime SDK image")
        self.assertLess(cache_prime, runtime_build)
        cache_prime_step = workflow[cache_prime:runtime_build]
        self.assertIn("target: build", cache_prime_step)
        self.assertIn("outputs: type=cacheonly", cache_prime_step)
        self.assertIn("cache-from: type=gha,scope=qlever-runtime-sdk", cache_prime_step)
        self.assertIn(
            "cache-to: type=gha,mode=max,scope=qlever-runtime-sdk",
            cache_prime_step,
        )

        self.assertIn("readonly_executor:", workflow)
        self.assertIn("readonly_publish:", workflow)
        self.assertIn("uses: ./.github/workflows/qlever-readonly-executor.yml", workflow)
        self.assertIn("inputs.readonly_executor", workflow)
        callee = (ROOT / ".github/workflows/qlever-readonly-executor.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_call:", callee)
        self.assertIn("publish:", callee)
        self.assertIn("qlever-readonly-normal-job.yml", callee)
        actions = [line for line in workflow.splitlines() if "uses:" in line]
        self.assertGreater(len(actions), 0)
        for line in actions:
            reference = line.split("uses:", 1)[1].strip()
            if reference.startswith("./"):
                self.assertIn(reference, {
                    "./.github/workflows/resolve-qlever-native-target.yml",
                    "./.github/workflows/build-qlever-linux-runtime.yml",
                    "./.github/workflows/qlever-readonly-executor.yml",
                })
                self.assertTrue((ROOT / reference).is_file())
                continue
            revision = line.split("@", 1)[1].split()[0]
            self.assertRegex(revision, r"^[a-f0-9]{40}$")

    def test_workflow_rejects_invalid_runtime_fixtures_before_buildx(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        fixture_gate = workflow.index("Verify runtime SDK source and fixture contracts")
        buildx = workflow.index("Set up Docker Buildx")

        for command in [
            "python3 qlever/scripts/verify-lock.py",
            "qlever/tests/QleverInternalSortIdentityContract.test.ts",
            "qlever/tests/QleverUpstream*Patch.test.ts",
            "qlever/tests/QleverNativeSemanticShapes.test.ts",
            "qlever/tests/QleverIdCodec.test.ts",
            "qlever/tests/QleverPhysicalBackendFacade.test.ts",
            "qlever/tests/QleverPhysicalTermSyntax.test.ts",
            "qlever/tests/QleverRealRuntimeBuildScript.test.ts",
        ]:
            with self.subTest(command=command):
                self.assertIn(command, workflow)
                self.assertLess(fixture_gate, workflow.index(command))
                self.assertLess(workflow.index(command), buildx)


class CompilerIntermediateRetention(unittest.TestCase):
    """Configure must retain the compiler-generated intermediates it observes.

    Real defect this pins: during the traced `configure` phase the observer holds
    a real kernel read lease on every regular file a compiler child reads, for the
    whole phase. The compiler driver's default behaviour is to emit the join
    object for a compile+link as a RANDOM temporary and then unlink it, and CMake's
    try_compile probes delete their working directories. Either unlink moves an
    already-leased inode's ctime, so the lease guard correctly rejects it
    (observed in CI as a `CMakeCCompilerId-<hex>.o`).

    These cases exercise the ACTUAL shipped shell array: the `cmake_command=( … )`
    block is extracted and **evaluated by bash** with its referenced variables
    supplied, so the assertions are on the argv the producer really builds. When a
    real CMake is present the argv is additionally executed against a minimal
    C+CXX project and the produced intermediates are inspected. No list is
    reimplemented here.
    """

    SCRIPT = BUILD_SCRIPT

    @staticmethod
    def _bash(argv, check=True):
        return subprocess.run(['bash'] + argv, capture_output=True, text=True, timeout=120, check=check)

    def _emit_cmake_argv(self):
        """Evaluate the REAL `cmake_command=(...)` assignment in bash and return argv."""
        programme = r"""
set -Eeuo pipefail
script="$1"
start=$(grep -n '^  cmake_command=(cmake \\$' "$script" | head -1 | cut -d: -f1)
[ -n "$start" ] || { echo 'NO-CMAKE-COMMAND' >&2; exit 3; }
end=$(awk -v s="$start" 'NR>s && /\)$/ {print NR; exit}' "$script")
[ -n "$end" ] || { echo 'NO-CMAKE-END' >&2; exit 3; }
source_dir=/src; build_dir=/build
adapter_flags='-DADAPTER=1'
archive_create='C'; archive_append='A'; archive_finish='F'
block=$(sed -n "${start},${end}p" "$script")
eval "$block"
printf '%s\n' "${cmake_command[@]}"
"""
        result = self._bash(['-c', programme, 'emit', str(self.SCRIPT)])
        return result.stdout.splitlines()

    def test_real_shell_array_emits_retention_flags(self):
        """The ACTUAL bash assignment must expand to argv containing the levers."""
        argv = self._emit_cmake_argv()
        self.assertTrue(argv, 'the real cmake_command array must expand to argv')
        self.assertEqual(argv[0], 'cmake')
        # broad try_compile retention
        self.assertIn('--debug-trycompile', argv)
        # ID-probe-scoped object retention, as separate -D flags
        self.assertIn('-DCMAKE_C_COMPILER_ID_TEST_FLAGS_FIRST=-save-temps=obj', argv)
        self.assertIn('-DCMAKE_CXX_COMPILER_ID_TEST_FLAGS_FIRST=-save-temps=obj', argv)
        # still a real configure invocation
        self.assertIn('-G', argv)
        self.assertIn('Ninja', argv)
        self.assertIn('-B', argv)

    def test_no_global_save_temps_and_no_identity_presets_in_argv(self):
        argv = self._emit_cmake_argv()
        joined = ' '.join(argv)
        # no global save-temps: only the two ID-scoped flags carry it
        save_temps = [a for a in argv if 'save-temps' in a]
        self.assertEqual(len(save_temps), 2, save_temps)
        for flag in save_temps:
            self.assertIn('COMPILER_ID_TEST_FLAGS_FIRST', flag)
        self.assertNotIn('CMAKE_C_FLAGS=-save-temps', joined)
        self.assertNotIn('CMAKE_CXX_FLAGS=-save-temps', joined)
        self.assertNotIn('COMPILER_ID_FLAGS=', joined)
        # no faked identity / skipped probe
        for forbidden in ('CMAKE_C_COMPILER_ID=', 'CMAKE_CXX_COMPILER_ID=', 'CMAKE_C_COMPILER_WORKS='):
            self.assertNotIn(forbidden, joined)

    def test_no_legacy_tmpdir_alias_in_argv_or_body(self):
        """TMPDIR relocation was falsified; it must not reappear as a lever."""
        argv = self._emit_cmake_argv()
        joined = ' '.join(argv)
        self.assertNotIn('TMPDIR', joined)
        body = self.SCRIPT.read_text(encoding='utf-8')
        self.assertNotIn('export TMPDIR=', body)
        self.assertNotIn('export TMP=', body)
        self.assertNotIn('export TEMP=', body)

    def test_real_cmake_run_retains_identification_intermediates_and_builds(self):
        """Run the ACTUAL argv shape against a minimal C+CXX project.

        Locally CMake is absent, so this skips with an explicit reason. It is
        intended to run on ROOT's cached Linux CMake 3.31.6 image, where it
        asserts real compiler detection AND that identification intermediates
        survive configure, plus that compile_commands is still produced.
        """
        cmake = shutil.which('cmake')
        cc = shutil.which('clang') or shutil.which('gcc')
        cxx = shutil.which('clang++') or shutil.which('g++')
        if not cmake or not cc or not cxx:
            self.skipTest('real CMake/C/CXX unavailable on this host; ROOT Linux runs this')
        import tempfile
        test_data = ROOT / '.test-data' / 'compiler-intermediate-retention'
        test_data.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=test_data) as directory:
            root = Path(directory)
            (root / 'CMakeLists.txt').write_text(
                'cmake_minimum_required(VERSION 3.16)\n'
                'project(minimal C CXX)\n'
                'add_executable(minimal main.cxx)\n', encoding='utf-8')
            (root / 'main.cxx').write_text('int main(){return 0;}\n', encoding='utf-8')
            (root / 'main.c').write_text('int unused_c(void){return 0;}\n', encoding='utf-8')
            build = root / 'build'
            argv = self._emit_cmake_argv()
            # Translate the producer's paths onto this minimal project.
            translated = []
            skip_next = False
            for i, a in enumerate(argv):
                if skip_next:
                    skip_next = False
                    continue
                if a == '-S':
                    translated.extend(['-S', str(root)]); skip_next = True; continue
                if a == '-B':
                    translated.extend(['-B', str(build)]); skip_next = True; continue
                if a.startswith('-DXPOD_') or a.startswith('-DUSE_') or a.startswith('-DRANGES_') \
                        or a.startswith('-DCHEAPER_') or a.startswith('-DCMAKE_CXX_COMPILER_LAUNCHER') \
                        or a.startswith('-DADAPTER=') or a.startswith('-DCMAKE_C_ARCHIVE') \
                        or a.startswith('-DCMAKE_CXX_ARCHIVE') or a.startswith('-DCMAKE_POSITION_INDEPENDENT'):
                    continue
                translated.append(a)
            run = subprocess.run(translated, cwd=str(root), capture_output=True, text=True, timeout=600)
            self.assertEqual(run.returncode, 0, run.stderr[-2000:])
            # real compiler identification must have happened
            cache = (build / 'CMakeCache.txt').read_text(encoding='utf-8', errors='replace')
            self.assertRegex(cache, r'CMAKE_CXX_COMPILER:FILEPATH=.+')
            self.assertRegex(cache, r'CMAKE_C_COMPILER:FILEPATH=.+')
            self.assertNotRegex(cache, r'CMAKE_CXX_COMPILER_ID:.*=.*fake')
            # a real build still works with the retained intermediates around
            built = subprocess.run(['cmake', '--build', str(build)],
                                   capture_output=True, text=True, timeout=600)
            self.assertEqual(built.returncode, 0, built.stderr[-2000:])
            # compile_commands is produced (no global save-temps interference)
            import json
            commands = json.loads((build / 'compile_commands.json').read_text(encoding='utf-8'))
            self.assertTrue(commands)
            for command in commands:
                self.assertNotIn('save-temps', command.get('command', ''))
                self.assertFalse(any('save-temps' in arg for arg in command.get('arguments', [])))
            # The generated .c source survives even without retention: require
            # the actual compiler-generated objects for BOTH language probes.
            compiler_id_objects = list(build.rglob('*CompilerId*.o'))
            for language in ('C', 'CXX'):
                self.assertTrue(any(p.parent.name == 'CompilerId' + language for p in compiler_id_objects),
                                language + ' compiler-identification object must survive configure')
            self.assertTrue(list((build / 'CMakeFiles' / 'CMakeScratch').glob('TryCompile-*')),
                            'ABI try_compile directories must survive the observed configure phase')
            executable = build / 'minimal'
            if not executable.is_file():
                executable = executable.with_suffix('.exe')
            self.assertEqual(subprocess.run([str(executable)], capture_output=True, timeout=120).returncode, 0)


if __name__ == "__main__":
    unittest.main()
