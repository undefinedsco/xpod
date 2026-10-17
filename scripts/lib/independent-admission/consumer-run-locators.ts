import type { ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
/** Immutable GitHub original locators only. Each is re-observed by a fixed
 * pre/post observer; this type carries no consumer permission or result. */
export interface PublicationConsumerRunLocator {
  readonly module:'client'|'cli'|'api'|'css'|'afs';
  readonly target?:string;
  readonly stage:'prepublish'|'postpublish';
  readonly consumerRun:ArtifactAcquisitionInput;
}
export function validatePublicationConsumerRuns(values:readonly PublicationConsumerRunLocator[],sourceSha:string):void {
  if(!Array.isArray(values)||values.length>28||!/^[a-f0-9]{40}$/u.test(sourceSha))throw Error('Bounded exact consumer run locators required');
  const seen=new Set<string>();
  for(const row of values){
    if(!row||typeof row!=='object'||Object.keys(row).some(key=>!['module','target','stage','consumerRun'].includes(key))
      ||!['client','cli','api','css','afs'].includes(row.module)||!['prepublish','postpublish'].includes(row.stage)
      ||(['client','cli'].includes(row.module)?row.target!==undefined:!/^(linux|darwin)-(x64|arm64)$/u.test(row.target??'')))throw Error('Exact product/stage consumer locator required');
    const run=row.consumerRun;
    if(!run||typeof run!=='object'||Object.keys(run).some(key=>!['schemaVersion','sourceSha','runHeadSha','runId','runAttempt','artifactId','artifactSha256'].includes(key))
      ||run.schemaVersion!==1||run.sourceSha!==sourceSha||!/^[a-f0-9]{40}$/u.test(run.runHeadSha)||!/^[a-f0-9]{64}$/u.test(run.artifactSha256)
      ||![run.runId,run.runAttempt,run.artifactId].every(value=>Number.isSafeInteger(value)&&value>0))throw Error('Immutable same-source consumer tuple required');
    const key=row.module+':'+(row.target??'portable')+':'+row.stage;
    if(seen.has(key))throw Error('Duplicate product/stage consumer locator');seen.add(key);
  }
}
