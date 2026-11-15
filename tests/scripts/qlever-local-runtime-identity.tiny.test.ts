import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/publish-qlever-local-runtime.yml',
);
const candidateWorkflowPath = path.join(repoRoot, '.github/workflows/candidate.yml');
const moduleWorkflowPath = path.join(
  repoRoot,
  '.github/workflows/build-qlever-linux-runtime.yml',
);

function localRuntimeWorkflow(): any {
  return parseDocument(readFileSync(workflowPath, 'utf8')).toJSON();
}

function stepById(workflow: any, id: string): any {
  const step = workflow.jobs.publish.steps.find((candidate: any) => candidate.id === id);
  assert.ok(step, `missing workflow step ${id}`);
  return step;
}

function renderWorkflowExpression(value: string, expressions: Record<string, string>): string {
  return value.replace(/\$\{\{[^}]*\}\}/g, (expression) => {
    const key = expression.trim();
    if (!(key in expressions)) throw new Error(`unresolved workflow expression ${key}`);
    return expressions[key]!;
  });
}

function stepEnvironment(step: any, expressions: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [
      key,
      renderWorkflowExpression(value as string, expressions),
    ]),
  );
}

function githubOutputs(body: string): Record<string, string> {
  return Object.fromEntries(
    body
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function profileIdentity(name: string): string {
  return (
    JSON.parse(
      execFileSync('python3', ['qlever/scripts/qlever_compiler_profile.py', 'sdk-profile', name], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
    ) as { identity: string }
  ).identity;
}

describe('QLever local runtime identity contract', () => {
  it('derives the canonical normal SDK identity and resolves it with candidate defaults', () => {
    const workflow = localRuntimeWorkflow();
    const candidate = parseDocument(readFileSync(candidateWorkflowPath, 'utf8')).toJSON();
    const localJob = candidate.jobs.publish_qlever_local_runtime;
    expect(localJob.uses).toBe('./.github/workflows/publish-qlever-local-runtime.yml');
    // This is the actual caller: profile/target are callee defaults, not inputs.
    expect(localJob.with).toEqual({
      prior_sdk_image: '${{ needs.publish_qlever_runtime_sdk.outputs.image }}',
    });
    const callInputs = workflow.on.workflow_call.inputs;
    expect(callInputs.sdk_profile.default).toBe('service-trixie');
    expect(callInputs.target.default).toBe('linux-x64');

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const identity = profileIdentity('service-trixie');
    const runtimeDockerfile = 'docker/qlever-local-runtime/Dockerfile';
    const image = 'ghcr.io/acme/xpod-qlever-local-runtime';
    const testDataRoot = path.join(repoRoot, '.test-data');
    mkdirSync(testDataRoot, { recursive: true });
    const tempRoot = mkdtempSync(path.join(testDataRoot, 'qlever-local-runtime-identity-'));
    try {
      const expressions = {
        '${{ github.sha }}': head,
        '${{ needs.resolve_target.outputs.sdk_profile }}': 'service-trixie',
        '${{ needs.resolve_target.outputs.target }}': 'linux-x64',
        '${{ needs.resolve_target.outputs.sdk_profile_identity }}': identity,
      };
      const inputsStep = stepById(workflow, 'inputs');
      const inputsOutput = path.join(tempRoot, 'inputs-output');
      const inputs = spawnSync('/bin/bash', ['-c', inputsStep.run], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...stepEnvironment(inputsStep, expressions),
          RUNNER_TEMP: tempRoot,
          GITHUB_OUTPUT: inputsOutput,
          GITHUB_STEP_SUMMARY: path.join(tempRoot, 'summary'),
          GITHUB_SHA: head,
        },
      });
      assert.equal(inputs.status, 0, `${inputs.stdout}\n${inputs.stderr}`);
      const inputValues = githubOutputs(readFileSync(inputsOutput, 'utf8'));
      assert.match(inputValues.tag, /^qlever-inputs-[a-f0-9]{64}$/u);

      const identityPath = path.join(tempRoot, 'qlever-normal-input.json');
      const resolvedIdentity = JSON.parse(readFileSync(identityPath, 'utf8'));
      expect(resolvedIdentity.inputHash).toBe(inputValues.tag.slice('qlever-inputs-'.length));
      expect(resolvedIdentity.model).toBe('normal-build-v1');
      expect(resolvedIdentity.sdkProfile).toBe('service-trixie');
      expect(resolvedIdentity.target).toBe('linux-x64');
      expect(resolvedIdentity.recipe).toEqual({
        kind: 'cold',
        dockerfile: 'docker/qlever-runtime-sdk/Dockerfile.normal',
        priorImage: null,
      });

      // Independent canonical recomputation with the declared inputs, so this
      // catches a workflow that merely emits 64 hex of something else.
      const expectedPath = path.join(tempRoot, 'expected-identity.json');
      execFileSync(
        'python3',
        [
          'qlever/scripts/sdk-normal-build-proof.py', 'identity',
          '--source', '.', '--source-commit', head,
          '--profile', 'service-trixie', '--target', 'linux-x64',
          '--profile-identity', identity,
          '--dockerfile', 'docker/qlever-runtime-sdk/Dockerfile.normal',
          '--out', expectedPath,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, GITHUB_OUTPUT: path.join(tempRoot, 'expected-output') },
        },
      );
      expect(resolvedIdentity.inputHash).toBe(
        JSON.parse(readFileSync(expectedPath, 'utf8')).inputHash,
      );

      // Execute the actual resolver shell with those exact caller defaults.
      const resolveStep = stepById(workflow, 'resolve');
      const resolveExpressions = {
        ...expressions,
        '${{ env.IMAGE }}': image,
        '${{ steps.inputs.outputs.tag }}': inputValues.tag,
        '${{ needs.resolve_target.outputs.runtime_dockerfile }}': runtimeDockerfile,
        "${{ needs.resolve_target.outputs.sdk_profile == 'service-trixie' && 'true' || 'false' }}": 'true',
      };
      const fakeBin = path.join(tempRoot, 'bin');
      const dockerPath = path.join(fakeBin, 'docker');
      mkdirSync(fakeBin);
      writeFileSync(dockerPath, '#!/bin/sh\nexit 42\n');
      chmodSync(dockerPath, 0o755);
      const resolveOutput = path.join(tempRoot, 'resolve-output');
      const resolve = spawnSync('/bin/bash', ['-c', resolveStep.run], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...stepEnvironment(resolveStep, resolveExpressions),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: tempRoot,
          GITHUB_OUTPUT: resolveOutput,
          GITHUB_SHA: head,
        },
      });
      assert.equal(resolve.status, 0, `${resolve.stdout}\n${resolve.stderr}`);
      const resolveValues = githubOutputs(readFileSync(resolveOutput, 'utf8'));
      expect(resolveValues.build).toBe('true');
      expect(resolveValues.reused_inputs).toBe('false');
      expect(resolveValues.tag).toBe(`sha-${head}`);
      expect(resolveValues.dockerfile).toBe(runtimeDockerfile);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects the old 12-hex local alias at the shared resolver', () => {
    const workflow = localRuntimeWorkflow();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const testDataRoot = path.join(repoRoot, '.test-data');
    mkdirSync(testDataRoot, { recursive: true });
    const tempRoot = mkdtempSync(path.join(testDataRoot, 'qlever-local-runtime-short-alias-'));
    try {
      const resolveStep = stepById(workflow, 'resolve');
      const expressions = {
        '${{ env.IMAGE }}': 'ghcr.io/acme/xpod-qlever-local-runtime',
        '${{ needs.resolve_target.outputs.runtime_dockerfile }}': 'docker/qlever-local-runtime/Dockerfile',
        '${{ steps.inputs.outputs.tag }}': 'qlever-inputs-d02da05e36fb',
        '${{ needs.resolve_target.outputs.sdk_profile }}': 'service-trixie',
        "${{ needs.resolve_target.outputs.sdk_profile == 'service-trixie' && 'true' || 'false' }}": 'true',
      };
      const result = spawnSync('/bin/bash', ['-c', resolveStep.run], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...stepEnvironment(resolveStep, expressions),
          RUNNER_TEMP: tempRoot,
          GITHUB_OUTPUT: path.join(tempRoot, 'resolve-output'),
          GITHUB_SHA: head,
        },
      });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('QELEVER_INPUTS_TAG must look like qlever-inputs-<64 hex>');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps module-bookworm on its legacy 12-hex local alias', () => {
    const workflow = localRuntimeWorkflow();
    const moduleCaller = parseDocument(readFileSync(moduleWorkflowPath, 'utf8')).toJSON();
    expect(moduleCaller.jobs.runtime.with).toEqual({
      target: '${{ needs.resolve.outputs.target }}',
      sdk_profile: 'module-bookworm-gcc12',
      prior_sdk_image: '${{ inputs.module_sdk_image }}',
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const identity = profileIdentity('module-bookworm-gcc12');
    const runtimeDockerfile = 'docker/qlever-local-runtime/Dockerfile.module-bookworm';
    const testDataRoot = path.join(repoRoot, '.test-data');
    mkdirSync(testDataRoot, { recursive: true });
    const tempRoot = mkdtempSync(path.join(testDataRoot, 'qlever-local-runtime-module-'));
    try {
      const expressions = {
        '${{ github.sha }}': head,
        '${{ needs.resolve_target.outputs.sdk_profile }}': 'module-bookworm-gcc12',
        '${{ needs.resolve_target.outputs.target }}': 'linux-x64',
        '${{ needs.resolve_target.outputs.sdk_profile_identity }}': identity,
      };
      const inputsStep = stepById(workflow, 'inputs');
      const inputsOutput = path.join(tempRoot, 'inputs-output');
      const inputs = spawnSync('/bin/bash', ['-c', inputsStep.run], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...stepEnvironment(inputsStep, expressions),
          RUNNER_TEMP: tempRoot,
          GITHUB_OUTPUT: inputsOutput,
          GITHUB_STEP_SUMMARY: path.join(tempRoot, 'summary'),
          GITHUB_SHA: head,
        },
      });
      assert.equal(inputs.status, 0, `${inputs.stdout}\n${inputs.stderr}`);
      const inputValues = githubOutputs(readFileSync(inputsOutput, 'utf8'));
      assert.match(inputValues.tag, /^qlever-inputs-[a-f0-9]{12}$/u);

      const resolveStep = stepById(workflow, 'resolve');
      const resolveExpressions = {
        ...expressions,
        '${{ env.IMAGE }}': 'ghcr.io/acme/xpod-qlever-local-runtime-module-bookworm',
        '${{ steps.inputs.outputs.tag }}': inputValues.tag,
        '${{ needs.resolve_target.outputs.runtime_dockerfile }}': runtimeDockerfile,
        "${{ needs.resolve_target.outputs.sdk_profile == 'service-trixie' && 'true' || 'false' }}": 'false',
      };
      const resolveOutput = path.join(tempRoot, 'resolve-output');
      const resolve = spawnSync('/bin/bash', ['-c', resolveStep.run], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...stepEnvironment(resolveStep, resolveExpressions),
          RUNNER_TEMP: tempRoot,
          GITHUB_OUTPUT: resolveOutput,
          GITHUB_SHA: head,
        },
      });
      assert.equal(resolve.status, 0, `${resolve.stdout}\n${resolve.stderr}`);
      const resolveValues = githubOutputs(readFileSync(resolveOutput, 'utf8'));
      expect(resolveValues.build).toBe('true');
      expect(resolveValues.tag).toBe(`sha-${head}`);
      expect(resolveValues.dockerfile).toBe(runtimeDockerfile);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
