import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import fixture from './fixtures/rc382-desktop-manifest-transition.json';
import {inspectCandidateVersionedManifestMutation} from '../../scripts/lib/independent-admission/candidate-service-root-mutation';

/** RC382 real evidence: `--apply-root-version` writes BOTH the root
 * package.json and desktop/package.json with the SAME run-derived candidate
 * version. The committed 928890f6 desktop blob is 2557B; the recorded build
 * input is the 2564B version-stamped form. This fixture carries both verbatim. */
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
const before=Buffer.from((fixture as any).before,'base64');
const after=Buffer.from((fixture as any).after,'base64');
const run=(fixture as any).run;
const base=(over:any={})=>({before,after,immutable:before,name:(fixture as any).name,
  run,sourceSha:(fixture as any).sourceSha,runId:run.id,runAttempt:run.run_attempt,...over});

test('the real recorded desktop manifest transition is verified',()=>{
  // The fixture is the real data, not a synthetic stand-in.
  expect(sha(before)).toBe((fixture as any).beforeSha256);
  expect(sha(after)).toBe((fixture as any).afterSha256);
  expect(before.length).toBe(2557);
  expect(after.length).toBe(2564);
  const facts=inspectCandidateVersionedManifestMutation(base());
  expect(facts.versionedManifestMutationVerified).toBe(true);
  expect(facts.candidateVersion).toBe('0.4.31-rc.382');
  expect(facts.beforeSha256).toBe((fixture as any).beforeSha256);
  expect(facts.afterSha256).toBe((fixture as any).afterSha256);
});

test('tampered desktop after-bytes or unrelated fields are refused',()=>{
  // Any unrelated field change in the recorded after manifest must be rejected.
  const altered=JSON.parse(after.toString());
  altered.dependencies={...(altered.dependencies??{}),'evil-injected':'1.0.0'};
  expect(()=>inspectCandidateVersionedManifestMutation(base({after:Buffer.from(JSON.stringify(altered))}))).toThrow();
  // A different version than the run derives is rejected.
  const wrong=JSON.parse(after.toString());wrong.version='0.4.31-rc.999';
  expect(()=>inspectCandidateVersionedManifestMutation(base({after:Buffer.from(JSON.stringify(wrong))}))).toThrow();
  // A foreign namespace is rejected.
  const foreign=JSON.parse(after.toString());foreign.name='@undefineds.co/other';
  expect(()=>inspectCandidateVersionedManifestMutation(base({after:Buffer.from(JSON.stringify(foreign))}))).toThrow();
  // A caller-supplied expected version that disagrees with the run is rejected.
  expect(()=>inspectCandidateVersionedManifestMutation(base({expectedVersion:'0.4.31-rc.1'}))).toThrow();
});

test('bad immutable source, wrong run identity and unbounded input are refused',()=>{
  // before must equal immutable Git bytes.
  const otherBefore=Buffer.from(JSON.stringify({...JSON.parse(before.toString()),version:'0.0.0'}));
  expect(()=>inspectCandidateVersionedManifestMutation(base({immutable:otherBefore}))).toThrow();
  // Wrong run id / attempt / head / branch / event each fail closed.
  for(const over of [{runId:run.id+1},{runAttempt:run.run_attempt+1},
    {run:{...run,head_sha:'c'.repeat(40)}},{run:{...run,head_branch:'main'}},
    {run:{...run,event:'pull_request'}},{run:{...run,run_number:0}}])
    expect(()=>inspectCandidateVersionedManifestMutation(base(over))).toThrow();
  // Oversized manifest is refused.
  expect(()=>inspectCandidateVersionedManifestMutation(base({after:Buffer.alloc(129*1024,0x20)}))).toThrow();
  // Non-JSON is refused.
  expect(()=>inspectCandidateVersionedManifestMutation(base({after:Buffer.from('not json')}))).toThrow();
});
