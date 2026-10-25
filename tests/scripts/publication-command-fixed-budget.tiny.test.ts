import {test,expect} from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {commandBudget,MAX_TIMEOUT_MS}=require('../../scripts/lib/afs-publication-command.cjs');
const {resolveExecutableIdentityPath}=require('../../scripts/lib/executable-identity-path.cjs');
// The production caller (consumer-context.ts:886) passes the RESOLVED fixed
// Python, not the raw `/usr/bin/python3` symlink: on Linux that path is a leaf
// symlink, so the identity matcher only accepts its resolved target. Using the
// raw path here asserted a form production never uses.
const fixedPython=resolveExecutableIdentityPath('/usr/bin/python3');
const root=path.resolve(import.meta.dir,'../..');
const cli=[path.join(root,'scripts/check-cli-publication.cjs'),'--evidence',path.join(root,'.test-data/afs-js-archive-ci-producer')];
test('unrelated recipes retain ordinary timeout even with extended labels',()=>{
 for(const options of [{cwd:'/tmp',label:'normal-cli-publication-parent'},{cwd:root,label:'other'}])expect(commandBudget(process.execPath,cli,options).maximumTimeoutMs).toBe(MAX_TIMEOUT_MS);
 expect(commandBudget(process.execPath,[...cli,'--extra'],{cwd:root,label:'normal-cli-publication-parent'}).maximumTimeoutMs).toBe(MAX_TIMEOUT_MS);
});
test('AFS Python fixed recipe uses the single budget authority',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'xpod-registry-module-consumer-'));
 const plan=path.join(cwd,'plan.json');
 fs.writeFileSync(plan,JSON.stringify({checkout:root,temporaryParent:cwd,transport:'collected-product-archives'}));
 const options={cwd,label:'module-registry-consumer'};
 try {
 expect(commandBudget(fixedPython,[path.join(root,'scripts/lib/afs-module-consumer.py'),plan,'--run'],options).maximumTimeoutMs).toBe(require('../../scripts/lib/afs-consumer-budget.cjs').afsConsumerBudget().consumerRunSeconds*1000);
 expect(commandBudget(fixedPython,[path.join(root,'scripts/lib/api-module-consumer.py'),plan,'--run'],options).maximumTimeoutMs).toBe(MAX_TIMEOUT_MS);
 } finally {fs.rmSync(cwd,{recursive:true,force:true});}
});

test('ordinary timeout overflow does not touch a missing executable',()=>{expect(commandBudget('/must-not-spawn',[],{cwd:root,label:'overflow-window'}).maximumTimeoutMs).toBe(MAX_TIMEOUT_MS);});
