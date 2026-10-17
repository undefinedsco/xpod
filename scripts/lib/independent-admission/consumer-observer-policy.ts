import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import current from './consumer-execution-current.json';
import type {GitHubSourceBindingGroup} from './github-source-binding-groups';
/** Exact consumer source implementation reviewed with the v18 workflow tree.
 * These bind the actual checked-out source, separately from run-head YAML. */
export const CONSUMER_SOURCE_BINDINGS = Object.freeze([
  {path:'scripts/run-independent-publication.ts',sha256:'5e38f533dbe9e6e01639b5c189d97ea51380725eb3f7e62865aabe40a56e02de'},
  {path:'scripts/module-product-targets.ts',sha256:'d04fb106ca349179e4b99869c68cbb85b8d9a9f30e8d60b927a5eceab9e2f25f'},
  {path:'scripts/lib/independent-admission/consumer-context.ts',sha256:'573765a371a45a58d7368c376fe2f09d8f3ca11dfc4607a1de12b25bbda67270'},
  {path:'scripts/lib/independent-admission/consumer-profiles.ts',sha256:'d641b4426036d58fabbcf4365136acac8931569fa718498d9073e29ca59db6a6'},
  {path:'scripts/lib/independent-admission/peer-input-plan.ts',sha256:'c721769cc39635265bf4e4f61178275d2aefc7816c64a9d962c98fde8de6f320'},
  {path:'scripts/lib/module-consumer.py',sha256:'d2c1976a6e594d9b289c78f7d0beb5ff2d45c24dfbabd690db664f181edccd2e'},
  {path:'scripts/api-module-consumer.py',sha256:'70f85ca6047834575f9d37d851031f1f8f612c274f4506219ac0757279e28695'},
  {path:'scripts/css-module-consumer.py',sha256:'0c140d6bfdf9b0ed5111a06149169edd48492101e767748f91af730148f0ed05'},
  {path:'scripts/lib/api-consumer-probes.py',sha256:'fc71c837089affca5b2f67fe43c8becf1a167a981309dc0b5213fc4ec33e665b'},
  {path:'scripts/lib/module-consumer-targets.py',sha256:'910eb681cb4f8032b9a0753988bc9a7063cfe645344073a2fb17dc96b33b1619'},
  {path:'scripts/verify-module-consumer-native.ts',sha256:'1c18d4b524a7fdc5a856b73a59f384990ec0af84434c51498b7b7844e346e4ec'},
  {path:'scripts/lib/afs-publication-command.cjs',sha256:'e00e81eac425ece4ab9fa76701591af835fb41634bd366907e88a91cedde7513'},
]);

/** Trusted controller module-load originals, never candidate-provided hashes.
 * Runtime comparison avoids writing a policy digest into its own manifest. */
export const CONTROLLER_POLICY_BINDINGS=Object.freeze(['consumer-observer-policy.ts','consumer-execution-current.json'].map(name=>{
 const file=fileURLToPath(new URL(name,import.meta.url)),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size>2n*1024n**2n)throw Error('Bounded controller policy original required');
  const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(file,{bigint:true});
  for(const row of [after,named])if(!['dev','ino','mode','size','nlink','mtimeNs','ctimeNs'].every(key=>before[key as keyof typeof before]===row[key as keyof typeof row]))throw Error('Controller policy original changed at module load');
  if(BigInt(bytes.length)!==before.size)throw Error('Controller policy original truncated');
  if(name.endsWith('.json')&&JSON.stringify(JSON.parse(bytes.toString('utf8')))!==JSON.stringify(current))throw Error('Controller policy imported data changed');
  return Object.freeze({path:'scripts/lib/independent-admission/'+name,sha256:createHash('sha256').update(bytes).digest('hex')});
 }finally{fs.closeSync(fd);}
}));

const workflowSelectors=(archive:string,registry:string)=>Object.freeze([
 {path:'.github/workflows/independent-publication-wave.yml',sha256:'d0663ca80b76dd9c9f3dcdba7a0ed472965a23cd87f0080a5a944e76123eff4b',ref:'run-head' as const},
 {path:'.github/workflows/independent-archive-consumer.yml',sha256:archive,ref:'run-head' as const},
 {path:'.github/workflows/independent-registry-consumer.yml',sha256:registry,ref:'run-head' as const},
]);
/** Same parent bytes invoke different reviewed child trees. Select the complete
 * child tuple first, then require every exact source dependency in that group. */
export const CONSUMER_SOURCE_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 Object.freeze({selectors:workflowSelectors('abb2f08b7785f3e31434d3bc6f7d0e179fba9f7d7e87e863473abe4960925c2d','b0f9b7e6619f76c973152afcf741e0184ebb09a4a3a339c9938705cd09475dbd'),sourceBindings:CONSUMER_SOURCE_BINDINGS}),
 Object.freeze({selectors:workflowSelectors('7162065092c1e1377e4a504da9b8138c8a6abe492566154107de2835d3bf8ec5','e0884282db86fd2463e4c95db1ae0498d21480e3c3f05545ee34289e8448f236'),sourceBindings:Object.freeze([...current.map(row=>Object.freeze({...row})),...CONTROLLER_POLICY_BINDINGS])}),
]);

/** Registered CI route has exact versioned caller trees, separate from historical
 * standalone dispatch. Helpers are bound only after the whole tree selects. */
export const CI_PUBLICATION_WORKFLOW_SHA='d16b77e564d2f84795bdea2ef806f6fb36c80aa7a1c1017ac18c4606ad2a1dae';
export const CALLABLE_PUBLICATION_WORKFLOW_SHA='5b830f4a3375a7f886f19b5617db5694b7cdcab23d21d82661d01899300e9e07';
export const STAGING_CHECKED_PUBLICATION_WORKFLOW_SHA='d72284b8dc5b91669f0b41a8dafca787b6e1581a495d891cead38a07d9ab0852';
export const CI_CONSUMER_SOURCE_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([CALLABLE_PUBLICATION_WORKFLOW_SHA,STAGING_CHECKED_PUBLICATION_WORKFLOW_SHA].map(workflowSha=>
 Object.freeze({selectors:Object.freeze([
  {path:'.github/workflows/independent-publication.yml',sha256:workflowSha,ref:'run-head' as const},
  ...workflowSelectors('7162065092c1e1377e4a504da9b8138c8a6abe492566154107de2835d3bf8ec5','e0884282db86fd2463e4c95db1ae0498d21480e3c3f05545ee34289e8448f236'),
 ]),sourceBindings:Object.freeze([...current.map(row=>Object.freeze({...row})),...CONTROLLER_POLICY_BINDINGS])})
));
