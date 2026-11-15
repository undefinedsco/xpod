import {createHash} from 'node:crypto';
import {inspectTranspiledLegalMappingView} from './legal-source-mappings';
import type {NativeInputCovered} from './candidate-service-native-input-join';
import type {CollectedArtifactView,DerivedSourceView} from './artifact-contract';
export interface NativeGrantReadBudget {check():void;remainingMs():number;remainingReadBytes():number;chargeReadBytes(bytes:number):void}
/** Pure conservative applicability over the private producer's full input
 * union. Tool executables are not invented as product input copyright. */
export function inspectNativeGitInputGrants(input:{inputs:readonly NativeInputCovered[];source:DerivedSourceView;artifact:CollectedArtifactView;memberPath:string;readTracked(path:string):Buffer;budget:NativeGrantReadBudget;check():void;verifyGrant(bytes:Buffer):boolean;declarations(bytes:Buffer):string[]}){
 const check=()=>{input.check();input.budget.check();if(input.budget.remainingMs()<=0)throw Error('Native grant shared deadline exhausted');};
 const readTracked=(name:string)=>{check();if(input.budget.remainingReadBytes()<=0)throw Error('Native grant shared read budget exhausted');const bytes=input.readTracked(name);check();return bytes;};
 const pending:string[]=[],mappings:{path:string;sourcePath:string}[]=[];
 if(!input.inputs.length)pending.push('Native output has no authenticated contributing input bindings: '+input.memberPath);
 for(const row of input.inputs){
  input.check();
  if(row.kind!=='reads')throw Error('Native product grant cannot substitute an executed tool');
  if(row.via!=='git'){pending.push('Native '+row.via+' input requires original package/source license applicability: '+row.path+':'+row.sha256);continue;}
  const prefix='/workspace/xpod/',name=row.path.startsWith(prefix)?row.path.slice(prefix.length):'';
  if(!name||!input.source.trackedPaths.includes(name))throw Error('Native contributing Git input absent');
  const bytes=readTracked(name);check();
  if(bytes.length!==row.bytes||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('Native contributing Git input changed');
  mappings.push({path:input.memberPath,sourcePath:name});
 }
 const observed=inspectTranspiledLegalMappingView({material:{sourceSha:input.source.sourceSha,outputs:input.artifact.members,transpiledOutputs:mappings},artifactSourceSha:input.source.sourceSha,sourceSha:input.source.sourceSha,trackedPaths:input.source.trackedPaths,readTracked,artifactMembers:input.artifact.members,check},input.verifyGrant,input.declarations);
 pending.push(...observed.pending);input.check();return Object.freeze({covered:pending.length===0&&mappings.length>0&&observed.coveredOutputs.includes(input.memberPath),pending:Object.freeze([...new Set(pending)])});
}
