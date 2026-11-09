'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const added=['scripts/service-pack-input-custody.cjs','scripts/service-pack-copy-ledger.cjs','scripts/service-pack-source-body.py','scripts/service-pack-public-inputs.cjs','scripts/service-pack-command.py'];
test('Docker whitelist adds only the three exact new execution paths and every body/helper exists',()=>{
 const lines=fs.readFileSync('.dockerignore','utf8').split(/\r?\n/u);for(const file of added){assert.equal(lines.filter(line=>line==='!'+file).length,1);assert.equal(fs.lstatSync(file).isFile(),true);}assert.equal(lines.includes('!scripts/**'),false);assert.equal(lines.includes('!scripts/'),false);
 const source=fs.readFileSync('scripts/service-pack-originals.cjs','utf8');for(const name of ['service-pack-input-custody.cjs','service-pack-copy-ledger.cjs','service-pack-source-body.py'])assert.ok(source.includes(name));
 const receiver=fs.readFileSync('scripts/lib/independent-admission/candidate-service-pack-output.ts','utf8');for(const file of [...added,'scripts/service-pack-phase.cjs','scripts/lib/module-artifact-limits.json'])assert.ok(receiver.includes("'"+file+"'"));
 for(const file of added.filter(file=>file.endsWith('.cjs')))assert.ok(require(path.resolve(file)));
});
