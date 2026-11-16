import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {currentProgramNormalSourceGroups,currentProgramSdkConsumerGroups,currentProgramLinuxConsumerGroups} from '../../scripts/lib/independent-admission/current-program-definition';
import {normalWorkflowVersions} from '../../scripts/lib/independent-admission/github-origin';
import {resolveCandidateWorkflowContract} from '../../scripts/lib/independent-admission/qlever-sdk-originals';
import {QLEVER_NORMAL_SOURCE_GROUPS,QLEVER_LINUX_CONSUMER_GROUPS,QLEVER_SDK_CONSUMER_GROUPS,QLEVER_SDK_EXECUTION_GROUPS} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import type {GitHubSourceBinding, GitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';

/** The CURRENT program definition is program-owned expectation data derived from
 * this checkout. It is not a source/artifact capability, so there is no opaque
 * issuer to forge here; the negatives below are the real selection invariants:
 * frozen history never moves, only the workflow role floats, and an unrelated
 * workflow metadata change needs no new literal anywhere. */

const CANDIDATE='.github/workflows/candidate.yml';
const ROOT=path.resolve(import.meta.dir,'../..');
const expectedWorkflow=createHash('sha256').update(readFileSync(path.join(ROOT,CANDIDATE))).digest('hex');
const last=<T>(rows:readonly T[]):T=>rows[rows.length-1]!;
const allRoles=(group:GitHubSourceBindingGroup):readonly GitHubSourceBinding[]=>[
  ...group.selectors,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings,
];
const nonWorkflow=(group:GitHubSourceBindingGroup)=>allRoles(group).filter(row=>row.path!==CANDIDATE);
const workflowRows=(group:GitHubSourceBindingGroup)=>allRoles(group).filter(row=>row.path===CANDIDATE);
const workflowShas=(group:GitHubSourceBindingGroup)=>[...new Set(workflowRows(group).map(row=>row.sha256))];

test('the derived CURRENT definition tracks this checkout without a copied workflow literal',()=>{
  const normal=currentProgramNormalSourceGroups();
  expect(normal.slice(0,-1)).toEqual(QLEVER_NORMAL_SOURCE_GROUPS);
  expect(workflowShas(last(normal))).toEqual([expectedWorkflow]);
  // Only the workflow role moves: every other selector/stage/source row is inherited.
  expect(nonWorkflow(last(normal))).toEqual(nonWorkflow(last(QLEVER_NORMAL_SOURCE_GROUPS)));
  const consumer=currentProgramSdkConsumerGroups();
  expect(consumer.slice(0,-1)).toEqual(QLEVER_SDK_CONSUMER_GROUPS);
  expect(workflowShas(last(consumer))).toEqual([expectedWorkflow]);
  expect(nonWorkflow(last(consumer))).toEqual(nonWorkflow(last(QLEVER_SDK_CONSUMER_GROUPS)));
  expect(last(consumer).candidateServiceRelationship?.workflowSha256).toBe(expectedWorkflow);
  const linux=currentProgramLinuxConsumerGroups();
  expect(linux.slice(0,-1)).toEqual(QLEVER_LINUX_CONSUMER_GROUPS);
  expect(nonWorkflow(last(linux))).toEqual(nonWorkflow(last(QLEVER_LINUX_CONSUMER_GROUPS)));
});

test('the derived bytes are selectable while the frozen published versions remain accepted',()=>{
  expect(normalWorkflowVersions()).toContain(expectedWorkflow);
  // Every frozen normal candidate row is still accepted history.
  for(const group of QLEVER_NORMAL_SOURCE_GROUPS){
    for(const row of workflowRows(group)) expect(normalWorkflowVersions()).toContain(row.sha256);
  }
  const contract=resolveCandidateWorkflowContract(expectedWorkflow);
  expect(contract).toBeDefined();
  expect(contract!.workflowSha256).toBe(expectedWorkflow);
  // The frozen SDK-execution producer axis is history: its normal-build producer
  // contract must NOT gain the current consumer bytes just because they derived.
  const frozenProducer=new Set<string>();
  for(const group of QLEVER_SDK_EXECUTION_GROUPS){
    const sha=group.candidateServiceRelationship?.workflowSha256;
    if(typeof sha==='string') frozenProducer.add(sha);
  }
  expect(frozenProducer.has(expectedWorkflow)).toBe(false);
});

test('an unknown workflow hash is not admitted by either derived axis',()=>{
  const unknown='f'.repeat(64);
  expect(unknown).not.toBe(expectedWorkflow);
  expect(normalWorkflowVersions()).not.toContain(unknown);
  expect(resolveCandidateWorkflowContract(unknown)).toBeUndefined();
  // Malformed input still fails closed rather than matching loosely.
  expect(()=>resolveCandidateWorkflowContract('not-a-hash')).toThrow();
});

test('the derivation does not depend on the process working directory',()=>{
  const parent=path.join(ROOT,'.test-data/current-program-definition');
  mkdirSync(parent,{recursive:true});
  const directory=mkdtempSync(path.join(parent,'cwd-'));
  try {
    const moduleUrl=new URL('../../scripts/lib/independent-admission/current-program-definition.ts',import.meta.url).href;
    const script=`import {currentProgramNormalSourceGroups} from ${JSON.stringify(moduleUrl)};
const groups=currentProgramNormalSourceGroups();
const last=groups[groups.length-1];
const rows=[...last.selectors,...(last.secondarySelectors??[]),...(last.secondarySelectorStages??[]).flat(),...last.sourceBindings];
process.stdout.write([...new Set(rows.filter(row=>row.path==='${CANDIDATE}').map(row=>row.sha256))].join(','));`;
    const result=spawnSync(process.execPath,['--no-env-file','-e',script],{cwd:directory,encoding:'utf8',env:{...process.env}});
    expect(result.error).toBeUndefined();
    expect(result.stderr ?? '').toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedWorkflow);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('the factory accepts no caller-supplied hash, path or environment override',()=>{
  // The only inputs are the module's own checkout. A caller object cannot become
  // an expected hash, and the resolver still matches exact bytes only.
  expect(currentProgramNormalSourceGroups.length).toBe(0);
  expect(currentProgramSdkConsumerGroups.length).toBe(0);
  expect(currentProgramLinuxConsumerGroups.length).toBe(0);
  expect(resolveCandidateWorkflowContract(expectedWorkflow)!.workflowSha256).toBe(expectedWorkflow);
  expect(()=>resolveCandidateWorkflowContract({workflowSha256:expectedWorkflow} as never)).toThrow();
});
