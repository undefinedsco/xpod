import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRuntimeClientInput } from '../scripts/producer-input';

test('the published SDK input is mandatory and cannot silently resolve a workspace client', () => {
  expect(() => resolveRuntimeClientInput([])).toThrow('--client-package');
  expect(() => resolveRuntimeClientInput(['--client-package'])).toThrow('path');
  expect(() => resolveRuntimeClientInput(['--client-package', 'a', '--client-package', 'b'])).toThrow('exactly one');
});

test('a selected SDK directory must have the runtime-client identity', () => {
  const base=path.resolve(import.meta.dir,'../../../.test-data/runtime-client-input');mkdirSync(base,{recursive:true});
  const root=mkdtempSync(path.join(base,'case-'));
  try {
    writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@undefineds.co/other',version:'0.1.0'}));
    expect(()=>resolveRuntimeClientInput(['--client-package',root])).toThrow('identity');
    writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@undefineds.co/xpod-client',version:'0.1.0'}));
    expect(resolveRuntimeClientInput(['--client-package',root])).toBe(root);
  }finally{rmSync(root,{recursive:true,force:true});}
});
