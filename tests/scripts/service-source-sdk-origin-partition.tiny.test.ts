/**
 * F3 — real app-vs-SDK origin partition.
 *
 * The app service master names a typed SDK locator (artifact id/digest/master
 * image) and the SDK is a SEPARATE origin with its own source commit. These
 * tests drive the pure typed predicate with the real
 * `inspectQleverSdkArtifactReference` and real master/OCI bytes, so the
 * assertion is about the actual cross-seal, not a regex over source text.
 */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectQleverSdkArtifactReference} from '../../scripts/lib/independent-admission/qlever-sdk-originals';
import {inspectCandidateServiceSdkOriginPartition} from '../../scripts/lib/independent-admission/candidate-service-source-qualification';

const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
const budget={check(){},remainingMs:()=>600000,reserveBytes(){},chargeReadBytes(){},
  remainingReadBytes:()=>4e9,remainingOriginalBytes:()=>4e9,
  reserveOriginalMaximum(){return Object.freeze({});},settleOriginalReservation(){}} as any;
const APP='c61d8d76ce029ea39165b9a31e9e1fcee80f7443';   // app source
const SDK='c3247159767d8eb88817e117adce49dd5223d744';   // SDK source (DIFFERENT)
const sdkImage='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'1'.repeat(64);

/** A real SDK master + root manifest with genuine bytes, and the app locator. */
function scene(overrides:{appSource?:string;sdkSource?:string;image?:string;locatorImage?:string}={}){
  const sdkSource=overrides.sdkSource??SDK, appSource=overrides.appSource??APP, image=overrides.image??sdkImage;
  const manifestBody=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',marker:sdkSource}));
  const manifestDigest=sha(manifestBody);            // 'sha256:'+digest below
  const realImage='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+manifestDigest;
  const master:any={schemaVersion:1,kind:'qlever-linux-sdk-originals',
    identity:{sourceSha:sdkSource,runHeadSha:sdkSource,runId:10,runAttempt:2,target:'linux-x64',sdkProfile:'service-trixie'},
    image:{referenceByDigest:realImage,manifestDigest:'sha256:'+manifestDigest,platform:'linux/amd64',
      configDigest:'sha256:'+'3'.repeat(64),manifestOriginal:{path:'sdk/manifest.json',bytes:manifestBody.length,sha256:sha(manifestBody)}},
    originals:[],releaseAccepted:false,inputs:{shards:[{path:'s'}]},stages:[{}]};
  const masterBody=Buffer.from(JSON.stringify(master));
  const files=new Map<string,Buffer>([['materials.json',masterBody],['sdk/manifest.json',manifestBody]]);
  const reference=inspectQleverSdkArtifactReference({artifactId:7,artifactSha256:'4'.repeat(64),sourceSha:sdkSource,
    runId:10,runAttempt:2,target:'linux-x64',sdkProfile:'service-trixie',
    sdkImageReferenceByDigest:overrides.locatorImage??realImage,
    master:{path:'materials.json',bytes:masterBody.length,sha256:sha(masterBody)}},
    {sourceSha:sdkSource,runId:10,runAttempt:2,target:'linux-x64',sdkImage:realImage,sdkProfile:'service-trixie'});
  const readSdkOriginal=(name:string,maximum:number)=>{
    const raw=files.get(name);if(!raw||raw.length>maximum)throw Error('unexpected reader request: '+name);return Buffer.from(raw);
  };
  return {appSource,sdkSource,reference,master,realImage,sdkMasterReference:reference.master,readSdkOriginal};
}
const partition=(scene:any,artifact?:any)=>inspectCandidateServiceSdkOriginPartition({
  appSourceSha:scene.appSource,
  artifact:artifact??{artifactId:scene.reference.artifactId,artifactSha256:scene.reference.artifactSha256,
    sourceSha:scene.reference.sourceSha,runId:scene.reference.runId,runAttempt:scene.reference.runAttempt,
    target:scene.reference.target,sdkProfile:scene.reference.sdkProfile,
    sdkImageReferenceByDigest:scene.realImage,master:scene.reference.master},
  sdkMasterReference:scene.sdkMasterReference,sdkProfile:'service-trixie',
  sdkOriginFacts:{sourceSha:scene.sdkSource,runId:10,runAttempt:2,target:'linux-x64'},
  readSdkOriginal:scene.readSdkOriginal});

test('DIFFERENT app and SDK source commits bind through the immutable SDK tuple',()=>{
  expect(APP).not.toBe(SDK);
  const scene_=scene();
  const bound=partition(scene_);
  expect(bound.appSourceSha).toBe(APP);
  expect(bound.sdkSourceSha).toBe(SDK);
  expect(bound.sameSourceSha).toBe(false);      // the real partition, not equality
  expect(bound.sdkImageReferenceByDigest).toBe(scene_.realImage);
  expect(bound.master.path).toBe('materials.json');
});

test('same app/SDK commit is still bound by the same immutable tuple',()=>{
  const scene_=scene({sdkSource:APP});
  const bound=partition(scene_);
  expect(bound.sameSourceSha).toBe(true);
  expect(bound.artifactSha256).toBe('4'.repeat(64));
});

test('a mismatched SDK image digest is refused',()=>{
  const scene_=scene();
  // App locator names a different image than the SDK master actually carries.
  expect(()=>partition(scene_,{...scene_.reference,sourceSha:scene_.sdkSource,
    sdkImageReferenceByDigest:'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'9'.repeat(64)})).toThrow();
});

test('a mismatched SDK source origin is refused',()=>{
  const scene_=scene();
  // The SDK handle claims a source the app locator does not name.
  expect(()=>inspectCandidateServiceSdkOriginPartition({
    appSourceSha:scene_.appSource,
    artifact:{...scene_.reference,sourceSha:'0'.repeat(40)},
    sdkMasterReference:scene_.sdkMasterReference,sdkProfile:'service-trixie',
    sdkOriginFacts:{sourceSha:scene_.sdkSource,runId:10,runAttempt:2,target:'linux-x64'},
    readSdkOriginal:scene_.readSdkOriginal})).toThrow('SDK origin source coordinate differs');
});

test('an SDK master whose bytes differ from the app reference is refused',()=>{
  const scene_=scene();
  const tampered=(name:string,maximum:number)=>{
    const raw=scene_.readSdkOriginal(name,maximum);
    if(name==='materials.json')raw[raw.length-1]^=1;
    return raw;
  };
  expect(()=>inspectCandidateServiceSdkOriginPartition({
    appSourceSha:scene_.appSource,
    artifact:{...scene_.reference,sourceSha:scene_.sdkSource},
    sdkMasterReference:scene_.sdkMasterReference,sdkProfile:'service-trixie',
    sdkOriginFacts:{sourceSha:scene_.sdkSource,runId:10,runAttempt:2,target:'linux-x64'},
    readSdkOriginal:tampered})).toThrow('SDK master bytes differ');
});

test('an unrelated internally-consistent SDK cannot satisfy the app locator',()=>{
  // A second, perfectly valid SDK origin (different artifact/master/image) is
  // presented against an app master that pins the first one.
  const a=scene(),b=scene({sdkSource:'e'.repeat(40)});
  expect(a.realImage).not.toBe(b.realImage);
  expect(()=>inspectCandidateServiceSdkOriginPartition({
    appSourceSha:a.appSource,
    artifact:{...a.reference,sourceSha:b.sdkSource},   // app pins A's tuple
    sdkMasterReference:b.sdkMasterReference,sdkProfile:'service-trixie',
    sdkOriginFacts:{sourceSha:b.sdkSource,runId:10,runAttempt:2,target:'linux-x64'},
    readSdkOriginal:b.readSdkOriginal})).toThrow();
});
