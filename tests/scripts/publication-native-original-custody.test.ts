import {expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({native:{},official:{},product:{},source:{},revoked:false,nativeChecks:0,officialChecks:0,identity:{sourceSha:'a'.repeat(40),package:'@undefineds.co/xpod-api-linux-x64',target:'linux-x64',version:'1.0.0',archiveSha256:'b'.repeat(64)},officialIdentity:undefined as any}));
// Dispatcher mechanics only: these private issuers have independent real-custody
// tests. The mocks here cannot produce a production native/admission capability.
vi.mock('../../scripts/lib/independent-admission/native-original-collector',()=>({nativeOriginalsView:(cap:unknown)=>cap===f.native?{}:undefined,assertCollectedNativeOriginalCustody:()=>{f.nativeChecks++;if(f.revoked)throw Error('revoked');}}));
vi.mock('../../scripts/lib/independent-admission/inngest-release-originals',()=>({officialInngestReleaseView:(cap:unknown)=>cap===f.official?{identity:f.officialIdentity??f.identity,assertCurrent(){f.officialChecks++;if(f.revoked)throw Error('revoked');}}:undefined}));
vi.mock('../../scripts/lib/independent-admission/artifact-collector',()=>({collectedArtifactView:(cap:unknown)=>cap===f.product?{identity:f.identity}:undefined}));
vi.mock('../../scripts/lib/independent-admission/source-context',()=>({derivedSourceView:(cap:unknown)=>cap===f.source?{sourceSha:f.identity.sourceSha}:undefined}));
import {assertPublicationNativeOriginalCustody,bindPublicationGateMaterials,publicationGateMaterials} from '../../scripts/lib/independent-admission/publication-gate-materials';
it('dispatches the existing native and official-release facts through their retained custody, never serialized views',()=>{
 expect(()=>assertPublicationNativeOriginalCustody({officialOriginVerified:true,identity:f.identity})).toThrow('Real retained');
 assertPublicationNativeOriginalCustody(f.native);assertPublicationNativeOriginalCustody(f.official);
 expect(f.nativeChecks).toBe(1);expect(f.officialChecks).toBe(1);
 f.revoked=true;try{expect(()=>assertPublicationNativeOriginalCustody(f.native)).toThrow('revoked');expect(()=>assertPublicationNativeOriginalCustody(f.official)).toThrow('revoked');}finally{f.revoked=false;}
});
it('binds the same official-release fact only to the exact publication product and preserves that handle',()=>{
 const input={relatedArtifacts:[],legalOriginals:[],legalSourceMaterials:undefined,nativeOriginals:f.official};
 f.officialIdentity={...f.identity,archiveSha256:'c'.repeat(64)};
 try{expect(()=>bindPublicationGateMaterials(f.product,f.source,input)).toThrow('exact publication product');}finally{f.officialIdentity=undefined;}
 bindPublicationGateMaterials(f.product,f.source,input);
 expect(publicationGateMaterials(f.product,f.source)?.nativeOriginals).toBe(f.official);
 expect(()=>bindPublicationGateMaterials(f.product,f.source,input)).toThrow('already exists');
});
