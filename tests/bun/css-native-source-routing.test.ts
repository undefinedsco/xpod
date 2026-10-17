import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {cssNativeProducer, productTargets} from '../../scripts/module-product-targets';
import {MODULE_TARGETS} from '../../packages/xpod-cli/src/module-catalog';
const workflow = (name: string): any => JSON.parse(execFileSync('bun', ['-e',
  'console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))'], {
  input: readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url),'utf8'), encoding: 'utf8',
}));

test('all CSS source routes project canonical target and real host without upgrading availability', () => {
  const rows = MODULE_TARGETS.map(row => cssNativeProducer(`${row.platform}-${row.arch}`));
  expect(rows.map(row=>row.target)).toEqual(productTargets('css').map(row=>row.target));
  for (const row of rows) {
    expect(row.workflow).toBe('.github/workflows/css-native-source.yml');
    expect(row.runner).toBe(productTargets('css').find(target=>target.target===row.target)!.runner);
    expect(row.producerWorkflow).toBe(row.platform==='darwin'
      ? '.github/workflows/build-qlever-macos-runtime.yml' : '.github/workflows/publish-qlever-runtime-sdk.yml');
  }
  expect(productTargets('css').filter(row=>!row.nativeSourceAvailable)).toHaveLength(3);
  expect(()=>cssNativeProducer('darwin-../../x64')).toThrow();
});

test('same-source workflow dispatches one native family and preserves exact immutable artifact outputs', () => {
  const source=workflow('css-native-source.yml');
  expect(source.jobs.macos.uses).toBe('./.github/workflows/build-qlever-macos-runtime.yml');
  expect(source.jobs.macos.with.target).toBe('${{ needs.resolve.outputs.target }}');
  expect(source.jobs.linux.uses).toBe('./.github/workflows/publish-qlever-runtime-sdk.yml');
  expect(source.jobs.linux.with.sdk_profile).toBe('module-bookworm-gcc12');
  expect(source.jobs.linux.with.source_commit).toBe('${{ github.sha }}');
  expect(source.concurrency['cancel-in-progress']).toBe(false);
  const sdk=workflow('publish-qlever-runtime-sdk.yml');
  for(const field of ['name','id','digest']) {
    expect(sdk.on.workflow_call.outputs[`native_artifact_${field}`].value)
      .toBe(`\${{ jobs.module_runtime_materials.outputs.artifact_${field} }}`);
  }
  expect(sdk.jobs.module_runtime_materials.uses).toBe('./.github/workflows/build-qlever-linux-runtime.yml');
  expect(sdk.jobs.module_runtime_materials.with.module_sdk_image).toBe('${{ needs.publish.outputs.image }}');
  const linux=workflow('build-qlever-linux-runtime.yml');
  expect(linux.jobs.runtime.with.prior_sdk_image).toBe('${{ inputs.module_sdk_image }}');
  expect(linux.jobs.archive.needs).toEqual(['resolve','runtime']);
  expect(linux.jobs.archive.steps.find((step:any)=>step.name==='Produce native source and ABI original materials').env.RUNTIME_IMAGE)
    .toBe('${{ needs.runtime.outputs.image }}');
});
