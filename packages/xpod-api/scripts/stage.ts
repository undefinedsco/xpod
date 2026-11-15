import {prepareControlledInngestPlacement} from './controlled-native-material';
import controlledPolicy from './inngest-controlled-build-policy.json';
import {materializeApiStaticProducts} from './static-material';
import {attachApiSourcekit, prepareApiBundleStage} from './bundle-stage';
import { classifyInputs } from './closure';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializePhysicalBins } from '../../../scripts/lib/physical-module-bins';
import { stagePhysicalService } from '../../../scripts/lib/physical-module-stage';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const output=process.argv[2]; if (!output) throw new Error('Explicit fresh stage output required');
const mode=process.argv[3],version=process.argv[4];
if ((mode||version) && (!['preview','release'].includes(mode)||!version)) throw new Error('Explicit build mode and exact version required together');
const nativeArgs=process.argv.slice(5);
if(nativeArgs.length && (nativeArgs.length!==4||nativeArgs[0]!=='--native-source-kind'||nativeArgs[1]!==controlledPolicy.sourceKind||nativeArgs[2]!=='--native-build-originals'||!nativeArgs[3]||!publicationModeValid()))throw new Error('Explicit controlled native route arguments required');
function publicationModeValid():boolean{return ['preview','release'].includes(mode)&&Boolean(version);}
const controlled=nativeArgs.length?prepareControlledInngestPlacement(nativeArgs[3],`${process.platform}-${process.arch}`):undefined;
const publication=mode?{mode:mode as 'preview'|'release',version}:undefined;
const build=path.join(root,'packages/xpod-api/dist');
const plan=prepareApiBundleStage(root,build);
const facts=stagePhysicalService(root,path.resolve(output),plan.inputs, {
 nativePlacements:controlled?[controlled]:undefined,
 entry:'src/api/main.ts',moduleId:'api',publication,runtimePackages:plan.runtimePackages,
 runtimePackageManifest:plan.receipt.runtimePackageManifest.path,runtimePackageImports:plan.runtimeImports,
 materializeResources:stage=>materializeApiStaticProducts(root,build,stage),
 bundle:{files:plan.files,verify:()=>{prepareApiBundleStage(root,build);}},
 validateInputs:paths=>{const blockers=classifyInputs(paths.map(file=>({path:file,bytes:readFileSync(path.join(root,file)).length})),root).blockers;if(blockers.length)throw new Error('Forbidden service closure: '+blockers.join(','));},
});
writeFileSync(path.join(output,'provenance','physical-closure.json'),JSON.stringify(facts,null,2)+'\n');

materializePhysicalBins(path.resolve(output),plan.runtimePackages);
writeFileSync(path.join(output,'provenance/static-products.json'),JSON.stringify(plan.staticProducts,null,2)+'\n',{flag:'wx'});

attachApiSourcekit(root,path.resolve(output),plan);
