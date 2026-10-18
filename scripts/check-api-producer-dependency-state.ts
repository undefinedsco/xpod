#!/usr/bin/env bun
/** Matching-host immutable full-graph state check; no install/repair/admission. */
import {createRequire} from 'node:module';
import {inspectApiInstalledGraph} from './lib/api-scoped-dependency-state';
import {inspectDependencyState,reportDependencyState} from './check-dependency-state';
const require=createRequire(import.meta.url);
const {checkedGraph}=require('./api-producer-dependencies.cjs') as {checkedGraph(sha:string,target:string,file:string):Promise<{input:{readGitObject(name:string):{bytes:Buffer}};graph:any}>};
const [sha,target,file,...extra]=process.argv.slice(2);
if(extra.length||!sha||!target||!file||target!==process.platform+'-'+process.arch)throw Error('Matching-host exact API scope arguments required');
const {input,graph}=await checkedGraph(sha,target,file);
const scope=inspectApiInstalledGraph({root:process.cwd(),graph,readWorkspaceManifest(directory){return JSON.parse(input.readGitObject(directory?directory+'/package.json':'package.json').bytes.toString());}});
console.log(JSON.stringify({schemaVersion:1,kind:'api-installed-peer-provider-observations',scope:'actual selected physical identities and peer ranges only; not upstream archive byte integrity or release admission',peerProviders:scope.peerProviders}));
reportDependencyState(inspectDependencyState(scope));
