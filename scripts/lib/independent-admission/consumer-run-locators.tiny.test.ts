import {test,expect} from 'bun:test';
import {validatePublicationConsumerRuns, type PublicationConsumerRunLocator} from './consumer-run-locators';
test('consumer locators accept only immutable source-bound stage tuples',()=>{
 const source='a'.repeat(40),row:PublicationConsumerRunLocator={module:'api',target:'darwin-arm64',stage:'prepublish',consumerRun:{schemaVersion:1,sourceSha:source,runHeadSha:'b'.repeat(40),runId:1,runAttempt:2,artifactId:3,artifactSha256:'c'.repeat(64)}};
 validatePublicationConsumerRuns([row],source);
 expect(()=>validatePublicationConsumerRuns([row,row],source)).toThrow('Duplicate');
 expect(()=>validatePublicationConsumerRuns([{...row,consumerRun:{...row.consumerRun,sourceSha:'d'.repeat(40)}}],source)).toThrow('same-source');
 expect(()=>validatePublicationConsumerRuns([{...row,passed:true} as never],source)).toThrow('Exact');
 expect(()=>validatePublicationConsumerRuns([{...row,consumerRun:{...row.consumerRun,path:'/tmp/result'}} as never],source)).toThrow('Immutable');
 expect(()=>validatePublicationConsumerRuns([{...row,module:'client'}],source)).toThrow('Exact');
});
