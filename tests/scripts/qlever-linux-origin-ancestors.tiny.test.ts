import {test,expect} from 'bun:test';
import {observedGitHubAncestorJobAccepted} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_LINUX_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/qlever-linux-origin-policy';
test('native archive ancestry requires successful closed same-run same-attempt prerequisites',()=>{
 const input={runId:10,runAttempt:2,runHeadSha:'a'.repeat(40)} as any;
 const job={id:2,run_id:10,run_attempt:2,head_sha:input.runHeadSha,status:'completed',conclusion:'success',started_at:'2026-10-17T01:00:00Z',completed_at:'2026-10-17T01:05:00Z'};
 const producer={started_at:'2026-10-17T01:06:00Z'};
 expect(observedGitHubAncestorJobAccepted(job,producer,input)).toBe(true);
 for(const mutation of [{run_attempt:1},{run_id:9},{head_sha:'b'.repeat(40)},{status:'in_progress'},{conclusion:'failure'},{completed_at:'2026-10-17T01:07:00Z'},{completed_at:null}])expect(observedGitHubAncestorJobAccepted({...job,...mutation},producer,input)).toBe(false);
});
test('old Linux producer TCB includes compiler recipes, runtime image recipe and archive observer',()=>{
 expect(QLEVER_LINUX_SOURCE_BINDINGS.length).toBe(25);
 for(const name of ['.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/publish-qlever-local-runtime.yml','qlever/scripts/produce-linux-runtime-archive.py','scripts/agentfs-native-ci/supervise.py','docker/qlever-runtime-sdk/Dockerfile.module-bookworm','docker/qlever-local-runtime/Dockerfile.module-bookworm'])expect(QLEVER_LINUX_SOURCE_BINDINGS.some(row=>row.path===name)).toBe(true);
});
