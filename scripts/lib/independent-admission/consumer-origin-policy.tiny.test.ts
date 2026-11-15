import {test,expect} from 'bun:test';
import {observedGitHubRunStateAccepted,observedGitHubJobWindowAccepted} from './github-origin';
test('only fixed consumer scope permits active parent; failed and unknown runs never qualify',()=>{
 expect(observedGitHubRunStateAccepted('in_progress',null,'live-consumer')).toBe(true);
 expect(observedGitHubRunStateAccepted('in_progress',null,'closed-producer')).toBe(false);
 expect(observedGitHubRunStateAccepted('completed','failure','live-consumer')).toBe(false);
 expect(observedGitHubRunStateAccepted('queued',null,'live-consumer')).toBe(false);
 expect(observedGitHubRunStateAccepted('in_progress','success','live-consumer')).toBe(false);
});
test('consumer job must close in the exact original attempt/head and artifact window',()=>{
 const input={schemaVersion:1 as const,sourceSha:'a'.repeat(40),runHeadSha:'b'.repeat(40),runId:1,runAttempt:2,artifactId:3,artifactSha256:'c'.repeat(64)};
 const job={id:4,run_id:1,run_attempt:2,head_sha:input.runHeadSha,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z'};
 const artifact={created_at:'2026-10-17T00:01:00Z'};
 expect(observedGitHubJobWindowAccepted(job,artifact,input)).toBe(true);
 expect(observedGitHubJobWindowAccepted({...job,status:'in_progress',completed_at:null},artifact,input)).toBe(false);
 expect(observedGitHubJobWindowAccepted(job,{created_at:'2026-10-17T00:03:00Z'},input)).toBe(false);
 expect(observedGitHubJobWindowAccepted({...job,run_attempt:1},artifact,input)).toBe(false);
 expect(observedGitHubJobWindowAccepted({...job,head_sha:'d'.repeat(40)},artifact,input)).toBe(false);
 expect(observedGitHubJobWindowAccepted({...job,run_id:9},artifact,input)).toBe(false);
});
