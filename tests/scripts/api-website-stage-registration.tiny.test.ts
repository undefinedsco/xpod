import preSdk47 from '../fixtures/independent-admission/pre-sdk47-api-originals.original.json';
import{preServicePackOriginal}from'./pre-service-pack-api-originals';
import preCompression from '../fixtures/independent-admission/pre-compression-api-originals.json';
import preRecorded from '../fixtures/independent-admission/pre-recorded-gitlink-source.original.json';
import legacy from '../fixtures/independent-admission/notice-pre-api17-source.original.json';
import {API_SERVICE_BUILD_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as groups,API_WEBSITE_SOURCE_BINDINGS as previous,API_WEBSITE_STAGE_SOURCE_BINDINGS as current} from '../../scripts/lib/independent-admission/github-origin';
import {CONSUMER_SOURCE_GROUPS as c,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup as select,secondaryGitHubSourceBindingSelectors as secondary,sourceBindingKey as key} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {controlledApiSourceRecipe} from '../../scripts/lib/independent-admission/module-source-phases';
import tcb from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const preSdk47Original=(name:string)=>{const row=preSdk47.files.find(row=>row.path===name);if(!row)return undefined;const raw=Buffer.from(row.rawBase64,'base64');if(raw.length!==row.bytes||createHash('sha256').update(raw).digest('hex')!==row.sha256)throw Error('Invalid pre-SDK47 immutable Git original');return raw;};
const read=(p:string)=>fs.readFileSync(path.resolve(import.meta.dir,'../..',p)),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const role='scripts/lib/inngest-controlled-materials.ts',stage='packages/xpod-api/scripts/controlled-native-material.ts',producer='bd668dc98e481496f8b2cf6a1ba97541caafc70f39acf8d8757226e4cedca588';
const legacyRead=(p:string)=>{const compressed=preCompression.files.find(row=>row.path===p);if(compressed){const raw=Buffer.from(compressed.rawBase64,'base64');expect(raw.length).toBe(compressed.bytes);expect(sha(raw)).toBe(compressed.sha256);return raw;}const prior=preRecorded.files.find(row=>row.path===p);if(prior){const raw=Buffer.from(prior.base64,'base64');expect(raw.length).toBe(prior.bytes);expect(sha(raw)).toBe(prior.sha256);return raw;}if(p==='scripts/agentfs-native-ci/supervise.py')return read('tests/fixtures/independent-admission/pre-pack-supervisor.original.txt');const row=legacy.files.find(row=>row.path===p);if(!row)return preServicePackOriginal(p)??preSdk47Original(p)??read(p);const raw=Buffer.from(row.base64,'base64');expect(raw.length).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);return raw;};
const old=(p:string)=>p===role?read('tests/fixtures/independent-admission/controlled-pre-stage-0.original.txt'):p===stage?read('tests/fixtures/independent-admission/controlled-pre-stage-1.original.txt'):legacyRead(p);
test('stage fifth original and index guards add an atomic source tree while all old source trees remain exact',()=>{
 expect(groups).toHaveLength(27);expect(c).toHaveLength(71);expect(ci).toHaveLength(140);expect(tcb).toHaveLength(422);expect(current).toHaveLength(75);
 expect(current.filter(row=>previous.find(old=>old.path===row.path)?.sha256!==row.sha256).map(row=>row.path).sort()).toEqual([stage,role].sort());
 for(const row of [...API_SERVICE_BUILD_SOURCE_BINDINGS,...tcb])expect(sha(read(row.path))).toBe(row.sha256);
 expect(groups.find(g=>'name' in g&&g.name==='root-minimal-website-source-projection')!.sourceBindings).toBe(previous);
 for(const group of groups){const primary=new Map(group.selectors.map(row=>[key(row),row.sha256]));const roles=secondary(groups,primary);expect(roles.some(row=>row.path===role)).toBe(group.selectors.some(row=>row.path==='scripts/api-module-producer.py'&&row.sha256===producer));for(const binding of roles){const original=group.sourceBindings.find(row=>key(row)===key(binding));expect(original).toBeDefined();primary.set(key(binding),original!.sha256);}expect(select(groups,primary)).toBe(group);}
 expect(controlledApiSourceRecipe(legacyRead,producer,'linux-arm64').rows).toBe(current);expect(controlledApiSourceRecipe(old,producer,'linux-arm64').rows).toBe(previous);
 expect(()=>controlledApiSourceRecipe(p=>p===role?old(p):legacyRead(p),producer,'linux-arm64')).toThrow('source recipe mismatch');
 const latest=groups.find(g=>'name' in g&&g.name==='root-minimal-website-stage-closed-originals')!;const facts=new Map([...latest.selectors,...latest.secondarySelectors??[]].map(row=>[key(row),row.sha256]));facts.delete('source:'+role);expect(()=>select(groups,facts)).toThrow();facts.set('source:'+role,'0'.repeat(64));expect(()=>select(groups,facts)).toThrow();
});
