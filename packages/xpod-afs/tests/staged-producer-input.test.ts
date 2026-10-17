import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withStagedProducerInput } from '../scripts/staged-producer-input';
import type { resolveProducerInput } from '../scripts/producer-input';

function fixture() {
  const base=path.resolve(import.meta.dir,'../../../.test-data/staged-producer');mkdirSync(base,{recursive:true});
  const parent=mkdtempSync(path.join(base,'case-')),root=path.join(parent,'original');mkdirSync(root);
  writeFileSync(path.join(root,'index.json'),'original');writeFileSync(path.join(root,'output.mjs'),'export const value=1;');
  const input={root,indexPath:path.join(root,'index.json'),toolsPath:path.join(root,'output.mjs'),tools:{async verifyProducerSourceArchive(){throw new Error('staging must not call tools');},collectJavascriptNotices(){throw new Error('staging must not call tools');}},assertCurrent(){},resolveImport(){return path.join(root,'output.mjs');}} satisfies ReturnType<typeof resolveProducerInput>;
  return {parent,root,input,stage:path.join(parent,'stage')};
}

test('staging projects only the complete artifact and cleans its temporary copy after use', async()=>{
  const f=fixture();
  try {
    await withStagedProducerInput(f.input,f.stage,async staged=>{
      expect(staged.root).not.toBe(f.root);expect(staged.resolveImport('output').startsWith(staged.root)).toBe(true);
      staged.assertCurrent();
    });
    expect(readdirSync(f.stage)).toEqual([]);
  }finally{rmSync(f.parent,{recursive:true,force:true});}
});

test('a changed copied artifact rejects and still cleans its temporary directory', async()=>{
  const f=fixture();
  try {
    await expect(withStagedProducerInput(f.input,f.stage,async staged=>{
      writeFileSync(path.join(staged.root,'output.mjs'),'changed');staged.assertCurrent();
    })).rejects.toThrow('inventory changed');
    expect(readdirSync(f.stage)).toEqual([]);
  }finally{rmSync(f.parent,{recursive:true,force:true});}
});

test('a new build receives a fresh live producer after the previous build has cleaned its inputs', async () => {
  const f = fixture();
  let previous = '';
  try {
    await withStagedProducerInput(f.input, f.stage, async staged => {
      previous = staged.resolveImport('output');
      expect(readFileSync(previous, 'utf8')).toContain('value=1');
    });
    expect(existsSync(previous)).toBe(false);
    await withStagedProducerInput(f.input, f.stage, async staged => {
      const current = staged.resolveImport('output');
      expect(current).not.toBe(previous);
      expect(readFileSync(current, 'utf8')).toContain('value=1');
      staged.assertCurrent();
    });
    expect(readdirSync(f.stage)).toEqual([]);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test('mutation of original producer during packaging rejects and cleans the staged copy', async () => {
  const f = fixture();
  try {
    await expect(withStagedProducerInput(f.input, f.stage, async () => {
      writeFileSync(path.join(f.root, 'output.mjs'), 'changed original');
    })).rejects.toThrow('inventory changed');
    expect(readdirSync(f.stage)).toEqual([]);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});
