import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const dockerfilePath = path.join(repoRoot, 'docker/qlever-local-runtime/Dockerfile');
const verifierPath = path.join(
  repoRoot,
  'qlever/scripts/verify-local-runtime-artifacts.py',
);
const focusedBuildPath = path.join(
  repoRoot,
  'qlever/scripts/run-focused-native-build.sh',
);
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/publish-qlever-local-runtime.yml',
);
const imageRunnerPath = path.join(repoRoot, 'scripts/run-qlever-local-runtime-image.sh');

function stageBody(dockerfile: string, stage: string): string {
  const match = dockerfile.match(
    new RegExp('FROM [^\\n]+ AS ' + stage + '\\n([\\s\\S]*?)(?=\\nFROM |$)'),
  );
  expect(match, 'missing Docker stage ' + stage).not.toBeNull();
  return match![1];
}

describe('QLever local runtime image contract', () => {
  it('builds only the local bridge from an immutable prior runtime SDK', () => {
    expect(existsSync(dockerfilePath)).toBe(true);
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const build = stageBody(dockerfile, 'build');

    expect(dockerfile).toMatch(
      /^# syntax=docker\/dockerfile:1\.7@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).toContain('ARG XPOD_QLEVER_PRIOR_SDK_IMAGE');
    expect(dockerfile).toContain('FROM ${XPOD_QLEVER_PRIOR_SDK_IMAGE} AS build');
    expect(build).toContain("grep -Eq '^.+@sha256:[0-9a-f]{64}$'");
    expect(build).toContain('must be an immutable digest reference');
    expect(build).toContain('COPY qlever/patches /workspace/xpod/qlever/patches');
    expect(build).toContain('COPY qlever/scripts /workspace/xpod/qlever/scripts');
    expect(build).toContain('XPOD_QLEVER_WORKSPACE_ROOT=/workspace/xpod');
    expect(build).toContain('XPOD_QLEVER_BUILD_OUTPUT_DIR=/opt/xpod');
    expect(build).toContain(
      'bash /workspace/xpod/qlever/scripts/run-focused-native-build.sh',
    );
    expect(build).not.toContain('build-pg17.sh');
    expect(build).not.toContain('cmake --build');
    expect(build).not.toContain('subprocess.Popen');
    expect(build).not.toContain("RUN python3 -");
    expect(build).not.toContain("<<'PY'");
  });

  it('fails the focused build before compile when the prior SDK overlay is stale', () => {
    expect(existsSync(focusedBuildPath)).toBe(true);
    const script = readFileSync(focusedBuildPath, 'utf8');

    expect(script).toContain('.xpod-overlay-identity');
    expect(script).toContain('runtime-overlay-manifest.py');
    expect(script).toContain('--qlever-root "$workspace_root/qlever"');
    expect(script).toContain('sha256sum');
    expect(script).toContain('prior SDK overlay identity mismatch');
    expect(script).toContain(
      'rebuild the runtime SDK incrementally before focused local runtime build',
    );
    expect(script.indexOf('prior SDK overlay identity mismatch')).toBeLessThan(
      script.indexOf('dependency_includes=$(python3 -c'),
    );
  });

  it('ships only runtime artifacts and glibc dependencies on pinned Debian slim', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeBase = stageBody(dockerfile, 'runtime-base');
    const runtime = stageBody(dockerfile, 'runtime');

    expect(dockerfile).toMatch(
      /ARG XPOD_QLEVER_RUNTIME_BASE_IMAGE=debian:trixie-[0-9]{8}-slim@sha256:[a-f0-9]{64}/,
    );
    expect(dockerfile).toContain(
      'FROM ${XPOD_QLEVER_RUNTIME_BASE_IMAGE} AS runtime-base',
    );
    expect(runtimeBase).toContain(
      'XPOD_QLEVER_RUNTIME_BASE_IMAGE must be an immutable digest reference',
    );
    for (const dependency of [
      'libboost-container1.83.0',
      'libboost-iostreams1.83.0',
      'libboost-program-options1.83.0',
      'libboost-url1.83.0',
      'libicu76',
      'libsqlite3-0',
      'libssl3t64',
      'libzstd1',
    ]) {
      expect(runtimeBase).toContain(dependency);
    }
    for (const forbidden of [
      'clang',
      'cmake',
      'python3',
      'postgresql',
      'libsqlite3-dev',
      'libssl-dev',
    ]) {
      expect(runtimeBase).not.toContain(forbidden);
      expect(runtime).not.toContain(forbidden);
    }
    expect(runtimeBase).toContain(
      'COPY --from=build /opt/xpod/qlever /opt/xpod/qlever',
    );
    expect(runtime).toContain(
      'ENTRYPOINT ["/opt/xpod/qlever/bin/xpod_qlever_local_runtime"]',
    );
  });

  it('fails the image build on missing linkage and smokes the embedded SQLite runtime startup', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const build = stageBody(dockerfile, 'build');
    const runtimeBase = stageBody(dockerfile, 'runtime-base');
    const runtimeSmoke = stageBody(dockerfile, 'runtime-smoke');
    const runtime = stageBody(dockerfile, 'runtime');

    for (const artifact of [
      '/opt/xpod/qlever/bin/xpod_qlever_local_runtime',
      '/opt/xpod/qlever/manifest.json',
    ]) {
      expect(dockerfile).toContain(artifact);
    }
    expect(runtimeBase).toContain(
      'test ! -e /opt/xpod/qlever/lib/libxpod_qlever_adapter.so',
    );
    expect(runtimeBase).toContain(
      'test ! -e /opt/xpod/qlever/lib/libxpod_rdf_sqlite_backend.so',
    );
    expect(build).toContain('run-focused-native-build.sh');
    expect(build).toContain('XPOD_FOCUSED_BUILD_CACHE_PROBE');
    expect(runtimeBase.match(/ldd \/opt\/xpod\/qlever/g)?.length).toBe(1);
    expect(runtimeBase).toContain("grep -q 'not found'");
    expect(runtimeSmoke).not.toContain('--provider');
    expect(runtimeSmoke).toContain('wait_for_output');
    expect(runtimeSmoke).toContain('wait_for_output \'"type":"ready"\'');
    expect(runtimeSmoke).toContain('{"type":"shutdown"}');
    expect(runtime).toContain(
      'COPY --from=runtime-smoke /opt/xpod/qlever/manifest.json',
    );
  });

  it('gates image smoke on product-owned text and vector schemas', () => {
    const verifier = readFileSync(verifierPath, 'utf8');

    expect(verifier).toContain('CREATE TABLE rdf_text_metadata');
    expect(verifier).toContain('CREATE TABLE rdf_vector_metadata');
    expect(verifier).toContain(
      "INSERT INTO rdf_text_metadata(key, value) VALUES ('schema_version', '3')",
    );
    expect(verifier).toContain(
      "INSERT INTO rdf_vector_metadata(key, value) VALUES ('schema_version', '2')",
    );
    expect(verifier.match(/source_key TEXT NOT NULL UNIQUE/g)?.length).toBe(2);
    expect(verifier).toContain('ql:contains-word "alpha"');
    expect(verifier).toContain('"vectorQuery"');
    expect(verifier).toContain('"retrievalPointVariable": "?retrieval"');
    expect(verifier).toContain('"type": "literal", "value": "alpha card"');
    expect(verifier).toContain('"type": "literal", "value": "chunk-1"');
    expect(verifier).not.toContain('rdf_candidate_schema_version');
  });

  it('gates the focused runtime on real default and named graph rows', () => {
    const verifier = readFileSync(verifierPath, 'utf8');

    expect(verifier).toContain("'default_graph', '', '', 'smoke-default-graph'");
    expect(verifier).toContain("'urn:xpod:smoke:s:default'");
    expect(verifier).toContain("'urn:xpod:smoke:s:named'");
    expect(verifier).toContain('BIND(<urn:xpod:smoke:g:default> AS ?g)');
    expect(verifier).toContain('GRAPH ?g { ?s <urn:xpod:smoke:p:value> ?o }');
    expect(verifier).toContain('"basePath": "urn:xpod:smoke:"');
    expect(verifier).toContain('expected_graph_rows');
    expect(verifier).toContain('runtime default/named graph smoke mismatch');
  });

  it('gates document endpoints on their scoped named graph as the default dataset', () => {
    const verifier = readFileSync(verifierPath, 'utf8');

    expect(verifier).toContain("'urn:xpod:smoke:document'");
    expect(verifier).toContain('scoped-document-default-dataset');
    expect(verifier).toContain(
      '"basePath": "urn:xpod:smoke:document"',
    );
    expect(verifier).toContain(
      '"sourceUri": "urn:xpod:smoke:document"',
    );
    expect(verifier).toContain('"defaultDataset": "exactSource"');
    expect(verifier).toContain('expected_scoped_document_rows');
    expect(verifier).toContain(
      'runtime scoped-document default-dataset smoke mismatch',
    );
  });

  it('gates container endpoints on an explicit scoped-union default dataset', () => {
    const verifier = readFileSync(verifierPath, 'utf8');

    expect(verifier).toContain('container-scoped-union-default-dataset');
    expect(verifier).toContain('"defaultDataset": "scopedUnion"');
    expect(verifier).toContain('expected_scoped_union_rows');
    expect(verifier).toContain(
      'runtime scoped-union default-dataset smoke mismatch',
    );
  });

  it('gates the Gateway credential collection query on the native runtime', () => {
    const verifier = readFileSync(verifierPath, 'utf8');

    expect(verifier).toContain('gateway-credential-collection');
    expect(verifier).toContain('https://undefineds.co/ns#Credential');
    expect(verifier).toContain('https://undefineds.co/ns#encryptedSecret');
    expect(verifier).toContain('"defaultDataset": "scopedUnion"');
    expect(verifier).toContain('expected_credential_rows');
    expect(verifier).toContain(
      'runtime Gateway credential collection smoke mismatch',
    );
  });

  it('gates prepared updates that derive a new document source from its graph', () => {
    const verifier = readFileSync(verifierPath, 'utf8');

    expect(verifier).toContain('graph-derived-source-prepare-update');
    expect(verifier).toContain('"operation": "prepareUpdate"');
    expect(verifier).toContain('GRAPH <urn:xpod:smoke:new-document>');
    expect(verifier).not.toContain(
      '"sourceUri": "urn:xpod:smoke:new-document"',
    );
    expect(verifier).toContain(
      'graph.get("sourceUri") == "urn:xpod:smoke:new-document"',
    );
    expect(verifier).toContain('escaped-json-literal-prepare-update');
    expect(verifier).toContain('prepared_json_literal');
    expect(verifier).toContain('credentials.ttl#deepseek-prepared');
    expect(verifier).toContain(
      'runtime escaped JSON literal prepare-update smoke mismatch',
    );
  });

  it('records ABI, source identity, artifact digests, and immutable SDK provenance', () => {
    const verifier = readFileSync(verifierPath, 'utf8');

    expect(verifier).toContain('ready_message["adapterAbiVersion"]');
    expect(verifier).toContain('ready_message["physicalBackendAbiVersion"]');
    expect(verifier).toContain('"adapterAbiVersion": adapter_abi');
    expect(verifier).toContain('"physicalBackendAbiVersion": physical_backend_abi');
    expect(verifier).toContain('lock["commit"]');
    expect(verifier).toContain('lock["patchSeriesSha256"]');
    expect(verifier).toContain('"source": "focused-prior-runtime-sdk"');
    expect(verifier).toContain('"priorSdkImage": args.prior_sdk_image');
    expect(verifier).toContain('"entrypoint": "qlever/scripts/run-focused-native-build.sh"');
    expect(verifier).toContain('"source": "native-platform-build"');
    expect(verifier).toContain('"platform": args.build_source');
    expect(verifier).toContain('"entrypoint": "qlever/scripts/build-macos-local-runtime.sh"');
    expect(verifier).toContain('runtime_artifacts(prefix, runtime_path)');
    expect(verifier).toContain('library_root.rglob("*")');
    expect(verifier).toContain('hashlib.file_digest');
    expect(verifier).toContain('path.relative_to(prefix)');
    expect(verifier).not.toContain('ctypes');
  });

  it('publishes only a full-commit tag after smoke and exposes its digest', () => {
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('prior_sdk_image:');
    expect(workflow).toContain(
      'prior_sdk_image must be an immutable @sha256 image reference',
    );
    expect(workflow).toContain('^[a-f0-9]{40}$');
    expect(workflow).toContain(
      'tags: ${{ env.IMAGE }}:sha-${{ github.sha }}',
    );
    expect(workflow).toContain(
      'XPOD_QLEVER_PRIOR_SDK_IMAGE=${{ inputs.prior_sdk_image }}',
    );
    expect(workflow).toContain('target: runtime');
    expect(workflow).toContain('load: true');
    expect(workflow).toContain('push: false');
    expect(workflow).not.toContain(':latest');
    expect(workflow).not.toContain('runtime_sdk_tag');
    expect(workflow).not.toContain('prior_runtime_sdk_digest');

    const smoke = workflow.indexOf('- name: Smoke the exact image before publishing');
    const semanticGate = workflow.indexOf(
      '- name: Run SQLite QLever semantic and native search conformance',
    );
    const credentialGate = workflow.indexOf(
      '- name: Exercise the Gateway credential path against the exact image',
    );
    const publish = workflow.indexOf('- name: Publish and resolve the immutable digest');
    expect(smoke).toBeGreaterThan(0);
    expect(publish).toBeGreaterThan(smoke);
    expect(semanticGate).toBeGreaterThan(smoke);
    expect(credentialGate).toBeGreaterThan(semanticGate);
    expect(publish).toBeGreaterThan(credentialGate);
    expect(publish).toBeGreaterThan(semanticGate);
    expect(workflow).toContain('docker push "${tag}"');
    expect(workflow).toContain('[[ "${digest}" =~ ^sha256:[a-f0-9]{64}$ ]]');
    expect(workflow).toContain('echo "digest=${digest}" >> "${GITHUB_OUTPUT}"');
    expect(workflow).toContain('echo "image=${IMAGE}@${digest}"');
    expect(workflow).toContain('value: ${{ jobs.publish.outputs.digest }}');
  });

  it('runs semantic and native search conformance through the image wrapper', () => {
    expect(existsSync(imageRunnerPath)).toBe(true);
    const workflow = readFileSync(workflowPath, 'utf8');
    const runner = readFileSync(imageRunnerPath, 'utf8');

    expect(workflow).toContain(
      'install -m 0755 scripts/run-qlever-local-runtime-image.sh',
    );
    expect(workflow).toContain(
      'XPOD_QLEVER_LOCAL_RUNTIME_COMMAND="${RUNNER_TEMP}/run-qlever-local-runtime-image.sh"',
    );
    expect(workflow).toContain(
      'XPOD_QLEVER_SQLITE_RUNTIME_IMAGE="${IMAGE}:sha-${GITHUB_SHA}"',
    );
    expect(workflow).toContain(
      'XPOD_QLEVER_CONFORMANCE_BACKEND=sqlite',
    );
    expect(workflow).toContain('XPOD_QLEVER_CONFORMANCE_TIMEOUT_MS=30000');
    expect(workflow).toContain(
      'timeout --signal=TERM 10m bun dist/acceptance/run-installed-qlever-conformance.js',
    );
    expect(workflow).toContain('qlever-sqlite-conformance.json');

    expect(runner).toContain(
      'image="${XPOD_QLEVER_SQLITE_RUNTIME_IMAGE:?XPOD_QLEVER_SQLITE_RUNTIME_IMAGE is required}"',
    );
    expect(runner).toContain('usage: run-qlever-local-runtime-image.sh --sqlite-path PATH');
    expect(runner).toContain('[[ "${1:-}" != "--sqlite-path"');
    expect(runner).toContain('${3:-}');
    expect(runner).toContain('container_name="xpod-qlever-local-runtime-${$}-${RANDOM}"');
    expect(runner).toContain('trap cleanup EXIT INT TERM');
    expect(runner).toContain('docker rm -f "${container_name}"');
    expect(runner).toContain('docker run -i');
    expect(runner).toContain('--name "${container_name}"');

    expect(workflow).toContain(
      'XPOD_QLEVER_ACCEPTANCE_RUNTIME_COMMAND: ${{ runner.temp }}/run-qlever-local-runtime-image.sh',
    );
    expect(workflow).toContain('bun run build');
    expect(workflow).toContain(
      'bun run test -- tests/integration/localQleverCredentialRepository.test.ts',
    );
    expect(runner).toContain('--mount "type=bind,src=${database_dir},dst=/data"');
    expect(runner).toContain('"${image}"');
    expect(runner).toContain('--sqlite-path "/data/${database_name}"');
    expect(runner).not.toContain('exec docker run');
    expect(runner).not.toContain('docker run --rm');
    expect(runner).not.toContain('--provider');
  });

  it('mounts the SQLite directory so WAL sidecars stay visible to the runtime image', () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-qlever-image-runner-'));
    const fakeBin = path.join(root, 'bin');
    const databasePath = path.join(root, 'semantic.sqlite');
    const argsPath = path.join(root, 'docker-args.json');
    const dockerPath = path.join(fakeBin, 'docker');
    try {
      mkdirSync(fakeBin);
      writeFileSync(databasePath, 'main');
      writeFileSync(`${databasePath}-wal`, 'wal');
      writeFileSync(`${databasePath}-shm`, 'shm');
      writeFileSync(dockerPath, [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const callsPath = process.env.XPOD_DOCKER_CALLS_PATH;",
        "const args = process.argv.slice(2);",
        "const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];",
        "calls.push(args);",
        "fs.writeFileSync(callsPath, JSON.stringify(calls));",
        "if (args[0] === 'run') fs.writeFileSync(process.env.XPOD_DOCKER_ARGS_PATH, JSON.stringify(args));",
        '',
      ].join('\n'));
      chmodSync(dockerPath, 0o755);

      execFileSync('bash', [ imageRunnerPath, '--sqlite-path', databasePath ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          XPOD_DOCKER_ARGS_PATH: argsPath,
          XPOD_DOCKER_CALLS_PATH: path.join(root, 'docker-calls.json'),
          XPOD_QLEVER_SQLITE_RUNTIME_IMAGE: 'example.invalid/runtime@sha256:test',
        },
      });

      const args = JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
      const mount = args[args.indexOf('--mount') + 1];
      expect(realpathSync(mount.slice('type=bind,src='.length, -',dst=/data'.length)))
        .toBe(realpathSync(root));
      expect(args).toContain('/data/semantic.sqlite');
      expect(args).toContain('--name');
      expect(args).not.toContain('--rm');
      expect(args).not.toContain(`type=bind,src=${realpathSync(databasePath)},dst=/data/runtime.sqlite`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins every third-party workflow action by commit', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const actions = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)];

    expect(actions.length).toBeGreaterThan(0);
    for (const [, revision] of actions) {
      expect(revision).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it('removes the named runtime image container on wrapper exit', () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = mkdtempSync(path.join(os.tmpdir(), 'xpod-qlever-image-runner-cleanup-'));
    const fakeBin = path.join(root, 'bin');
    const databasePath = path.join(root, 'semantic.sqlite');
    const callsPath = path.join(root, 'docker-calls.json');
    const dockerPath = path.join(fakeBin, 'docker');
    try {
      mkdirSync(fakeBin);
      writeFileSync(databasePath, 'main');
      writeFileSync(dockerPath, [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const callsPath = process.env.XPOD_DOCKER_CALLS_PATH;",
        "const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];",
        "calls.push(args);",
        "fs.writeFileSync(callsPath, JSON.stringify(calls));",
        "process.exit(args[0] === 'run' ? 17 : 0);",
        '',
      ].join('\n'));
      chmodSync(dockerPath, 0o755);

      expect(() => execFileSync('bash', [ imageRunnerPath, '--sqlite-path', databasePath ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          XPOD_DOCKER_CALLS_PATH: callsPath,
          XPOD_QLEVER_SQLITE_RUNTIME_IMAGE: 'example.invalid/runtime@sha256:test',
        },
      })).toThrow();

      const calls = JSON.parse(readFileSync(callsPath, 'utf8')) as string[][];
      const run = calls.find((args) => args[0] === 'run');
      expect(run).toBeDefined();
      const containerName = run![run!.indexOf('--name') + 1];
      expect(containerName).toMatch(/^xpod-qlever-local-runtime-\d+-\d+$/);
      expect(calls).toContainEqual([ 'rm', '-f', containerName ]);
      expect(calls.at(-1)).toEqual([ 'rm', '-f', containerName ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
