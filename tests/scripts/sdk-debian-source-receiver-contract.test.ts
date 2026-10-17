import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {expect,it,vi} from 'vitest';

// Isolate serialization from central issuance, input ownership and build execution.
// This view is a fixture, never an issued capability or release qualification.
const fixture = vi.hoisted(() => ({view: undefined as any}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-originals', () => ({qleverSdkOriginalsView: () => fixture.view}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-inputs', () => ({inspectSdkInputOwnership: () => ({
  requiredSources: [{name:'foo',version:'1.0'}],unresolvedInputs:[],unresolvedSymlinkOriginalTargets:[],
})}));
// This test observes no process execution. That independent axis stays explicitly false.
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-execution', () => ({inspectSdkBuildExecution: vi.fn(() => ({
  verified:false,pending:['schema-fixture-build-execution-not-observed'],
}))}));
import {inspectSdkBuildExecution} from '../../scripts/lib/independent-admission/qlever-sdk-execution';
import {inspectQleverSdkSourceOriginals} from '../../scripts/lib/independent-admission/qlever-sdk-source';
const root=path.resolve(__dirname,'../..');
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

it('actual acquisition output satisfies receiver source schema; unrooted refs and old package groups fail',()=>{
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
    function observe(collection:any) {
      const collectionName=fixtureInfo.receiverCollection.path;
      originals.set(collectionName,Buffer.from(JSON.stringify(collection)));
      originals.set('materials.json',Buffer.from(JSON.stringify({...initialMaster,debianSources:reference(collectionName)})));
      fixture.view={masterReference:reference('materials.json'),originFacts:{sourceSha:'a'.repeat(40),target:'linux-x64',producerJobId:17,originals:[jobsOriginal]},
        metadataOriginals:[{name:'jobs.original.json',data:jobsData}],
        members:[...originals.keys()].map(reference),readOriginal:(name:string)=>originals.get(name),
        readOriginalRange:(name:string,offset:number,length:number)=>originals.get(name)!.subarray(offset,offset+length)};
      return inspectQleverSdkSourceOriginals({fixture:true});
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
