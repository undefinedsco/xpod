import {test,expect} from 'bun:test';
import {immutableGitContentsEndpoint,cachedGitContentsOriginal,retainGitContentsOriginal} from '../../scripts/lib/independent-admission/github-immutable-original-cache';
const endpoint='https://api.github.com/repos/undefinedsco/xpod/contents/bun.lock?ref='+'f'.repeat(40);
test('immutable response cache retains copies and never caches moving metadata',()=>{
 const body=Buffer.from('{"type":"file"}');retainGitContentsOriginal(endpoint,body);body.fill(0);
 const first=cachedGitContentsOriginal(endpoint)!;expect(first.toString()).toBe('{"type":"file"}');first.fill(0);
 expect(cachedGitContentsOriginal(endpoint)!.toString()).toBe('{"type":"file"}');
 for(const moving of [endpoint.replace('f'.repeat(40),'staging'),endpoint.replace('contents/bun.lock?ref='+'f'.repeat(40),'actions/runs/1'),endpoint.replace('bun.lock','../bun.lock')]){
 expect(immutableGitContentsEndpoint(moving)).toBe(false);retainGitContentsOriginal(moving,Buffer.from('{}'));expect(cachedGitContentsOriginal(moving)).toBe(undefined);
 }
});
test('contents byte ceiling can cover lockfile base64 without caching oversized responses',()=>{
 const key=endpoint.replace('bun.lock','oversized.json');retainGitContentsOriginal(key,Buffer.alloc(2*1024**2+1));expect(cachedGitContentsOriginal(key)).toBe(undefined);
});
