import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as s from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import * as c from '../../scripts/lib/independent-admission/consumer-observer-policy';
import * as g from '../../scripts/lib/independent-admission/github-origin';
import {CLI_SOURCE_VERSION_GROUPS} from '../../scripts/lib/independent-admission/source-rules';

/** Whole-group hash over the raw parsed group (JSON.stringify, as the existing guards do). */
const whole=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * PR159 immutable predecessor constants. Each value was computed ONCE from the
 * published baseline PUBLISHED-1CC4.json.gz parsed as data and hashed with the plain
 * JSON.stringify rule used by the other registration guards. They are literals here,
 * never derived from the live groups, so a predecessor edit cannot keep this green.
 */
const PREDECESSOR = {
  sdkExecution92: 'eadffb8dc9b6b4965a2d99bdac22e48f64388150830219c27f65dbaef5e0033f',
  linuxExecution93: 'eadffb8dc9b6b4965a2d99bdac22e48f64388150830219c27f65dbaef5e0033f',
  normalBuild2: '03287a41a7d777bf689e043ee2afc3901093e53f2a3ecb2acd027bd66e30d491',
  api30: 'b461d1a672fbe3fdff729c96034c46985186c7741d61dd0c3be1b4e2b91f5c2c',
  cli13: 'ef1828d0b6b42a220e03439507f93da7e6c5e23572788442e3c89f539c724e4c',
  sdkConsumer107: '44342dc66fb5bd1deddc1ae0f8df06e20eba48c897dadd102bdda970e4a22d10',
  linuxConsumer108: '44342dc66fb5bd1deddc1ae0f8df06e20eba48c897dadd102bdda970e4a22d10',
  consumer103: '7b070b897685b359262746aa50232d9154c718eb78093fbe92a8cd6bcd157ddf',
  ci210: 'f1e63e5834d096a4128af09c6614d12af61188dd43ff846389007db7487811e2',
  ci211: '66805e04b183ac74320bb5e375e6a1411060c5b4eb9ee950d48cd74e88d68d03',
} as const;

test('PR159: all ten immutable prior tails stay byte-identical to the published baseline', () => {
  expect(whole(s.QLEVER_SDK_EXECUTION_GROUPS[92]!)).toBe(PREDECESSOR.sdkExecution92);
  expect(whole(s.QLEVER_LINUX_EXECUTION_GROUPS[93]!)).toBe(PREDECESSOR.linuxExecution93);
  expect(whole(s.QLEVER_NORMAL_BUILD_GROUPS[2]!)).toBe(PREDECESSOR.normalBuild2);
  expect(whole(g.API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS[30])).toBe(PREDECESSOR.api30);
  expect(whole(CLI_SOURCE_VERSION_GROUPS[13]!)).toBe(PREDECESSOR.cli13);
  expect(whole(s.QLEVER_SDK_CONSUMER_GROUPS[107]!)).toBe(PREDECESSOR.sdkConsumer107);
  expect(whole(s.QLEVER_LINUX_CONSUMER_GROUPS[108]!)).toBe(PREDECESSOR.linuxConsumer108);
  expect(whole(c.CONSUMER_SOURCE_GROUPS[103]!)).toBe(PREDECESSOR.consumer103);
  expect(whole(c.CI_CONSUMER_SOURCE_GROUPS[210]!)).toBe(PREDECESSOR.ci210);
  expect(whole(c.CI_CONSUMER_SOURCE_GROUPS[211]!)).toBe(PREDECESSOR.ci211);
});

test('PR159: historical producer axes keep their published counts; only consumer axes grew', () => {
  expect(s.QLEVER_SDK_EXECUTION_GROUPS).toHaveLength(93);
  expect(s.QLEVER_LINUX_EXECUTION_GROUPS).toHaveLength(94);
  expect(s.QLEVER_NORMAL_BUILD_GROUPS).toHaveLength(3);
  expect(s.QLEVER_NORMAL_SOURCE_GROUPS).toHaveLength(5);
  expect(s.QLEVER_SDK_NORMAL_SOURCE_BINDINGS).toHaveLength(23);
  expect(s.QLEVER_SDK_CONSUMER_GROUPS).toHaveLength(109);
  expect(s.QLEVER_LINUX_CONSUMER_GROUPS).toHaveLength(110);
  expect(c.CONSUMER_SOURCE_GROUPS).toHaveLength(105);
  expect(c.CI_CONSUMER_SOURCE_GROUPS).toHaveLength(214);
  expect(g.API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS).toHaveLength(32);
  expect(CLI_SOURCE_VERSION_GROUPS).toHaveLength(15);
});

test('PR159: both consumer arrays reference ONE new SDK109 object with 15 stages', () => {
  const sdkTail=s.QLEVER_SDK_CONSUMER_GROUPS[108]!;
  expect(s.QLEVER_LINUX_CONSUMER_GROUPS[109]).toBe(sdkTail);
  expect(sdkTail).not.toBe(s.QLEVER_SDK_CONSUMER_GROUPS[107]);
  expect((sdkTail as any).secondarySelectorStages).toHaveLength(15);
});

test('PR159: the CURRENT API alias is API32 and API31 keeps its own frozen bindings', () => {
  const api=g.API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as any[];
  expect(g.API_SERVICE_BUILD_SOURCE_BINDINGS).toBe(api[31].sourceBindings);
  expect(api[31].sourceBindings).not.toBe(api[30].sourceBindings);
});

/** API (GitHub-shaped) resolver positives and negatives via the REAL selection API.
 *
 * The pure selector is deterministic given a complete observed map, so the tests seed
 * observations for EVERY declared role from real disk bytes (the same values the
 * production observer would read) and then perturb only the case under test.
 */
import {selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';

const diskHash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const apiGroups=()=>g.API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as any[];
const rolesOf=(group:any)=>[...(group.selectors??[]),...(group.secondarySelectors??[]),
  ...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings];

/** Complete observation for the CURRENT working tree. */
function completeObservedForApi(){
  const observed=new Map<string,string>();
  for(const role of rolesOf(apiGroups()[31])){
    if(role.ref==='run-head')continue;
    observed.set(sourceBindingKey({path:role.path,sha256:''}),diskHash(role.path));
  }
  return observed;
}

test('PR159 API: the CURRENT tree selects API32 uniquely', () => {
  const selected=selectGitHubSourceBindingGroup(apiGroups(),completeObservedForApi());
  expect(selected).toBe(apiGroups()[31]);
});

test('PR159 API: an all-old-bytes tree selects API31 uniquely', () => {
  const api=apiGroups();
  const observed=completeObservedForApi();
  // Force the two promoted roles back to their API31 declared bytes; selection must
  // then land on the frozen tuple, proving the promotion really separates old/new.
  for(const path of ['package.json','bun.lock']){
    const old=api[30].sourceBindings.find((r:any)=>r.path===path);
    const cur=api[31].sourceBindings.find((r:any)=>r.path===path);
    if(old.sha256!==cur.sha256) observed.set(sourceBindingKey({path,sha256:''}),old.sha256);
  }
  expect(selectGitHubSourceBindingGroup(api,observed)).toBe(api[30]);
});

test('PR159 API: mixed old package + new lock is refused', () => {
  const api=apiGroups();
  const observed=completeObservedForApi();
  const oldPkg=api[30].sourceBindings.find((r:any)=>r.path==='package.json');
  const newLock=api[31].sourceBindings.find((r:any)=>r.path==='bun.lock');
  observed.set(sourceBindingKey({path:'package.json',sha256:''}),oldPkg.sha256);
  observed.set(sourceBindingKey({path:'bun.lock',sha256:''}),newLock.sha256);
  expect(()=>selectGitHubSourceBindingGroup(api,observed)).toThrow();
});

test('PR159 API: a missing requested role is refused', () => {
  const observed=completeObservedForApi();
  observed.delete(sourceBindingKey({path:'package.json',sha256:''}));
  expect(()=>selectGitHubSourceBindingGroup(apiGroups(),observed)).toThrow();
});
