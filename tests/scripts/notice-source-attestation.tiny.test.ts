import {test,expect} from 'bun:test';
import {noticeAttestationBundle,noticeAttestationPolicy,verifyNoticeSourceAttestation,noticeVerifiedStatementMatches,reviewedNoticeVerifierPlan} from '../../scripts/lib/notice-source-attestation';
const policy={repository:'zed-industries/codex-acp',commit:'e979e7c43f068d8e5f166fa38d201dc52ee092c5',workflow:'.github/workflows/release.yml',ref:'refs/heads/main',packageName:'@zed-industries/codex-acp',packageVersion:'0.9.5'};
test('official verification argv fixes certificate issuer, identity, source and subject algorithm',()=>{
 const argv=noticeAttestationPolicy(policy);expect(argv).toContain('https://token.actions.githubusercontent.com');expect(argv).toContain('https://github.com/zed-industries/codex-acp/.github/workflows/release.yml@refs/heads/main');expect(argv).toContain('--deny-self-hosted-runners');expect(argv).toContain('sha512');
 for(const wrong of [{repository:'../repo'},{commit:'main'},{workflow:'../../release.yml'},{ref:'refs/heads/../../main'}])expect(()=>noticeAttestationPolicy({...policy,...wrong})).toThrow();
});
test('only one exact SLSA bundle, no caller verification result authority',()=>{
 const row={predicateType:'https://slsa.dev/provenance/v1',bundle:{mediaType:'application/vnd.dev.sigstore.bundle.v0.3+json'}};
 expect(JSON.parse(noticeAttestationBundle(Buffer.from(JSON.stringify({attestations:[row]}))).toString()).mediaType).toBe(row.bundle.mediaType);
 for(const value of [{verificationResult:true},{attestations:[row,row]},{attestations:[]},{attestations:[{...row,bundle:{mediaType:'unknown'}}]}])expect(()=>noticeAttestationBundle(Buffer.from(JSON.stringify(value)))).toThrow();
 expect(()=>noticeAttestationBundle(Buffer.alloc(512*1024+1))).toThrow();
});
test('unreviewed roots and expired shared budget fail before ecosystem execution',()=>{
 const artifact=Buffer.from('artifact'),input={policy,artifact,integrity:'sha512-'+require('node:crypto').createHash('sha512').update(artifact).digest('base64'),response:Buffer.from('{}'),trustedRoot:Buffer.from('{}'),verifierPath:'/not-a-verifier',workRoot:import.meta.dir,remainingMilliseconds:()=>1000};
 expect(()=>verifyNoticeSourceAttestation(input)).toThrow('Reviewed TUF');
 expect(()=>verifyNoticeSourceAttestation({...input,remainingMilliseconds:()=>0})).toThrow('deadline');
 expect(()=>verifyNoticeSourceAttestation({...input,integrity:'sha512-invalid'})).toThrow('lock SRI');
});

test('authenticated statement must bind the exact source dependency, workflow and package subject',()=>{
 const artifact=Buffer.from('actual'),statement={_type:'https://in-toto.io/Statement/v1',predicateType:'https://slsa.dev/provenance/v1',subject:[{name:'pkg:npm/%40zed-industries/codex-acp@0.9.5',digest:{sha512:require('node:crypto').createHash('sha512').update(artifact).digest('hex')}}],predicate:{buildDefinition:{buildType:'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',externalParameters:{workflow:{repository:'https://github.com/'+policy.repository,path:policy.workflow,ref:policy.ref}},resolvedDependencies:[{uri:'git+https://github.com/'+policy.repository+'@'+policy.ref,digest:{gitCommit:policy.commit}}]}}};
 expect(noticeVerifiedStatementMatches(statement,policy,artifact)).toBe(true);
 for(const mutate of [(v:any)=>v.subject[0].name='pkg:npm/other@0.9.5',(v:any)=>v.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit='0'.repeat(40),(v:any)=>v.predicate.buildDefinition.resolvedDependencies.push(v.predicate.buildDefinition.resolvedDependencies[0]),(v:any)=>v.predicate.buildDefinition.externalParameters.workflow.path='.github/workflows/other.yml']){const value=JSON.parse(JSON.stringify(statement));mutate(value);expect(noticeVerifiedStatementMatches(value,policy,artifact)).toBe(false);}
});

 test('normal acquisition selects one fixed whole executable archive and root tuple per actual host',()=>{
  const amd=reviewedNoticeVerifierPlan('linux','x64'),arm=reviewedNoticeVerifierPlan('linux','arm64');
  expect(amd.archive.member).toBe('gh_2.102.0_linux_amd64/bin/gh');
  expect(arm.archive.member).toBe('gh_2.102.0_linux_arm64/bin/gh');
  expect(amd.archive.sha256).toBe('bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386');
  expect(arm.executable.sha256).toBe('93308395c2d296a63a662742c6366e4db413d2a4870d07bd9b84e491c065d65d');
  expect(arm.trustedRoot).toEqual(amd.trustedRoot);expect(arm.checksums).toEqual(amd.checksums);
  expect(Object.isFrozen(amd.archive)).toBe(true);
  for(const [platform,architecture]of [['darwin','arm64'],['linux','ia32'],['unknown','x64']])expect(()=>reviewedNoticeVerifierPlan(platform,architecture)).toThrow('Matching Linux');
 });
