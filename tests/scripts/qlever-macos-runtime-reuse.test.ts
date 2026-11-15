import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
}

describe('macOS QLever runtime reuse', () => {
  it('routes the producer and host validation through the shared target catalog', async () => {
    const workflow = parseDocument(await readFile(path.resolve(__dirname,
      '../../.github/workflows/build-qlever-macos-runtime.yml'), 'utf8')).toJSON();
    expect(workflow.on.workflow_call.inputs.target.default).toBe('darwin-arm64');
    expect(workflow.jobs.build['runs-on']).toBe('${{ needs.resolve.outputs.runner }}');
    expect(workflow.jobs.resolve.uses).toBe('./.github/workflows/resolve-qlever-native-target.yml');
    const targetWorkflow = parseDocument(await readFile(path.join(__dirname, '../../.github/workflows/resolve-qlever-native-target.yml'), 'utf8')).toJSON();
    const resolver = targetWorkflow.jobs.resolve.steps.find((step: WorkflowStep) => step.name === 'Resolve native target from the shared catalog');
    expect(resolver.run).toContain('bun scripts/module-product-targets.ts css "$REQUESTED_TARGET"');
    expect(resolver.run).toContain("row['platform'] != os.environ['EXPECTED_PLATFORM']");
    expect(workflow.jobs.resolve.with.platform).toBe('darwin');
    const host = workflow.jobs.build.steps.find((step: WorkflowStep) => step.name === 'Verify the actual native producer host');
    expect(host.run).toContain('--require-host');
    expect(host.env.TARGET).toBe('${{ needs.resolve.outputs.target }}');
  });
  it('executes the metadata shell for both architectures without assigning one archive name to both', async () => {
    const repo = path.resolve(__dirname, '../..');
    const workflow = parseDocument(await readFile(path.join(repo,
      '.github/workflows/build-qlever-macos-runtime.yml'), 'utf8')).toJSON();
    const step = workflow.jobs.build.steps.find((value: WorkflowStep) => value.name === 'Resolve immutable artifact identity');
    const source = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim();
    const parent = path.join(repo, '.test-data/qlever-native-target-contract'); mkdirSync(parent, {recursive: true});
    const temporary = mkdtempSync(path.join(parent, 'case-'));
    try {
      for (const arch of ['arm64', 'x64']) {
        const target = 'darwin-' + arch, output = path.join(temporary, arch + '.outputs');
        const run = step.run.replaceAll('${{ needs.resolve.outputs.target }}', target);
        execFileSync('/bin/bash', ['-c', run], {cwd: repo, env: {...process.env, SOURCE_SHA: source, GITHUB_OUTPUT: output}});
        expect(readFileSync(output, 'utf8')).toContain('artifact_name=qlever-local-runtime-' + target + '-' + source);
        for (const buildStep of workflow.jobs.build.steps as WorkflowStep[]) if (buildStep.run) {
          const shell = buildStep.run.replaceAll('${{ needs.resolve.outputs.arch }}', arch).replaceAll('${{ needs.resolve.outputs.target }}', target);
          execFileSync('/bin/bash', ['-n'], {input: shell});
        }
      }
    } finally {rmSync(temporary, {recursive: true, force: true});}
  });

  it('skips compilation only on an exact native-input cache hit and rechecks that runtime', async () => {
    const workflow = parseDocument(await readFile(path.resolve(__dirname,
      '../../.github/workflows/build-qlever-macos-runtime.yml'), 'utf8')).toJSON();
    const steps = workflow.jobs.build.steps as WorkflowStep[];
    const named = (name: string) => {
      const step = steps.find(value => value.name === name);
      expect(step, name).toBeDefined();
      return step!;
    };
    const cache = named('Restore verified native runtime');
    expect(cache.with?.key).toContain("hashFiles('qlever/**'");
    expect(cache.with?.key).toContain('.github/workflows/build-qlever-macos-runtime.yml');
    expect(cache.with?.key).toContain('steps.toolchain.outputs.identity');
    expect(cache.with?.key).not.toMatch(/github.sha|SOURCE_SHA|package.json/u);
    expect(cache.with?.['restore-keys']).toBeUndefined();
    for (const name of ['Install the upstream native toolchain', 'Cache the compiler cache',
      'Resolve build parallelism', 'Build, bundle, sign, and smoke the native runtime']) {
      expect(named(name).if).toBe("steps.runtime_cache.outputs.cache-hit != 'true'");
    }
    const reuse = named('Verify and smoke the reused native runtime');
    expect(reuse.if).toBe("steps.runtime_cache.outputs.cache-hit == 'true'");
    expect(reuse.run).toContain('verify-qlever-local');
    expect(reuse.run).toContain('--expected-archive');
    expect(reuse.run).toContain('verify-local-runtime-artifacts.py');
    expect(reuse.run).toContain('--lock qlever/qlever.lock.json');
    const evidence = named('Bind the qlever-local acceptance evidence');
    expect(evidence.if).toBeUndefined();
    expect(evidence.env?.SOURCE_SHA).toBe('${{ github.sha }}');
    expect(evidence.run).toContain('create-qlever-local');
    expect(steps.indexOf(evidence)).toBeGreaterThan(steps.indexOf(reuse));
    expect(named('Upload the exact native runtime').if).toBeUndefined();
  });
});

describe('QLever Linux target isolation', () => {
  it('keeps default x64 service inputs while isolating architecture, runner, image aliases and build cache', async () => {
    for (const name of ['publish-qlever-runtime-sdk.yml', 'publish-qlever-local-runtime.yml']) {
      const workflow = parseDocument(await readFile(path.join(__dirname, '../../.github/workflows', name), 'utf8')).toJSON();
      for (const trigger of ['workflow_call', 'workflow_dispatch']) expect(workflow.on[trigger].inputs.target.default).toBe('linux-x64');
      expect(workflow.jobs.resolve_target.uses).toBe('./.github/workflows/resolve-qlever-native-target.yml');
      expect(workflow.jobs.resolve_target.with.platform).toBe('linux');
      const publish = workflow.jobs.publish;
      expect(publish['runs-on']).toBe('${{ needs.resolve_target.outputs.runner }}');
      const image = publish.env.SDK_IMAGE ?? publish.env.IMAGE;
      expect(image.endsWith('${{ needs.resolve_target.outputs.repository_suffix }}')).toBe(true);
      const builds = publish.steps.filter((step: {uses?: string}) => step.uses?.startsWith('docker/build-push-action@'));
      expect(builds.length).toBeGreaterThan(0);
      for (const build of builds) {
        expect(build.with.platforms).toBe('${{ needs.resolve_target.outputs.docker_platform }}');
        if (build.with['cache-to']) expect(build.with['cache-to']).toContain('${{ needs.resolve_target.outputs.target }}');
      }
      const host = publish.steps.find((step: WorkflowStep) => step.name === 'Verify the actual native producer host');
      expect(host.run).toContain('process.arch!==process.env.EXPECTED_ARCH');
      expect(host.env.EXPECTED_ARCH).toBe('${{ needs.resolve_target.outputs.arch }}');
    }
  });
});
