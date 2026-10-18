import {test,expect} from 'bun:test';
import {inspectSdkToolchainOperationFileCoverage,observeQleverSdkToolchainSourceOriginals} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';
function fixture(){
 const identityDecimal=['1','7',String(0o100755),'100','1700000000000000001','1700000000000000002'];
 const original={path:'capture-1.original',bytes:100,sha256:'a'.repeat(64)};
 const file={observedPath:'/usr/bin/fixture',identityDecimal,original,originalCaptureSequence:2};
 const mapping={startHex:'1000',endHex:'2000',path:file.observedPath,inode:7,deviceMajor:0,deviceMinor:1,fileOffset:0,permissions:'r-xp'};
 const coverage={schemaVersion:1,operations:[{kind:'exec',phase:'configure',pid:5,entrySequence:1,execEventSequence:3,captureSequence:4,primaryFile:file,elf:{machine:183},mapOriginals:[{...file,mapping,captureSequence:5}],expectedFileMappingCount:1,unresolved:[]}],pending:[] as string[]};
 const observedFiles=[{path:file.observedPath,phase:'configure',captureSequence:2,identityDecimal,bytes:100,sha256:original.sha256,mode:0o755}];
 const afterRows=[{originalPath:file.observedPath,bytes:100,sha256:original.sha256,mode:0o755}];
 const binaryFiles=[{installedPath:file.observedPath,bytes:100,sha256:original.sha256,mode:0o755,binary:{name:'fixture',version:'1',architecture:'arm64'},source:{name:'fixture-source',version:'1'},deb:original,packages:{...original,signedIndexPath:'Packages',inReleaseSha256:'b'.repeat(64)},dataMemberPath:'usr/bin/fixture'}];
 return {coverage,observedFiles,afterRows,binaryFiles};
}
test('complete operation/file/raw-after/signed binary joins prove only that finite byte axis',()=>{
 const result=inspectSdkToolchainOperationFileCoverage(fixture());expect(result.facts.sdkToolchainOperationCoverageVerified).toBe(true);expect(result.facts.sdkToolchainSignedDebianBinaryFileBindingsVerified).toBe(true);expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);expect(result.pending).toContain('qlever-sdk-toolchain-effective-readonly-provider-coverage-unavailable');expect(result.pending).toContain('qlever-sdk-toolchain-exact-source-archive-coverage-private-join-unavailable');
});
test('missing/duplicate operations, VMA or changed after/raw file never become complete proof',()=>{
 const empty=fixture();empty.coverage.operations=[];expect(()=>inspectSdkToolchainOperationFileCoverage(empty)).toThrow('nonempty');
 const duplicate=fixture();duplicate.coverage.operations.push(duplicate.coverage.operations[0]!);expect(()=>inspectSdkToolchainOperationFileCoverage(duplicate)).toThrow('duplicate operation');
 const omitted=fixture();omitted.coverage.operations[0]!.mapOriginals=[];expect(inspectSdkToolchainOperationFileCoverage(omitted).facts.sdkToolchainOperationCoverageVerified).toBe(false);
 const unclosed=fixture();unclosed.coverage.pending=['toolchain-actual-exec-image-original-unavailable'];expect(inspectSdkToolchainOperationFileCoverage(unclosed).facts.sdkToolchainOperationCoverageVerified).toBe(false);
 const missing=fixture();missing.observedFiles=[];expect(inspectSdkToolchainOperationFileCoverage(missing).facts.sdkToolchainObservedAfterFileBindingsVerified).toBe(false);
 const swapped=fixture();swapped.observedFiles[0]!.identityDecimal=[...swapped.observedFiles[0]!.identityDecimal];swapped.observedFiles[0]!.identityDecimal[5]='1700000000000000003';expect(inspectSdkToolchainOperationFileCoverage(swapped).facts.sdkToolchainObservedAfterFileBindingsVerified).toBe(false);
 const changed=fixture();changed.afterRows[0]!.sha256='c'.repeat(64);expect(inspectSdkToolchainOperationFileCoverage(changed).facts.sdkToolchainSignedDebianBinaryFileBindingsVerified).toBe(false);
 const noBinary=fixture();noBinary.binaryFiles=[];expect(inspectSdkToolchainOperationFileCoverage(noBinary).facts.sdkToolchainSignedDebianBinaryFileBindingsVerified).toBe(false);
});
test('serialized protocol facts never replace any of the real private handles',async()=>{
 const result=await observeQleverSdkToolchainSourceOriginals(fixture(),{sourceSha:'a'.repeat(40)},20);expect(result.facts.sdkToolchainOperationCoverageVerified).toBe(false);expect(result.pending.join(' ')).toContain('same private');
});

test('verified stopped-provider projection adds only stop scope, never lifetime immutability',()=>{
 const input=fixture();const identity=input.coverage.operations[0]!.primaryFile.identityDecimal;
 const provider={scope:'actual stopped tracee namespace named-FD effective read-only provider only',identityDecimal:identity,mountNamespace:'mnt:[11]',mountNamespaceIdentityDecimal:['1','11','33060','0','0','0'],rootIdentityDecimal:['1','12','16877','0','0','0'],provider:{mountId:149},mountinfoOriginal:{path:'capture-0002.original',bytes:40,sha256:'d'.repeat(64)}};
 for(const file of [input.coverage.operations[0]!.primaryFile,...input.coverage.operations[0]!.mapOriginals])Object.assign(file,{stopReadonlyProvider:provider});
 const result=inspectSdkToolchainOperationFileCoverage(input);expect(result.facts.sdkToolchainStopReadOnlyProviderCoverageVerified).toBe(true);expect(result.facts.sdkToolchainStopReadOnlyCaptureCount).toBe(2);expect(result.pending).toContain('qlever-sdk-toolchain-execution-lifetime-immutability-unverified');expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
 const changed=fixture();Object.assign(changed.coverage.operations[0]!.primaryFile,{stopReadonlyProvider:{...provider,identityDecimal:['1','9',...identity.slice(2)]}});expect(()=>inspectSdkToolchainOperationFileCoverage(changed)).toThrow('stopped provider/file relation');
});
