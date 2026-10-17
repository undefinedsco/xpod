import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {expect,it,vi} from 'vitest';

// Isolate serialization from central issuance, input ownership and build execution.
// This view is a fixture, never an issued capability or release qualification.
const fixture = vi.hoisted(() => ({view: undefined as any, source: {sourceSha:'a'.repeat(40)}, proof: undefined as any, calls: [] as number[], binary: undefined as undefined | {files: readonly unknown[]; unresolved: readonly unknown[]; scope: string; assertCurrent():void}, binaryCalls: [] as unknown[][]}));
vi.mock('../../scripts/lib/independent-admission/source-context',()=>({derivedSourceView:()=>fixture.source,assertDerivedSourceCurrent:()=>{}}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-index',()=>({observeQleverSdkDebianIndexOriginals:async(_cap:unknown,remaining:number)=>{fixture.calls.push(remaining);return {facts:{sdkDebianInReleaseSourcesDscChecksumChainVerified:true},pending:['qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified']};}}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-upstream-source',()=>({observeQleverSdkUpstreamGitOriginals:async(_cap:unknown,_source:unknown,remaining:number)=>{fixture.calls.push(remaining);return {facts:{},pending:['actual-generated-input-closure-unresolved']};}}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-signature',()=>({observeQleverSdkDebianSignatureOriginals:async(_cap:unknown,remaining:number)=>{fixture.calls.push(remaining);return {facts:fixture.proof ?? {sdkDebianOfficialSignatureAndSuiteVerified:true},pending:[]};},qleverSdkDebianSignatureObservation:()=>fixture.proof}));
// Protocol-only orchestration: no fixture registers a real SDK/binary capability.
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-binary',()=>({
  observeQleverSdkDebianBinaryOriginals:async(...args:unknown[])=>{fixture.binaryCalls.push(args);fixture.calls.push(args[2] as number);return {facts:{sdkSelectedDebianBinaryFilesVerified:true,sdkDebianBinaryFiles:fixture.binary?.files,sdkDebianBinaryScope:fixture.binary?.scope},pending:['binary-other-obligation']};},
  qleverSdkDebianBinaryObservation:()=>fixture.binary,
}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-originals', () => ({qleverSdkOriginalsView: () => fixture.view}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-inputs', () => ({inspectSdkInputOwnership: () => ({
  requiredSources: [{name:'foo',version:'1.0'}],unresolvedInputs:[],unresolvedSymlinkOriginalTargets:[],
})}));
// This test observes no process execution. That independent axis stays explicitly false.
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-execution', async () => ({...await vi.importActual<Record<string,unknown>>('../../scripts/lib/independent-admission/qlever-sdk-execution'),inspectSdkBuildExecution: vi.fn(() => ({
  verified:false,pending:['schema-fixture-build-execution-not-observed'],
}))}));
import {inspectSdkBuildExecution,SdkTrackedPhaseOriginalsUnobserved,SDK_TRACKED_PHASE_UNOBSERVED} from '../../scripts/lib/independent-admission/qlever-sdk-execution';
import {inspectQleverSdkSourceOriginals,observeQleverSdkSourceAdmission,sdkVerifiedInputOriginalView} from '../../scripts/lib/independent-admission/qlever-sdk-source';
const root=path.resolve(__dirname,'../..');
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

it('actual acquisition output satisfies receiver source schema; unrooted refs and old package groups fail',async()=>{
  mkdirSync(path.join(root,'.test-data'),{recursive:true});
  const temporary=mkdtempSync(path.join(root,'.test-data/sdk-receiver-contract-'));
  try {
    const fixtureInfo=JSON.parse(execFileSync('/usr/bin/python3',['-B','qlever/tests/sdk_debian_receiver_fixture.py',temporary],{cwd:root,encoding:'utf8'}));
    const originals=new Map<string,Buffer>();
    function visit(directory:string,prefix='') {
      for (const entry of readdirSync(directory,{withFileTypes:true})) {
        const name=prefix+entry.name;
        if(entry.isDirectory())visit(path.join(directory,entry.name),name+'/');
        else originals.set(name,readFileSync(path.join(directory,entry.name)));
      }
    }
    visit(fixtureInfo.root);
    const initialCollection=JSON.parse(originals.get(fixtureInfo.receiverCollection.path)!.toString());
    const initialMaster=JSON.parse(originals.get('materials.json')!.toString());
    // Matching bytes model only the job metadata envelope, never an official CI observation.
    const jobsData=Buffer.from(JSON.stringify({jobs:[{id:17,started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:01:00Z'}]}));
    const jobsOriginal={name:'jobs.original.json',bytes:jobsData.length,sha256:sha(jobsData)};
    function reference(name:string) {const bytes=originals.get(name)!;return {path:name,bytes:bytes.length,sha256:sha(bytes)};}
    // Ownership/input bytes are mocked above: retain an explicit empty row set
    // for serialization only, never an actual full-shard SDK input observation.
    const afterName=initialMaster.inputs.after.path;
    const after=JSON.parse(originals.get(afterName)!.toString());
    after.files ??= [];
    originals.set(afterName,Buffer.from(JSON.stringify(after)));
    initialMaster.inputs.after=reference(afterName);
    const originalCap={fixture:true};
    function observe(collection:any) {
      const collectionName=fixtureInfo.receiverCollection.path;
      originals.set(collectionName,Buffer.from(JSON.stringify(collection)));
      originals.set('materials.json',Buffer.from(JSON.stringify({...initialMaster,debianSources:reference(collectionName)})));
      fixture.view={masterReference:reference('materials.json'),originFacts:{sourceSha:'a'.repeat(40),target:'linux-x64',producerJobId:17,originals:[jobsOriginal]},
        metadataOriginals:[{name:'jobs.original.json',data:jobsData}],
        members:[...originals.keys()].map(reference),readOriginal:(name:string)=>originals.get(name),
        readOriginalRange:(name:string,offset:number,length:number)=>originals.get(name)!.subarray(offset,offset+length)};
      return inspectQleverSdkSourceOriginals(originalCap);
    }
    function checkReferences(value:any) {
      if(Array.isArray(value)) {value.forEach(checkReferences);return;}
      if(!value || typeof value !== 'object')return;
      if('path' in value && 'bytes' in value && 'sha256' in value) {
        expect(value.path.startsWith('inner/')).toBe(true);
        expect(reference(value.path)).toEqual(value);return;
      }
      Object.values(value).forEach(checkReferences);
    }
    checkReferences(initialCollection);
    const positive=observe(initialCollection);
    expect(positive.facts.debianDscAndAllSourceArchiveBytesVerified,JSON.stringify(positive.pending)).toBe(true);
    expect(positive.facts.sdkOwnedDebianInputSourceArchivesComplete).toBe(true);
    expect(positive.verified).toBe(false);
    expect(positive.facts.sdkConfigureCompileClosedExecutionVerified).toBe(false);
    expect((positive.facts.sdkConfigureCompileExecution as any).pending).toContain('schema-fixture-build-execution-not-observed');
    expect(inspectSdkBuildExecution).toHaveBeenCalledWith(expect.objectContaining({
      jobWindow:{start:Date.parse('2026-01-01T00:00:00Z'),end:Date.parse('2026-01-01T00:01:00Z')},
    }));
    expect(positive.pending).toContain('qlever-sdk-Debian-signed-Sources-InRelease-keyring-authority-not-yet-verified');
    expect(sdkVerifiedInputOriginalView(originalCap)).toBeDefined();
    vi.mocked(inspectSdkBuildExecution).mockImplementationOnce(()=>{throw Error('malformed old receipt');});
    expect(observe(initialCollection).pending).toContain('malformed old receipt');expect(sdkVerifiedInputOriginalView(originalCap)).toBeUndefined();
    vi.mocked(inspectSdkBuildExecution).mockImplementationOnce(()=>{throw new SdkTrackedPhaseOriginalsUnobserved(undefined);});
    const typed=observe(initialCollection);expect(typed.pending).toContain(SDK_TRACKED_PHASE_UNOBSERVED);expect(typed.verified).toBe(false);expect(sdkVerifiedInputOriginalView(originalCap)).toBeDefined();
    const reader=fixture.view.readOriginal;fixture.view.readOriginal=(name:string)=>{fixture.view=undefined;return reader(name);};
    inspectQleverSdkSourceOriginals(originalCap);expect(sdkVerifiedInputOriginalView(originalCap)).toBeUndefined();
    observe(initialCollection);
    // This isolates orchestration only; mocked views never issue an SDK or signature capability.
    const cap={fixture:true};
    fixture.proof=Object.freeze({sdkDebianOfficialSignatureAndSuiteVerified:true});
    fixture.calls=[]; fixture.binaryCalls=[];
    fixture.binary={files:Object.freeze([]),unresolved:Object.freeze([]),scope:'fixture-selected-files',assertCurrent:()=>{}};
    const sourceCap={fixture:true};
    const signed=await observeQleverSdkSourceAdmission({sdkOriginals:cap,source:sourceCap,remainingMilliseconds:10000});
    expect(signed.facts.sdkDebianOfficialSignatureAndSuiteVerified).toBe(true);
    expect(signed.pending).not.toContain('qlever-sdk-Debian-signed-Sources-InRelease-keyring-authority-not-yet-verified');
    expect(signed.pending).not.toContain('qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified');
    expect(signed.pending).toContain('actual-generated-input-closure-unresolved');
    expect(signed.verified).toBe(false);
    expect((signed.facts.sdkSourceRequiredAxes as any).generatedInputIoClosure).toBe(false);
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.binaryCalls[0]!.slice(0,2)).toEqual([cap,sourceCap]);
    expect(signed.facts.sdkSelectedDebianBinaryFilesVerified).toBe(true);
    expect(signed.pending).toContain('binary-other-obligation');
    expect((signed.facts.sdkSourceRequiredAxes as any).toolchainSourceClosure).toBe('verifier-not-implemented');
    signed.assertCurrent();const savedBinary=fixture.binary;fixture.binary=undefined;
    expect(()=>signed.assertCurrent()).toThrow('binary observation custody changed');fixture.binary=savedBinary;
    expect(fixture.calls.every((value,index,values)=>value>0 && value<=10000 && (!index || value<=values[index-1]!))).toBe(true);
    signed.assertCurrent(); fixture.proof=undefined;
    expect(()=>signed.assertCurrent()).toThrow('signature observation custody changed');
    fixture.proof=Object.freeze({sdkDebianOfficialSignatureAndSuiteVerified:true});fixture.binary=undefined;
    const forgedBinary=await observeQleverSdkSourceAdmission({sdkOriginals:cap,source:sourceCap});
    expect(forgedBinary.facts.sdkSelectedDebianBinaryFilesVerified).toBe(false);
    expect(forgedBinary.pending).toContain('qlever-sdk-independent-Debian-binary-private-observation-unavailable');
    fixture.proof=undefined;
    fixture.binaryCalls=[];
    const unbound=await observeQleverSdkSourceAdmission({sdkOriginals:cap,source:{fixture:true}});
    expect(unbound.facts.sdkDebianOfficialSignatureAndSuiteVerified).toBe(false);
    expect(fixture.binaryCalls).toEqual([]);
    expect(unbound.facts.sdkSelectedDebianBinaryFilesVerified).toBe(false);
    expect(unbound.pending).toContain('qlever-sdk-Debian-signed-Sources-InRelease-keyring-authority-not-yet-verified');
    expect(unbound.pending).toContain('qlever-sdk-independent-Debian-signature-private-observation-unavailable');
    expect(inspectQleverSdkSourceOriginals(cap,0).pending.join()).toContain('mechanical source observation deadline expired');
    fixture.calls=[];
    const expired=await observeQleverSdkSourceAdmission({sdkOriginals:cap,source:{fixture:true},remainingMilliseconds:0});
    expect(expired.pending.join()).toContain('deadline expired');expect(fixture.calls).toEqual([]);
    expect(originals.has(fixtureInfo.innerCollection.path)).toBe(true);
    const internal=JSON.parse(originals.get(fixtureInfo.innerCollection.path)!.toString());
    expect(observe(internal).facts.debianDscAndAllSourceArchiveBytesVerified).not.toBe(true);
    const oldGroup=structuredClone(initialCollection);
    for(const row of [oldGroup.packages[0].dsc,...oldGroup.packages[0].files]) {
      const oldName=row.path.replace('debian-source/package-0000','debian-sources/package-0');
      originals.set(oldName,originals.get(row.path)!);row.path=oldName;
    }
    expect(observe(oldGroup).pending).toContain('QLever SDK source: Debian original group/reference set differs');
  } finally {fixture.view=undefined;rmSync(temporary,{recursive:true,force:true});}
});
