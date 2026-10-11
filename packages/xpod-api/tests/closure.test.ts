import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInputs } from '../scripts/closure';
test('canonical API input is retained and host/CLI input blocks packaging', () => {
  const result = classifyInputs([{path:'src/api/main.ts',bytes:20},{path:'src/cli/commands/start.ts',bytes:30},{path:'src/runtime/bootstrap.ts',bytes:40}], '/repo');
  assert.equal(result.inputs.length,3);
  assert.deepEqual(result.blockers,['forbidden_runtime_input:src/cli/commands/start.ts','service_host_input:src/runtime/bootstrap.ts']);
});
test('native authority and outside source cannot be silently dropped', () => {
  assert.deepEqual(classifyInputs([{path:'../foreign.ts',bytes:1},{path:'node_modules/addon/a.node',bytes:1}], '/repo').blockers,['input_outside_repository','native_input_requires_platform_authority:node_modules/addon/a.node']);
});
