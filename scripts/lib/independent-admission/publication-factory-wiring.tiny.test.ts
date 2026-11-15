import {test,expect} from 'bun:test';
import {preparePublicationGroup} from './publication-group';
import {collectPublicationLegalMaterials,publicationLegalMaterials} from './publication-legal-materials';
import {collectedPublicationSourceMaterials} from './index';
test('group consumer locators reject approval JSON before output or network work',async()=>{
 const selector={module:'client' as const,sourceSha:'a'.repeat(40),runHeadSha:'a'.repeat(40),runId:1,runAttempt:1,artifactId:2,artifactSha256:'b'.repeat(64)};
 await expect(preparePublicationGroup({selectors:[selector],checkout:'/must-not-read',output:'/must-not-create',consumerRuns:[{module:'client',stage:'prepublish',consumerRun:{...selector,schemaVersion:1,passed:true}} as never]})).rejects.toThrow('Immutable same-source');
});
test('legal originals and source graphs cannot be recovered from copied reports',async()=>{
 expect(publicationLegalMaterials({},{})).toBeUndefined();expect(collectedPublicationSourceMaterials({},{})).toBeUndefined();
 await expect(collectPublicationLegalMaterials({artifact:{},source:{}})).rejects.toThrow('Real same-source');
});
