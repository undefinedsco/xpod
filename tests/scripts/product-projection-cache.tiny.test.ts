import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {indexProductArchiveOnDisk,productDiskProjectionUsage,type ProductDiskInventory} from '../../scripts/lib/independent-admission/product-disk-inventory';
function archive(file:string,value:string){
 const result=spawnSync('python3',['-c',"import tarfile,gzip,io,sys; data=('{\"name\":\"'+sys.argv[2]+'\",\"version\":\"1.0.0\"}').encode(); t=tarfile.open(sys.argv[1],'w:gz',format=tarfile.USTAR_FORMAT); i=tarfile.TarInfo('package/package.json');i.mode=0o644;i.size=len(data);t.addfile(i,io.BytesIO(data));t.close()",file,value]);
 expect(result.status).toBe(0);
}
test('two genuine tgz projections alternate through the single active cache and retain all originals',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'product-lru-'));let first:ProductDiskInventory|undefined,second:ProductDiskInventory|undefined;
 try{
  const a=path.join(root,'first.tgz'),b=path.join(root,'second.tgz');archive(a,'first');archive(b,'second');
  first=await indexProductArchiveOnDisk(a);const identity=first.archive,rows=first.members;
  second=await indexProductArchiveOnDisk(b); // Evicts first projection without revoking facts.
  expect(productDiskProjectionUsage().count).toBe(1);
  expect(JSON.parse(first.readMember('package.json',1000).toString()).name).toBe('first');
  expect(JSON.parse(second.readMember('package.json',1000).toString()).name).toBe('second');
  for(let pass=0;pass<12;pass++){expect(JSON.parse(first.readMember('package.json',1000).toString()).name).toBe('first');expect(JSON.parse(second.readMember('package.json',1000).toString()).name).toBe('second');}
  first.compactProjection();first.compactProjection();
  second.compactProjection();const beforeInvalid=productDiskProjectionUsage();
  expect(()=>first!.readMember('missing',1000)).toThrow();
  expect(()=>first!.readMember('package.json',-1)).toThrow();
  expect(()=>first!.readMemberRange('package.json',-1,1)).toThrow();
  expect(()=>first!.readBoundMemberRange('package.json',0,65537)).toThrow();
  expect(productDiskProjectionUsage()).toEqual(beforeInvalid);
  expect(JSON.parse(first.readMember('package.json',1000).toString()).name).toBe('first');
  expect(productDiskProjectionUsage().count).toBe(1);
  expect(first.archive).toBe(identity);expect(first.members).toBe(rows);
  expect(fs.existsSync(a)&&fs.existsSync(b)).toBe(true);
  first.dispose();expect(()=>first!.readMember('package.json',1000)).toThrow('disposed');
 }finally{first?.dispose();second?.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('compacted projection cannot rehydrate from a mutated retained original',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'product-lru-negative-'));let product:ProductDiskInventory|undefined;
 try{
  const file=path.join(root,'product.tgz');archive(file,'actual');product=await indexProductArchiveOnDisk(file);product.compactProjection();
  fs.appendFileSync(file,'changed');
  expect(()=>product!.readBoundMemberRange('package.json',0,1)).toThrow('identity');
  expect(()=>product!.compactProjection()).toThrow('identity');
  expect(fs.existsSync(file)).toBe(true);
 }finally{product?.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
