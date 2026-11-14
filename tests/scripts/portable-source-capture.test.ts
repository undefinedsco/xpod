import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

describe('portable actual input capture mechanics', () => {
  it('writes sharded originals without a Git checkout and rejects a changed installed input', () => {
    const parent = path.resolve('.test-data/portable-source-capture'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'tiny-'));
    try {
      const output = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `import importlib.util,sys,pathlib,json,os
spec=importlib.util.spec_from_file_location('materials',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);repo=root/'workspace';repo.mkdir();out=root/'originals';out.mkdir();tools=root/'tools';tools.mkdir()
(repo/'package.json').write_text('{"private":true}');(repo/'node_modules/pkg').mkdir(parents=True);dep=repo/'node_modules/pkg/index.js';dep.write_text('export const value=1;')
# Test-owned tiny tool programs keep this mechanics test below a megabyte.
for name in ['bun','node','python3','git']:
 tool=tools/name;tool.write_text('#!/bin/sh\\necho tiny-owned-tool-1\\n');tool.chmod(0o755)
m.shutil.which=lambda name:str(tools/name)
inputs=m.capture_inputs(repo,out,['package.json'])
assert inputs['dependencies']['archives'] and inputs['toolchain']['archives']
ref=m.capture_outputs(repo,out,inputs,[],{'kind':'cli-client-dist-inventories'},output_rows=[{'path':'cli/dist/output.mjs','bytes':1,'sha256':'a'*64,'mode':420}])
master=json.loads((out/ref['path']).read_text());assert master['revalidation']['dependencies']
second=root/'changed';second.mkdir();inputs=m.capture_inputs(repo,second,['package.json']);dep.write_text('export const value=2;')
try:m.revalidate_inputs(repo,second,inputs)
except ValueError as error:assert 'changed during production' in str(error)
else:raise AssertionError('changed installed dependency admitted')
print(json.dumps({'master':ref['path'],'mutationRejected':True}))`, path.resolve('scripts/lib/module-source-materials.py'), root], { encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({ master: 'source-materials/materials.json', mutationRejected: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
