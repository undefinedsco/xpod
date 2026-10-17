import {test,expect} from 'bun:test';
import {archiveConsumerArtifactName} from './archive-consumer-originals';
test('archive preconsumer uses distinct fixed artifact family with exact coordinates',()=>{
  const input={module:'css' as const,target:'darwin-arm64',sourceSha:'a'.repeat(40),runId:1,runAttempt:2};
  expect(archiveConsumerArtifactName(input)).toBe('xpod-archive-consumer-css-darwin-arm64-'+input.sourceSha+'-1-2');
  expect(()=>archiveConsumerArtifactName({...input,target:'portable'})).toThrow();
  expect(()=>archiveConsumerArtifactName({...input,module:'client'})).toThrow();
});
