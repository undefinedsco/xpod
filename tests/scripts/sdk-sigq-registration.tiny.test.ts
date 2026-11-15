import{test,expect}from'bun:test';import{createHash}from'node:crypto';
import{decodeCatalog}from'./sdk-helper-catalog.fixture';
import before from'../fixtures/independent-admission/pre-sdk-sigq-hashes.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';
import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('SigQ registration retains all 297 complete historical source recipes',()=>{for(const[k,v]of Object.entries({api,sdk,consumer,ci}))expect(v.slice(0,before.groups[k as keyof typeof before.groups].length).map(hash)).toEqual(before.groups[k as keyof typeof before.groups]);});
test('all 100 historical Python observer and helper recipes remain exact',()=>{
 for(const[key,hashes]of Object.entries(before.helpers)){
  const[file,name]=key.split('#');
  const decoded=decodeCatalog(file!,name!) as unknown[];
  expect(decoded.slice(0,hashes.length).map(hash)).toEqual(hashes);
 }
});

