import {createHash} from 'node:crypto';
import {inspectTranspiledLegalMappingView} from './legal-source-mappings';
import type {NativeInputSnapshot} from './candidate-service-native-input-join';
import type {CollectedArtifactView} from './artifact-contract';

/** Pure applicability mechanics. The caller must select the source archive
 * through the authenticated binary/source coordinate, never by filename. */
export function inspectNativeArchiveInputApplicability(input:{
 original:NativeInputSnapshot; memberPath:string; sourceSha:string;
 members:readonly {path:string;type:string;bytes:number;sha256?:string}[];
 texts:readonly {path:string;bytes:number;sha256:string;text:Buffer}[];
 artifact:CollectedArtifactView; check():void; chargeReadBytes(bytes:number):void;
 verifyGrant(bytes:Buffer):boolean; declarations(bytes:Buffer):string[];
}){
 input.check();
 const candidates=input.members.filter(row=>row.type==='file'&&row.bytes===input.original.bytes&&row.sha256===input.original.sha256);
 if(!candidates.length)return {covered:false,pending:['Native installed input has no byte-identical original source member: '+input.original.path]};
 const texts=new Map<string,Buffer>();
 for(const row of input.texts){input.check();if(texts.has(row.path)||row.text.length!==row.bytes||createHash('sha256').update(row.text).digest('hex')!==row.sha256)throw Error('Native source text identity differs');const member=input.members.find(m=>m.type==='file'&&m.path===row.path&&m.bytes===row.bytes&&m.sha256===row.sha256);if(!member)throw Error('Native source text absent from complete archive');texts.set(row.path,row.text);}
 // Multiple identical members can have different terms: every actual matching
 // source scope must be satisfied, never select the first convenient license.
 const result=inspectTranspiledLegalMappingView({material:{sourceSha:input.sourceSha,outputs:input.artifact.members,transpiledOutputs:candidates.map(row=>({path:input.memberPath,sourcePath:row.path}))},artifactSourceSha:input.sourceSha,sourceSha:input.sourceSha,trackedPaths:input.members.filter(row=>row.type==='file').map(row=>row.path),readTracked:name=>{input.check();const bytes=texts.get(name);if(!bytes)throw Error('Selected native source text not retained: '+name);input.chargeReadBytes(bytes.length);input.check();return bytes;},artifactMembers:input.artifact.members,check:input.check},input.verifyGrant,input.declarations);
 input.check();return {covered:result.pending.length===0&&result.coveredOutputs.includes(input.memberPath),pending:result.pending};
}
