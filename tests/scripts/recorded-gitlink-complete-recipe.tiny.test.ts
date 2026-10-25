import preSdk47 from '../fixtures/independent-admission/pre-sdk47-api-originals.original.json';
import{preServicePackOriginal}from'./pre-service-pack-api-originals';
import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
import preCompression from '../fixtures/independent-admission/pre-compression-api-originals.json';
import preShared from '../fixtures/independent-admission/pre-sdk46-shared-api-originals.original.json';
import before from '../fixtures/independent-admission/pre-recorded-gitlink-source.original.json';
import{API_PACK_SUPERVISION_SOURCE_BINDINGS as oldRows,API_RECORDED_GITLINK_SOURCE_BINDINGS as newRows,API_SERVICE_BUILD_SOURCE_BINDINGS as currentRows}from'../../scripts/lib/independent-admission/github-origin';
import{controlledApiSourceRecipe}from'../../scripts/lib/independent-admission/module-source-phases';
const preSdk47Original=(name:string)=>{const row=preSdk47.files.find(row=>row.path===name);if(!row)return undefined;const raw=Buffer.from(row.rawBase64,'base64');if(raw.length!==row.bytes||createHash('sha256').update(raw).digest('hex')!==row.sha256)throw Error('Invalid pre-SDK47 immutable Git original');return raw;};
const root=path.resolve(import.meta.dirname,'../..'),fixed='packages/xpod-api/scripts/inngest-website-gitlink.original.json',actual=(name:string)=>fs.readFileSync(path.join(root,name)),hash=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
test('actual historical HTTP and reviewed recorded Gitlink source recipes select as complete immutable trees',()=>{
 const prior=new Map(preShared.files.map(row=>{const raw=Buffer.from(row.rawBase64,'base64');expect(raw.length).toBe(row.bytes);expect(hash(raw)).toBe(row.sha256);return[row.path,raw] as const;}));
 const recorded=(name:string)=>{const row=preCompression.files.find(row=>row.path===name);if(!row)return preServicePackOriginal(name)??prior.get(name)??preSdk47Original(name)??actual(name);const raw=Buffer.from(row.rawBase64,'base64');expect(raw.length).toBe(row.bytes);expect(hash(raw)).toBe(row.sha256);return raw;};
 const requested:string[]=[],old=(name:string)=>{requested.push(name);if(name===fixed)throw Error('old recipe must never read a future original');const row=before.files.find(row=>row.path===name);if(!row)return recorded(name);const raw=Buffer.from(row.base64,'base64');expect(raw.length).toBe(row.bytes);expect(hash(raw)).toBe(row.sha256);return raw;};
 const producer=hash(actual('scripts/api-module-producer.py'));
 expect(controlledApiSourceRecipe(old,producer,'linux-arm64').rows).toBe(oldRows);expect(requested).not.toContain(fixed);expect(oldRows.some(row=>row.path===fixed)).toBe(false);
 for(const target of['linux-arm64','linux-x64','darwin-arm64','darwin-x64']){expect(controlledApiSourceRecipe(recorded,producer,target).rows).toBe(newRows);expect(controlledApiSourceRecipe(actual,producer,target).rows).toBe(currentRows);}
 expect(newRows).toHaveLength(81);expect(newRows.find(row=>row.path===fixed)?.sha256).toBe('99a5f5b1739ce3d02ed3f15d51e297f060c60bbd5b82d1850f7ad1abcbf5c74d');
 for(const row of before.files)expect(()=>controlledApiSourceRecipe(name=>name===row.path?old(name):actual(name),producer,'linux-arm64')).toThrow();
 expect(()=>controlledApiSourceRecipe(name=>name===fixed?Buffer.from('{}'):actual(name),producer,'linux-arm64')).toThrow('source recipe mismatch');
 expect(()=>controlledApiSourceRecipe(name=>{if(name===fixed)throw Error('missing recorded original');return actual(name);},producer,'linux-arm64')).toThrow('missing recorded original');
});
