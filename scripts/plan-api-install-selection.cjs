#!/usr/bin/env bun
'use strict';
/** Empty-checkout immutable declaration selection; never install/qualification. */
const { execFileSync } = require('node:child_process');
const { deriveApiInstallSelection } = require('./lib/api-install-selection.cjs');
function immutableApiGraphInput(sourceSha,target,cwd=process.cwd()){
if (!/^[a-f0-9]{40}$/u.test(sourceSha)||!['linux-arm64','linux-x64','darwin-arm64','darwin-x64'].includes(target))throw Error('Exact immutable source and canonical target required');
const git=values=>execFileSync('git',values,{cwd,maxBuffer:4*1024**2,timeout:10000});
const trackedPaths=git(['ls-tree','-r','--name-only',sourceSha]).toString().split('\n').filter(Boolean);
return {sourceSha,target,trackedPaths,readGitObject(name){const row=git(['ls-tree',sourceSha,'--',name]).toString(),match=/^(100644|100755) blob [a-f0-9]{40}\t([^\n]+)\n$/u.exec(row);if(!match||match[2]!==name)throw Error('Exact ordinary immutable source object required');return {mode:match[1],bytes:git(['show',sourceSha+':'+name])};}};
}
module.exports={immutableApiGraphInput};
if(require.main===module){
const args = process.argv.slice(2);
if (args.length !== 2 || !/^[a-f0-9]{40}$/u.test(args[0]) || !['linux-arm64', 'linux-x64', 'darwin-arm64', 'darwin-x64'].includes(args[1])) throw Error('Expected exact source SHA and canonical target');
const plan=deriveApiInstallSelection(immutableApiGraphInput(args[0],args[1]));
process.stdout.write(JSON.stringify(plan,null,2)+'\n');
}
