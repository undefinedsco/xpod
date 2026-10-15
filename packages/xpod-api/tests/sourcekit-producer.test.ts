import { API_BUILD_INTEGRATION_TIMEOUT_MS } from './repo-root';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeApiSourcekit, verifyApiSourcekitRoots } from '../scripts/sourcekit-producer';

test('streaming sourcekit producer preserves original bytes and modes with deterministic bounded archives', () => {
  const parent=path.resolve('.test-data/api-sourcekit-producer');fs.mkdirSync(parent,{recursive:true});
  const base=fs.realpathSync(fs.mkdtempSync(path.join(parent,'case-')));const input=base+'/input';fs.mkdirSync(input);
  fs.writeFileSync(input+'/source.ts','original bytes\n');fs.writeFileSync(input+'/tool',Buffer.alloc(1024*1024,42));fs.chmodSync(input+'/tool',0o755);
  fs.mkdirSync(input+'/node_modules');fs.writeFileSync(input+'/node_modules/excluded','nested original separately owned');
  const roots=[{directory:input,prefix:'originals/fixture'}];
  try{
    const a=writeApiSourcekit(base+'/a',roots,0),b=writeApiSourcekit(base+'/b',roots,0);
    assert.equal(a.kit.sha256,b.kit.sha256);assert.equal(a.budget.sourceMembers,3);
    const rows=JSON.parse(fs.readFileSync(a.kit.index,'utf8')).files;assert.equal(rows.find((row:any)=>row.path.endsWith('/tool')).mode,0o755);
    verifyApiSourcekitRoots(a.kit,roots,0);
    fs.writeFileSync(input+'/source.ts','drift');assert.throws(()=>verifyApiSourcekitRoots(a.kit,roots,0),/inventory drift/);fs.writeFileSync(input+'/source.ts','original bytes\n');
    assert.equal(rows.length,2);assert.equal(fs.readFileSync(input+'/source.ts','utf8'),'original bytes\n');
    assert.throws(()=>writeApiSourcekit(base+'/a',roots,0),/fresh/);
    assert.throws(()=>writeApiSourcekit(base+'/bound',roots,2*1024**3),/budget/);assert.equal(fs.existsSync(base+'/bound'),false);
    assert.throws(()=>writeApiSourcekit(base+'/duplicate',[...roots,...roots],0),/duplicate/);assert.equal(fs.existsSync(base+'/duplicate'),false);
    const long='x'.repeat(200);fs.writeFileSync(input+'/'+long,'x');assert.throws(()=>writeApiSourcekit(base+'/long',roots,0),/too long/);assert.equal(fs.existsSync(base+'/long'),false);fs.unlinkSync(input+'/'+long);
    fs.symlinkSync(input+'/source.ts',input+'/link');assert.throws(()=>writeApiSourcekit(base+'/link',roots,0),/symlink/);assert.equal(fs.existsSync(base+'/link'),false);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
}, API_BUILD_INTEGRATION_TIMEOUT_MS);
