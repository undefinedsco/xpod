import {it,expect} from 'bun:test';
import {moduleSourceInputCaptureBoundary} from '../../scripts/lib/independent-admission/module-source-phases';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import path from 'node:path';
const {readBoundedJsonOriginal}=createRequire(import.meta.url)('../../scripts/api-producer-dependencies.cjs');
it('capture is after actual postinstall and before declarations only for the exact new lifecycle',()=>{
 expect(moduleSourceInputCaptureBoundary({})).toEqual({after:0,before:1});
 const receipt={kind:'api-module-product-production',workspaceRecipe:'api-ui-root-minimal-v2',phases:['install-selection','install','postinstall','declarations','install-graph'].map(name=>({name}))};
 expect(moduleSourceInputCaptureBoundary(receipt)).toEqual({after:2,before:3});
 expect(()=>moduleSourceInputCaptureBoundary({...receipt,workspaceRecipe:'other'})).toThrow();expect(()=>moduleSourceInputCaptureBoundary({...receipt,phases:receipt.phases.slice(1)})).toThrow();expect(()=>moduleSourceInputCaptureBoundary({...receipt,kind:'css-module-product-production'})).toThrow();
});
it('retained projection is a bounded ordinary original, never a symlink or oversized JSON',()=>{
 const parent=path.resolve(import.meta.dir,'../../.test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(path.join(parent,'selection-original-'));
 try{const file=path.join(root,'selection');writeFileSync(file,'{"actual":1}');expect(readBoundedJsonOriginal(file)).toEqual({actual:1});symlinkSync(file,path.join(root,'link'));expect(()=>readBoundedJsonOriginal(path.join(root,'link'))).toThrow();writeFileSync(file,Buffer.alloc(4194305));expect(()=>readBoundedJsonOriginal(file)).toThrow('Bounded regular');}finally{rmSync(root,{recursive:true,force:true});}
});
