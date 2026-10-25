import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {derivedSourceView,assertDerivedSourceCurrent,readDerivedSourceOriginals} from './source-context';
import {captureLegalFileIdentity,assertLegalFileIdentity} from './legal-file-custody';
import {inspectNativeLicenseArchiveReader} from './candidate-service-native-license-reader';
import {candidateServiceNativeRuntimeOriginalsView} from './candidate-service-native-runtime-originals';
import {bindCandidateServiceNativeSource,type CandidateServiceNativeContext} from './candidate-service-source-native-context';

/** An adapter over existing private source authority, never a grant issuer.
 * Archive bytes alone cannot establish applicability to compiled output. */
export function candidateServiceNativeLegalMaterials(input:{serviceOriginals:unknown;source:unknown;runtimeArtifact:unknown;nativeContext:CandidateServiceNativeContext;budget:{check():void;chargeReadBytes(bytes:number):void;remainingMs():number;remainingReadBytes():number;reserveBytes(bytes:number):void}}){
 const budget=input.budget,source=input.source;
 const binding=bindCandidateServiceNativeSource(input),context=binding.nativeContext;
 const obtain=()=>{
  budget.check();binding.assertCurrent();
  const view=candidateServiceNativeRuntimeOriginalsView(context.qualification,context.originals,source,context.sdkOriginals,context.sdkAdmission);
  if(!view)throw Error('Native legal materials require the same issued source context');
  view.assertCurrent();return view;
 };
 const view=obtain();
 const coordinates=Object.freeze(view.sourceArchives.map(row=>Object.freeze({name:row.name,version:row.version,dsc:Object.freeze({...row.dsc}),archives:Object.freeze(row.archives.map(ref=>Object.freeze({...ref})))})));
 const originals=new Map(coordinates.flatMap(row=>[row.dsc,...row.archives]).map(ref=>[ref.path,ref]));
 const assertCurrent=()=>{if(obtain()!==view)throw Error('Native legal original reader changed');};
 const scannerPath='qlever/scripts/sdk-service-native-license-archive.py';
 const readArchiveRange=(name:string,offset:number,length:number)=>{
   assertCurrent();const ref=originals.get(name);
   if(!ref||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>65536||length>ref.bytes-offset)throw Error('Bounded authenticated native license archive range required');
   budget.chargeReadBytes(length);const bytes=view.readSourceArchiveRange(name,offset,length);
   if(bytes.length!==length)throw Error('Truncated native legal archive original');
   assertCurrent();return Buffer.from(bytes);
 };
 return Object.freeze({coordinates,assertCurrent,readArchiveRange,
  async scanArchive(name:string,selectedMembers:readonly string[]=[]){
   assertCurrent();const ref=originals.get(name),immutable=derivedSourceView(source);
   if(!ref||!coordinates.some(row=>row.archives.some(archive=>archive.path===name))||!immutable)throw Error('Authenticated native source archive coordinate required');
   const root=fileURLToPath(new URL('../../../',import.meta.url));
   const paths=[scannerPath,'scripts/lib/independent-admission/candidate-service-native-license-reader.ts','scripts/lib/independent-admission/candidate-service-native-legal-materials.ts'];
   const held=await readDerivedSourceOriginals(source,paths,budget);
   const identities=paths.map(path=>{
    if(!immutable.trackedPaths.includes(path))throw Error('Immutable native legal reader source required');
    const actual=resolve(root,path),identity=captureLegalFileIdentity(actual);
    if(identity.size>4194304n)throw Error('Native legal reader source ceiling');
    budget.chargeReadBytes(Number(identity.size));const local=readFileSync(actual),original=held.readTracked(path);
    if(!local.equals(original))throw Error('Native legal reader differs from held source');assertLegalFileIdentity(identity);return identity;
   });
   const guard=()=>{assertCurrent();assertDerivedSourceCurrent(source,budget);held.assertCurrent();identities.forEach(assertLegalFileIdentity);};
   const scannerSource=held.readTracked(scannerPath);
   return inspectNativeLicenseArchiveReader({archive:ref,scannerSource,selectedMembers,budget,assertCurrent:guard,read:(offset,length)=>readArchiveRange(name,offset,length)});
  },
  inputsForOrigin(origin:{path:string;runtimePath:string;original:unknown}){
   assertCurrent();if(!binding.origins.some(row=>row.path===origin.path&&row.runtimePath===origin.runtimePath&&row.original===origin.original))throw Error('Exact private native output origin required');
   const rows=view.inputBindingsForMember(origin.runtimePath);assertCurrent();return rows;
  },

 });
}
