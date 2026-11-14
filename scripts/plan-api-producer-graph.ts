/** Read-only immutable declaration projection; never installs or builds. */
import {execFileSync} from 'node:child_process';
import {deriveApiProducerGraph} from './lib/api-producer-graph';
const args=process.argv.slice(2);
if(![2,3].includes(args.length)||!/^([a-f0-9]{40})$/u.test(args[0]!)||!['linux-arm64','linux-x64','darwin-arm64','darwin-x64'].includes(args[1]!))throw Error('Expected exact source SHA and canonical target');
const sourceSha=args[0]!,target=args[1] as Parameters<typeof deriveApiProducerGraph>[0]['target'];
const git=(values:string[])=>execFileSync('git',values,{maxBuffer:4*1024**2,timeout:10000});
const trackedPaths=git(['ls-tree','-r','--name-only',sourceSha]).toString().split('\n').filter(Boolean);
const workspaceMode=(args[2]??'conservative-all-v1') as 'conservative-all-v1'|'api-ui-v1'|'api-ui-root-minimal-v2';
const plan=deriveApiProducerGraph({sourceSha,target,trackedPaths,workspaceMode,readGitObject(name){
 const row=git(['ls-tree',sourceSha,'--',name]).toString();const match=/^(100644|100755) blob [a-f0-9]{40}\t([^\n]+)\n$/u.exec(row);
 if(!match||match[2]!==name)throw Error('Exact ordinary immutable source object required');
 return {mode:match[1]!,bytes:git(['show',sourceSha+':'+name])};
}});
process.stdout.write(JSON.stringify(plan,null,2)+'\n');
