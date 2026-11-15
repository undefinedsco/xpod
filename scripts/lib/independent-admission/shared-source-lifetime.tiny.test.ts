import {test,expect} from 'bun:test';
import {sharedSourceLifetime} from './shared-source-lifetime';
import {openBoundOriginalFile} from './bound-original-file';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
test('releasing CLI does not close client source ranges; final release revokes the same fd',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'portable-shared-'));
 try{const file=path.join(root,'source.tar');fs.writeFileSync(file,'abc');const reader=openBoundOriginalFile(file,{path:'source.tar',bytes:3,sha256:createHash('sha256').update('abc').digest('hex')});
 let disposed=0,compacted=0;const lifetime=sharedSourceLifetime({compact(){compacted++;},dispose(){disposed++;reader.close();}});
 const cli=lifetime.retain(),client=lifetime.retain();cli();cli();expect(reader.readRange(0,3).toString()).toBe('abc');expect(disposed).toBe(0);
 lifetime.compact();lifetime.compact();expect(compacted).toBe(1);client();client();expect(disposed).toBe(1);expect(()=>reader.readRange(0,1)).toThrow();expect(()=>lifetime.retain()).toThrow('disposed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
