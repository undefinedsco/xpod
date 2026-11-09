import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { copyAfsSourceKit } from '../scripts/javascript-materials';

test('module source kit copies the live held producer, not a same-named repository sibling', () => {
 const parent=path.resolve('.test-data/afs-source-kit');mkdirSync(parent,{recursive:true});const root=mkdtempSync(path.join(parent,'case-'));
 try {
  const repo=path.join(root,'repo'),logicalPath='packages/xpod-cli/dist/output.mjs',physicalPath=path.join(root,'held/output.mjs');
  mkdirSync(path.dirname(path.join(repo,logicalPath)),{recursive:true});mkdirSync(path.dirname(physicalPath),{recursive:true});
  writeFileSync(physicalPath,'actual held A');writeFileSync(path.join(repo,logicalPath),'different sibling B');
  const sha256=createHash('sha256').update(readFileSync(physicalPath)).digest('hex');let current=true;
  const commandBuild={assertCurrent(){if(!current)throw Error('revoked');},sourceBinding(name:string){return name===logicalPath?Object.freeze({physicalPath,logicalPath,sha256}):undefined;}};
  const destination=path.join(root,'kit');const inventory=copyAfsSourceKit({repoRoot:repo,destination,sourceFiles:[logicalPath],commandBuild});
  expect(readFileSync(path.join(destination,logicalPath),'utf8')).toBe('actual held A');expect(inventory).toEqual([{path:logicalPath,bytes:13,sha256}]);
  rmSync(path.join(repo,logicalPath));
  expect(copyAfsSourceKit({repoRoot:repo,destination,sourceFiles:[logicalPath],commandBuild})).toEqual(inventory);
  writeFileSync(physicalPath,'substitution');expect(()=>copyAfsSourceKit({repoRoot:repo,destination,sourceFiles:[logicalPath],commandBuild})).toThrow('changed');
  current=false;expect(()=>copyAfsSourceKit({repoRoot:repo,destination,sourceFiles:[logicalPath],commandBuild})).toThrow('revoked');
 } finally {rmSync(root,{recursive:true,force:true});}
});
