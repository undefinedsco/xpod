import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCatalog } from './sdk-helper-catalog.fixture';
import { QLEVER_SDK_EXECUTION_GROUPS as SDK, QLEVER_LINUX_EXECUTION_GROUPS as LINUX, QLEVER_SDK_CONSUMER_GROUPS as CURRENT_SDK } from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import { CURRENT_SOURCE_GROUP_COUNTS } from './source-binding-group.fixture';

const ROOT = path.resolve(import.meta.dirname, '../..');
const sha = (file: string) => createHash('sha256').update(readFileSync(path.join(ROOT, file))).digest('hex');
const all = (group: any) => [...group.selectors, ...(group.secondarySelectors ?? []), ...(group.secondarySelectorStages ?? []).flat(), ...group.sourceBindings];
const jsonSha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const historyPrefixSha = '159976e93ef3fcd2e0e85ffa456f04c3021e3b0658a47f88a84c9dfaeabce39f';
const helperPrefixes = Object.freeze({ observer: ['c1c96071e0b9331416904a4b4187640e816e95b566a1cc77945d9df47396ef78', 59], controller: ['883bb20b1c29de7314e4a3356c209a330db8a736231969d1e5d6c3bcb9fefc88', 39], fetch: ['2b542cce7b2ac7c0b27abe48c862ba5c3b95fec1bc2371da22f1f0aa5a7a45ee', 42], readonly: ['8411c465f9bb2f56d19101806cd21bb5810ccca8ecb247c9671e795a12132c59', 9] } as const);
const row = (group: any, file: string) => [...all(group)].reverse().find((item: any) => item.path === file);

describe('SDK88 phase-derived budget binding', () => {
  it('appends one current group and leaves SDK87 historical bytes untouched', () => {
    expect(SDK).toHaveLength(CURRENT_SOURCE_GROUP_COUNTS.sdk);
    expect(LINUX).toHaveLength(CURRENT_SOURCE_GROUP_COUNTS.linux);
    const old = SDK[86]!, next = SDK[87]!;
    expect(row(old, 'qlever/scripts/sdk-execution-budget.py').sha256).toBe('329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee');
    expect(row(next, 'qlever/scripts/sdk-execution-budget.py').sha256).toBe('a66aca9e68010a80cac474cb004c58c2244efe08f772c1215c74103dae68de80');
    expect(row(next, 'qlever/scripts/sdk-execution-budget.py').sha256).toBe(sha('qlever/scripts/sdk-execution-budget.py'));
    expect(row(old, 'qlever/scripts/sdk-generated-vma-originals.py').sha256).toBe('602f86ce683409ff83e6c7014c9bed82bb2fe687fdf2d42be36dc1891b4dc5d8');
    expect(row(old, 'tests/scripts/candidate-producer-attempt-binding.test.ts').sha256).toBe('8973eb25c1e6d669e2fc2d7c05ffd80d0f040c066d32d83f0a7f24e5b375daba');
    expect(row(next, 'tests/scripts/candidate-producer-attempt-binding.test.ts').sha256).toBe('3e0f2ca3fdbfba54f3af985450413e45087e32cf2193470a9ba2568590612ca6');
    expect(jsonSha(SDK.slice(0, 87))).toBe(historyPrefixSha);
    for (const [name, file, key] of [
      ['observer', 'qlever-sdk-generation.ts', 'REVIEWED_OBSERVER_GROUPS'],
      ['controller', 'qlever-sdk-generation.ts', 'REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT'],
      ['fetch', 'qlever-sdk-fetchcontent.ts', 'REVIEWED_HELPER_GROUPS_CURRENT'],
      ['readonly', 'qlever-sdk-readonly-executor.ts', 'REVIEWED_READONLY_HELPER_GROUPS'],
    ] as const) {
      const [digest, count] = helperPrefixes[name];
      const groups = decodeCatalog(path.join(ROOT, 'scripts/lib/independent-admission', file), key) as unknown[];
      expect(groups.length, name).toBeGreaterThan(count);
      expect(jsonSha(groups.slice(0, count)), name).toBe(digest);
    }
    for (const file of [
      'qlever/scripts/sdk-execution-budget.py',
      'qlever/scripts/sdk-inner-materials.py',
      'qlever/scripts/sdk-toolchain-materials.py',
      'qlever/scripts/sdk-ptrace-execution.py',
      'qlever/scripts/sdk-generated-vma-originals.py',
      'qlever/scripts/sdk-coordinated-wait.py',
      '.github/workflows/qlever-readonly-normal-job.yml',
      'tests/scripts/candidate-producer-attempt-binding.test.ts',
    ]) expect(row(next, file).sha256, file).toBe({
      'qlever/scripts/sdk-execution-budget.py': 'a66aca9e68010a80cac474cb004c58c2244efe08f772c1215c74103dae68de80',
      'qlever/scripts/sdk-inner-materials.py': '3f9c3133523f8de6e5faec7946a5145ce6a09c7a299ca6f9e738d1f9c7a403f0',
      'qlever/scripts/sdk-toolchain-materials.py': 'ab1f10f7641c638c15f43e32db2eb7542ae5ee2fbec397bc83e35dd6a79596cc',
      'qlever/scripts/sdk-ptrace-execution.py': 'c12b639308e9221825d87b9c4e2e48ed88265cd67555231694a618a98d4025bc',
      'qlever/scripts/sdk-generated-vma-originals.py': 'dc7aa03908fdd1eae3bc4d474fc4045b1b09a49568c446709fb2b78a2c326c1f',
      'qlever/scripts/sdk-coordinated-wait.py': '9870836b5b0cb69d55495ec4923c6800046aa52cdd1741219308df4149c1281a',
      '.github/workflows/qlever-readonly-normal-job.yml': '69c59abc132646596c6a370d642fc9a11a27a0e4d5bae3bc728c103483c8f39d',
      'tests/scripts/candidate-producer-attempt-binding.test.ts': '3e0f2ca3fdbfba54f3af985450413e45087e32cf2193470a9ba2568590612ca6',
    }[file]);
  });

  it('keeps SDK88 historical candidate bytes while the current normal group binds current bytes', () => {
    const frozen = SDK[87]!;
    const candidate = '.github/workflows/candidate.yml';
    const expected = '4411f065fba095c9f3bb6c3962a668cb26c869b80ea702860d50fb89397077bb';
    expect(frozen.sourceBindings[0]).toEqual({path: candidate, sha256: expected});
    expect(frozen.candidateServiceRelationship!.workflowSha256).toBe(expected);
    expect(frozen.outerExecutor!.additionalWorkflows!.find((row: any) => row.path === candidate)!.sha256).toBe(expected);
    expect(frozen.secondarySelectorStages![1]![0]).toEqual({path: candidate, sha256: expected});
    const current = CURRENT_SDK.at(-1)!;
    expect(current.candidateServiceRelationship!.sdkBuildExecutionModel).toBe('normal-build-v1');
    expect(current.candidateServiceRelationship!.workflowSha256).toBe(sha(candidate));
    expect(current.sourceBindings.find((row: any) => row.path === candidate)!.sha256).toBe(sha(candidate));
  });

  it('binds the explicit new policy declaration and rejects unknown/missing policy', () => {
    const source = readFileSync(path.join(ROOT, 'qlever/scripts/sdk-execution-budget.py'), 'utf8');
    expect(source).toContain("'phase-parent-v1'");
    expect(source).toContain("'run-minus-reserve'");
    expect(source).toContain("'phase-parent'");
    expect(source).toContain("raise ValueError('unknown phase budget policy version')");
  });
});
