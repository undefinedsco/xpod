import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {normalWorkflowVersions,normalWorkflowVersionsFrom} from '../../scripts/lib/independent-admission/github-origin';
import {resolveCandidateWorkflowContract,resolveCandidateWorkflowContractFrom} from '../../scripts/lib/independent-admission/qlever-sdk-originals';
import {
  QLEVER_NORMAL_SOURCE_GROUPS, QLEVER_SDK_CONSUMER_GROUPS, QLEVER_SDK_EXECUTION_GROUPS,
  QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_SHA,
} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import type {CandidateServiceRelationshipContract} from '../../scripts/lib/independent-admission/qlever-sdk-service-relationship';
import type {GitHubSourceBinding, GitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';

/** RC385 normal-build authority wiring.
 *
 * Two real defects are covered here:
 *  A. the normal origin accepted only the published constant workflow hash, so a
 *     reviewed recipe could not name its own candidate-workflow bytes;
 *  B. the candidate job-chain contract was resolved from the FROZEN SDK-execution
 *     producer axis and demanded exactly one match, so a consumer axis that repeats
 *     an identical contract for the same hash refused.
 *
 * These are data/unit assertions over the real policy data and the real exported
 * helpers. They do NOT prove issued GitHub authority or a live run; a real RC is
 * still required. */

const CANDIDATE='.github/workflows/candidate.yml';
const DISK_WORKFLOW_SHA=createHash('sha256').update(readFileSync(CANDIDATE)).digest('hex');
const row=(path:string,sha256:string):GitHubSourceBinding=>({path,sha256});
const group=(sha256:string|undefined,extra:Partial<GitHubSourceBindingGroup>={}):GitHubSourceBindingGroup=>Object.freeze({
 selectors:Object.freeze([row('scripts/run-independent-publication.ts','a'.repeat(64))]),
 secondarySelectors:Object.freeze([]),
 sourceBindings:Object.freeze([
  row('scripts/run-independent-publication.ts','a'.repeat(64)),
  ...(sha256===undefined?[]:[row(CANDIDATE,sha256)]),
 ]),
 ...extra,
});
/** A COMPLETE real contract shape: the fields the real job chain actually reads. */
const contract=(workflowSha256:string,over:Partial<CandidateServiceRelationshipContract>={}):CandidateServiceRelationshipContractObject=>Object.freeze({
 schemaVersion:1,
 workflowPath:CANDIDATE,
 workflowSha256,
 serviceJob:'build_image',
 localRuntimeJob:'publish_qlever_local_runtime / publish',
 sdkJob:'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk',
 ...over,
});
type CandidateServiceRelationshipContractObject=CandidateServiceRelationshipContract;

test('normalWorkflowVersionsFrom accepts one closed declaration per group and de-duplicates',()=>{
 const older='1'.repeat(64), newer='2'.repeat(64);
 // Independent closed set: two reviewed generations, each naming its own bytes.
 const versions=normalWorkflowVersionsFrom([group(older),group(newer),group(older)]);
 expect(versions).toEqual([older,newer]);
 // Ordering is first appearance, and the result is frozen (a caller cannot mutate it).
 expect(Object.isFrozen(versions)).toBe(true);
});

test('a group naming different candidate hashes across roles is rejected, not unioned',()=>{
 const older='1'.repeat(64), newer='2'.repeat(64);
 // The same group declares TWO different candidate identities: malformed.
 const conflicting:GitHubSourceBindingGroup=Object.freeze({
  selectors:Object.freeze([row(CANDIDATE,older)]),
  secondarySelectors:Object.freeze([row(CANDIDATE,newer)]),
  sourceBindings:Object.freeze([row(CANDIDATE,older)]),
 });
 expect(()=>normalWorkflowVersionsFrom([conflicting])).toThrow(/conflicting candidate workflow versions/u);
});

test('a normal group with no candidate binding, or an invalid hash, fails closed',()=>{
 expect(()=>normalWorkflowVersionsFrom([group(undefined)])).toThrow(/must declare the candidate workflow bytes/u);
 expect(()=>normalWorkflowVersionsFrom([])).toThrow(/reviewed normal workflow versions required/u);
 const invalid:GitHubSourceBindingGroup=Object.freeze({
  selectors:Object.freeze([row(CANDIDATE,'not-a-hash')]),
  secondarySelectors:Object.freeze([]),
  sourceBindings:Object.freeze([row(CANDIDATE,'not-a-hash')]),
 });
 expect(()=>normalWorkflowVersionsFrom([invalid])).toThrow(/reviewed normal workflow hash required/u);
});

test('the production set derives from the normal axis and keeps the published constant',()=>{
 const versions=normalWorkflowVersions();
 // Every version is genuinely declared by a normal-source recipe.
 const declared=new Set<string>();
 for(const source of QLEVER_NORMAL_SOURCE_GROUPS as readonly GitHubSourceBindingGroup[]){
  for(const role of [...source.selectors,...(source.secondarySelectors??[]),
   ...(source.secondarySelectorStages??[]).flat(),...source.sourceBindings]){
   if(role.path===CANDIDATE) declared.add(role.sha256);
  }
 }
 for(const version of versions) expect(declared.has(version)).toBe(true);
 expect(new Set(versions).size).toBe(versions.length);
 // An older published workflow keeps working: the constant must be accepted.
 expect(versions).toContain(QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_SHA);
});

test('the ACTUAL on-disk candidate workflow is reviewed and resolves on the consumer axis',()=>{
 // Independent of any policy value: the bytes really in the tree.
 // CURRENT reviewed candidate bytes (this generation moved only the workspace
 // build+consumer ahead of the candidate-version transform in build_desktop_rc;
 // RC409 additionally compiles the root outputs BEFORE the desktop build).
 expect(DISK_WORKFLOW_SHA).toBe('f4295f934f6614c500700b596ffda917c6754fc2fed1b35d6ca170c51a5d4d6f');
 // The previously reviewed RC398 bytes stay accepted history, never replaced.
 expect(normalWorkflowVersions()).toContain('f488709ab38b7d42f58accd90cbe59a162eae89ee23169db9b28ecdf264a7581');
 // The real production set must review those exact bytes.
 expect(normalWorkflowVersions()).toContain(DISK_WORKFLOW_SHA);
 // The real production resolver must map them to a contract on the CONSUMER axis.
 const resolved=resolveCandidateWorkflowContract(DISK_WORKFLOW_SHA);
 expect(resolved).toBeDefined();
 expect(resolved!.workflowSha256).toBe(DISK_WORKFLOW_SHA);
 // ...while the frozen SDK-execution producer axis has no contract for the new bytes.
 const frozen=new Set<string>();
 for(const source of QLEVER_SDK_EXECUTION_GROUPS as readonly GitHubSourceBindingGroup[]){
  const relationship=source.candidateServiceRelationship;
  if(typeof relationship?.workflowSha256==='string') frozen.add(relationship.workflowSha256);
 }
 expect(frozen.has(DISK_WORKFLOW_SHA)).toBe(false);
 // The consumer axis (the published contract route) carries it.
 const consumerResolved=resolveCandidateWorkflowContract(DISK_WORKFLOW_SHA);
 expect(consumerResolved!.workflowSha256).toBe(DISK_WORKFLOW_SHA);
});

test('the resolver reads the axis it is given and resolves identical duplicates once',()=>{
 const hash='b'.repeat(64);
 const shared=contract(hash);
 const withContract=(value:CandidateServiceRelationshipContractObject):GitHubSourceBindingGroup=>group('3'.repeat(64),{candidateServiceRelationship:value});
 expect(resolveCandidateWorkflowContractFrom([withContract(shared)],hash)).toEqual(shared);
 // Identical repeats collapse to one accepted contract, on either ordering.
 expect(resolveCandidateWorkflowContractFrom([withContract(shared),withContract(contract(hash))],hash)).toEqual(shared);
 // The frozen axis simply lacks the hash, so the axis choice is observable.
 expect(resolveCandidateWorkflowContractFrom([group('3'.repeat(64))],hash)).toBeUndefined();
 // Production resolves through the consumer axis for every hash it carries.
 const consumerHashes=new Set<string>();
 for(const source of QLEVER_SDK_CONSUMER_GROUPS as readonly GitHubSourceBindingGroup[]){
  const sha=source.candidateServiceRelationship?.workflowSha256;
  if(typeof sha==='string') consumerHashes.add(sha);
 }
 for(const sha of consumerHashes){
  expect(resolveCandidateWorkflowContract(sha))
   .toEqual(resolveCandidateWorkflowContractFrom(QLEVER_SDK_CONSUMER_GROUPS as readonly GitHubSourceBindingGroup[],sha));
 }
});

test('a same-hash contract with a different job or model meaning is refused',()=>{
 const hash='c'.repeat(64);
 const withContract=(value:CandidateServiceRelationshipContractObject):GitHubSourceBindingGroup=>group('4'.repeat(64),{candidateServiceRelationship:value});
 const genuine=contract(hash);
 // Different SDK job for the SAME workflow bytes: ambiguity, not precedence.
 expect(()=>resolveCandidateWorkflowContractFrom(
  [withContract(genuine),withContract(contract(hash,{sdkJob:'publish_qlever_runtime_sdk / other'}))],hash))
  .toThrow(/conflicting candidate service relationship contracts/u);
 // Different sdk build execution model, same bytes: also refused, both orderings.
 const alternate={...genuine,sdkBuildExecutionModel:'normal-build-v1'} as CandidateServiceRelationshipContractObject;
 expect(()=>resolveCandidateWorkflowContractFrom([withContract(genuine),withContract(alternate)],hash))
  .toThrow(/conflicting candidate service relationship contracts/u);
 expect(()=>resolveCandidateWorkflowContractFrom([withContract(alternate),withContract(genuine)],hash))
  .toThrow(/conflicting candidate service relationship contracts/u);
 // Unknown hash over a populated axis stays undefined; malformed input fails.
 expect(resolveCandidateWorkflowContractFrom([withContract(genuine)],'d'.repeat(64))).toBeUndefined();
 expect(()=>resolveCandidateWorkflowContract('not-a-hash')).toThrow();
});
