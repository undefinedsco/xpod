import {test,expect} from 'bun:test';
import {candidateServiceObservationArguments as parse} from '../../scripts/check-candidate-service-sdk-source';
import {acquireCandidateServiceOriginals} from '../../scripts/acquire-independent-product-input';
import {deriveCandidateServiceSource} from '../../scripts/lib/independent-admission/source-context';
const args=['--source-sha','a'.repeat(40),'--run-id','1','--run-attempt','2','--service-artifact-id','3','--service-artifact-digest','b'.repeat(64),'--service-master-bytes','100','--service-master-sha256','c'.repeat(64),'--checkout','/exact/source','--output','/exact/output'];
test('post-build observer accepts one complete exact coordinate set and rejects mixed declarations',()=>{
 const value=parse(args);expect(value.input.sourceSha).toBe(value.input.runHeadSha);expect(value.input.runAttempt).toBe(2);
 for(const bad of [args.slice(2),[...args,'--run-id','1'],[...args,'--allow-running','true'],args.map(v=>v==='100'?'4194305':v),args.map(v=>v==='2'?'2.0':v),args.map(v=>v==='a'.repeat(40)?'main':v)])expect(()=>parse(bad)).toThrow();
});
test('producer JSON cannot acquire live-run transport or immutable source capabilities',async()=>{
 const value=parse(args);await expect(acquireCandidateServiceOriginals(value.input,'/must-not-create',{...value.input,workflowPath:'.github/workflows/candidate.yml'})).rejects.toThrow('issued exact candidate original role');
 expect(()=>deriveCandidateServiceSource({origin:{workflowPath:'.github/workflows/candidate.yml'}},'/must-not-read')).toThrow('issued candidate service image originals');
});

test('mandatory qualification fails closed even though observation may complete; JSON is not authority',async()=>{const {requireCandidateServiceQualification}=await import('../../scripts/check-candidate-service-sdk-source');expect(()=>requireCandidateServiceQualification()).toThrow('qualification pending');});
