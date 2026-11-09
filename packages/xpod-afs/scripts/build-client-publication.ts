import { mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAfsClient } from './build-client';
import { resolveProducerInput, resolveRuntimeClientInput } from './producer-input';
import { resolveProducerMaterials } from './producer-materials';
import { withStagedProducerInput } from './staged-producer-input';
const { stageAndPackClient } = createRequire(import.meta.url)('./client-publication-run.cjs');
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function buildClientPublication(args: string[]): Promise<void> {
  const positions=args.flatMap((value,index)=>value==='--output'?[index]:[]);
  if(positions.length!==1||!args[positions[0]+1]||args[positions[0]+1].startsWith('--'))throw new Error('Required one fresh publication output');
  const output=path.resolve(args[positions[0]+1]);
  // Require the caller's existing real parent; emitter checks canonical ancestors.
  const parent=realpathSync(path.dirname(output));
  if(parent!==path.dirname(output))throw new Error('Publication output parent must be canonical');
  if(output===packageRoot||output.startsWith(packageRoot+path.sep))throw new Error('External publication output required');
  const input=resolveProducerInput(args),client=resolveRuntimeClientInput(args);
  mkdirSync(output,{recursive:false});
  await withStagedProducerInput(input,path.join(packageRoot,'.test-data'),async staged=>{
    await resolveProducerMaterials(staged.indexPath,client,staged.tools);
    await buildAfsClient(staged,client);
    const materials=await resolveProducerMaterials(staged.indexPath,client,staged.tools);
    await stageAndPackClient({packageRoot,repoRoot:path.resolve(packageRoot,'../..'),output,binding:materials.binding,assertCurrent:()=>staged.assertCurrent()});
    staged.assertCurrent();
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildClientPublication(process.argv.slice(2));
