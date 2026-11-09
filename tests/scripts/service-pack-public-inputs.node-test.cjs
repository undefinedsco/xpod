'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseActualPackSelection}=require('../../scripts/service-pack-public-inputs.cjs');
const raw=Buffer.from('bun pack v1.4.2 (744846f84)\n\npacked 119B package.json\npacked 18B index.js\n\nactual-selected-input-fixture-1.0.0.tgz\n\nTotal files: 2\nUnpacked size: 137B\n');
test('actual observed Bun dry-run selects names without duplicating npm selection rules',()=>{const result=parseActualPackSelection(raw,'1.4.2');assert.deepEqual(result.files,['package.json','index.js']);assert.equal(result.filename,'actual-selected-input-fixture-1.0.0.tgz');assert.equal(Object.isFrozen(result.files),true);});
test('unknown format/version, missing or duplicate rows, unsafe paths and count mismatch reject',()=>{
 for(const bytes of [raw.subarray(0,-1),Buffer.from(raw.toString().replace('Total files: 2','Total files: 1')),Buffer.from(raw.toString().replace('packed 18B index.js','packed 18B package.json')),Buffer.from(raw.toString().replace('packed 18B index.js','packed 18B ../index.js')),Buffer.from(raw.toString().replace('package.json','manifest.json')),Buffer.from(raw.toString()+'unknown\n'),Buffer.from(raw.toString().replace('packed 18B','packed NaNB'))])assert.throws(()=>parseActualPackSelection(bytes,'1.4.2'));
 assert.throws(()=>parseActualPackSelection(raw,'1.4.3'));
});
