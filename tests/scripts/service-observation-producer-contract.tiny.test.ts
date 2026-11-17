import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const PRODUCER = 'qlever/scripts/sdk-service-image-originals.py';
const ABI = '--capture-service-abi-originals';
const REQUIRED = ['--capture-service-pack-originals', '--capture-service-runtime-members'];
const doc = parse(readFileSync('.github/workflows/candidate.yml', 'utf8'));
const job = doc.jobs.build_image;
const mandatory = job.steps.find((step: any) => step.id === 'service_originals');
const diagnostic = job.steps.find((step: any) => step.id === 'service_abi_diagnostic');
const upload = job.steps.find((step: any) => step.id === 'service_abi_diagnostic_upload');
const realPython = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const fixtures = new Set<string>();
const expression = (value: string): string => '$' + '{{ ' + value + ' }}';

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

type Capture = { argv: string[]; runnerTemp: string; githubOutput: string };

function fixture() {
  const parent = path.resolve('.test-data/service-observation-producer-contract');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case with spaces-'));
  fixtures.add(root);
  const runner = path.join(root, 'runner');
  const bin = path.join(root, 'bin');
  mkdirSync(runner);
  mkdirSync(bin);
  const clock = path.join(root, 'clock');
  const captureLog = path.join(root, 'argv.jsonl');
  writeFileSync(clock, '1000');
  const stub = [
    '#!' + realPython,
    'import json,os,pathlib,sys',
    'args=sys.argv[1:]',
    'if "-c" in args: os.execv(os.environ["REAL_PYTHON"],[os.environ["REAL_PYTHON"],*args])',
    'i=next(i for i,arg in enumerate(args) if arg.endswith("sdk-service-image-originals.py"))',
    'args=args[i+1:]',
    'out=pathlib.Path(args[args.index("--out")+1])',
    'with open(os.environ["CAPTURE_LOG"],"a") as f: f.write(json.dumps(dict(argv=args,runnerTemp=os.environ["RUNNER_TEMP"],githubOutput=os.environ["GITHUB_OUTPUT"]))+"\\n")',
    'assert out.parent.resolve()==pathlib.Path(os.environ["RUNNER_TEMP"]).resolve() and out.name=="service-image-originals"',
    'out.mkdir(mode=0o700,exist_ok=False)',
    'if "--capture-service-abi-originals" in args and os.environ["FAIL_ABI"]=="1":',
    ' (out/"partial-diagnostic.json").write_text("{}")',
    ' sys.exit(7)',
    '(out/"service-image-materials.json").write_text("{\\"fixture\\":true}\\n")',
    'with open(os.environ["GITHUB_OUTPUT"],"a") as f: f.write("master_sha256="+"a"*64+"\\nmaster_bytes=17\\n")',
  ].join('\n');
  writeFileSync(path.join(bin, 'python3'), stub);
  writeFileSync(path.join(bin, 'date'), [
    '#!' + realPython,
    'import os,pathlib,sys',
    'assert sys.argv[1:]==["+%s"]',
    'print(pathlib.Path(os.environ["CAPTURE_CLOCK"]).read_text())',
  ].join('\n'));
  chmodSync(path.join(bin, 'python3'), 0o700);
  chmodSync(path.join(bin, 'date'), 0o700);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: bin + path.delimiter + process.env.PATH,
    REAL_PYTHON: realPython, CAPTURE_LOG: captureLog, CAPTURE_CLOCK: clock,
    FAIL_ABI: '0', RUNNER_TEMP: runner,
    GITHUB_WORKSPACE: process.cwd(), GITHUB_SHA: head, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '3',
    BUILD_METADATA: '{}', BUILD_DIGEST: 'sha256:' + 'a'.repeat(64),
    LOCAL_RUNTIME_IMAGE: 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + 'b'.repeat(64),
    SDK_IMAGE: 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + 'c'.repeat(64),
    SDK_ARTIFACT_ID: '1', SDK_ARTIFACT_DIGEST: 'd'.repeat(64),
    SDK_MASTER_BYTES: '1', SDK_MASTER_SHA256: 'e'.repeat(64),
    SDK_SOURCE_SHA: head, SDK_RUN_HEAD_SHA: head, SDK_RUN_ID: '17', SDK_RUN_ATTEMPT: '3',
    SDK_BUILD_MODEL: 'normal-build-v1',
    NATIVE_RUNTIME_ARTIFACT_ID: '2', NATIVE_RUNTIME_ARTIFACT_DIGEST: 'f'.repeat(64),
    NATIVE_RUNTIME_MASTER_BYTES: '1', NATIVE_RUNTIME_MASTER_SHA256: 'a'.repeat(64),
  };
  const render = (text: string): string => text.split(expression('runner.temp')).join(runner);
  const run = (step: any, outputName: string, failAbi = false) => {
    const output = path.join(root, outputName);
    writeFileSync(output, '');
    const stepEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.env ?? {})) stepEnv[key] = render(String(value));
    const result = spawnSync('bash', ['-c', render(step.run)], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
      env: { ...env, ...stepEnv, GITHUB_OUTPUT: output, FAIL_ABI: failAbi ? '1' : '0' },
    });
    return { ...result, output, outputText: readFileSync(output, 'utf8') };
  };
  const captures = (): Capture[] => readFileSync(captureLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, runner, env, clock, run, captures };
}

function value(argv: string[], flag: string): string {
  expect(argv.filter(token => token === flag)).toHaveLength(1);
  return argv[argv.indexOf(flag) + 1]!;
}

function bindings(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out' || argv[index] === '--deadline') { index++; continue; }
    result.push(argv[index]!);
  }
  return result;
}

test('actual mandatory shell keeps all bindings and excludes ABI for either dispatch input', () => {
  for (const input of ['false', 'true']) {
    const f = fixture();
    f.env.INPUT_SERVICE_SOURCE_DIAGNOSTICS = input;
    const result = f.run(mandatory, 'mandatory.outputs');
    expect(result.status).toBe(0);
    const [record] = f.captures();
    for (const flag of REQUIRED) expect(record!.argv.filter(token => token === flag)).toHaveLength(1);
    expect(record!.argv).not.toContain(ABI);
    expect(value(record!.argv, '--out')).toBe(path.join(f.runner, 'service-image-originals'));
    expect(value(record!.argv, '--deadline')).toBe('1120');
    expect(result.outputText).toContain('master_sha256=');
  }
});

test('actual diagnostic shell reuses bindings with its own output, temp root and fresh 120s budget', () => {
  const f = fixture();
  const main = f.run(mandatory, 'mandatory.outputs');
  expect(main.status).toBe(0);
  writeFileSync(f.clock, '5000');
  const extra = f.run(diagnostic, 'diagnostic.outputs');
  expect(extra.status).toBe(0);
  const [canonical, probe] = f.captures();
  expect(probe!.argv.filter(token => token === ABI)).toHaveLength(1);
  expect(bindings(probe!.argv)).toEqual([...bindings(canonical!.argv), ABI]);
  expect(value(probe!.argv, '--deadline')).toBe('5120');
  expect(value(probe!.argv, '--out')).toBe(path.join(f.runner, 'service-abi-diagnostic/service-image-originals'));
  expect(probe!.runnerTemp).toBe(path.join(f.runner, 'service-abi-diagnostic'));
  expect(probe!.githubOutput).not.toBe(canonical!.githubOutput);
});

test('failing actual diagnostic shell leaves the canonical master and step outputs unchanged', () => {
  const f = fixture();
  const main = f.run(mandatory, 'mandatory.outputs');
  expect(main.status).toBe(0);
  const master = path.join(f.runner, 'service-image-originals/service-image-materials.json');
  const before = readFileSync(master);
  writeFileSync(f.clock, '5000');
  const failed = f.run(diagnostic, 'diagnostic.outputs', true);
  expect(failed.status).toBe(7);
  expect(failed.outputText).toBe('');
  expect(readFileSync(master)).toEqual(before);
  expect(readFileSync(main.output, 'utf8')).toBe(main.outputText);
  expect(JSON.stringify(doc.jobs.build_image.outputs)).not.toContain('service_abi_diagnostic');
});

test('only the explicitly isolated diagnostic job, capture and upload may tolerate failure', () => {
  expect(diagnostic.if).toBe(expression("github.event_name == 'workflow_dispatch' && inputs.service_source_diagnostics == true"));
  expect(upload).toBeDefined();
  expect(upload.if).toContain("steps.service_abi_diagnostic.outcome != 'skipped'");
  const permitted = ['build_image:service_abi_diagnostic', 'build_image:service_abi_diagnostic_upload'];
  const actual: string[] = [];
  const jobs: string[] = [];
  for (const [name, config] of Object.entries<any>(doc.jobs)) {
    if (config['continue-on-error'] === true) jobs.push(name);
    for (const step of config.steps ?? []) {
      if (step['continue-on-error'] === true) actual.push(name + ':' + String(step.id));
    }
  }
  expect(jobs).toEqual(['observe_service_sdk_source']);
  expect(actual.sort()).toEqual(permitted.sort());
  expect(upload.with.path).toBe(expression('runner.temp') + '/service-abi-diagnostic/service-image-originals');
  expect(job.steps.find((step: any) => step.id === 'service_originals_upload').with.path)
    .toBe(expression('runner.temp') + '/service-image-originals');
  for (const ref of Object.values(job.outputs)) expect(String(ref)).not.toContain('service_abi_diagnostic');
});

test('the real producer enforces output ownership under the per-invocation temporary root', () => {
  const f = fixture();
  const isolated = path.join(f.root, 'guard-isolated');
  mkdirSync(isolated);
  const out = path.join(isolated, 'service-image-originals');
  const h = 'a'.repeat(64);
  const argv = ['-I', '-S', '-B', PRODUCER, '--source', process.cwd(), '--source-sha', head,
    '--service-image', 'ghcr.io/undefinedsco/xpod@sha256:' + h,
    '--local-runtime-image', 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + h,
    '--sdk-image', 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + h,
    '--sdk-artifact-id', '1', '--sdk-artifact-digest', h, '--sdk-master-bytes', '1', '--sdk-master-sha256', h,
    '--root-manifest-before', path.join(f.root, 'unused-before.json'),
    '--root-manifest-after', path.join(f.root, 'unused-after.json'),
    '--build-metadata', path.join(f.root, 'unused-metadata.json'), '--deadline', '0', '--out', out];
  const bad = spawnSync(realPython, argv, { encoding: 'utf8', env: f.env, timeout: 15000 });
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain('fixed owned original output');
  const owned = spawnSync(realPython, argv, {
    encoding: 'utf8', env: { ...f.env, RUNNER_TEMP: isolated }, timeout: 15000,
  });
  expect(owned.status).not.toBe(0);
  // Budget zero aborts immediately after the real ownership guard, before any Docker/network work.
  expect(owned.stderr).toContain('Invalid or expired SDK producer deadline');
});

test('the real producer still advertises the mandatory and diagnostic capture flags', () => {
  const help = spawnSync(realPython, ['-I', '-S', '-B', PRODUCER, '--help'], { encoding: 'utf8', timeout: 15000 });
  expect(help.status).toBe(0);
  for (const flag of [...REQUIRED, ABI]) expect(help.stdout).toContain(flag);
});
