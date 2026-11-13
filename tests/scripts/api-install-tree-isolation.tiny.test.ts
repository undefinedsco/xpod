import {describe,it,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {parse as parseYaml} from 'yaml';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {prepareIsolatedDependencyTree}=require('../../scripts/api-producer-dependencies.cjs') as {
  prepareIsolatedDependencyTree(cwd:string):boolean;
};
const base=path.resolve(import.meta.dir,'../../.test-data');
function workspace(){
  mkdirSync(base,{recursive:true});
  return mkdtempSync(path.join(base,'api-tree-'));
}
describe('frozen API install starts from a real empty dependency tree',()=>{
  it('removes a reused node_modules so a stale hoist cannot survive the install',()=>{
    const root=workspace();
    try{
      // Mirror the ACTUAL failure: a stale root copy of the wrong major.
      mkdirSync(path.join(root,'node_modules/https-proxy-agent'),{recursive:true});
      writeFileSync(path.join(root,'node_modules/https-proxy-agent/package.json'),
        JSON.stringify({name:'https-proxy-agent',version:'5.0.1'}));
      mkdirSync(path.join(root,'node_modules/gcp-metadata/node_modules/gaxios'),{recursive:true});
      writeFileSync(path.join(root,'node_modules/gcp-metadata/node_modules/gaxios/package.json'),
        JSON.stringify({name:'gaxios',version:'7.1.3'}));
      expect(prepareIsolatedDependencyTree(root)).toBe(true);
      expect(existsSync(path.join(root,'node_modules'))).toBe(false);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('leaves tracked sources, caches and the lock untouched',()=>{
    const root=workspace();
    try{
      mkdirSync(path.join(root,'node_modules/stale'),{recursive:true});
      writeFileSync(path.join(root,'node_modules/stale/package.json'),'{}');
      writeFileSync(path.join(root,'bun.lock'),'immutable-lock');
      writeFileSync(path.join(root,'package.json'),'{"name":"root"}');
      mkdirSync(path.join(root,'src'),{recursive:true});
      writeFileSync(path.join(root,'src/index.ts'),'export const kept=1;');
      prepareIsolatedDependencyTree(root);
      expect(existsSync(path.join(root,'node_modules'))).toBe(false);
      expect(readFileSync(path.join(root,'bun.lock'),'utf8')).toBe('immutable-lock');
      expect(readFileSync(path.join(root,'package.json'),'utf8')).toBe('{"name":"root"}');
      expect(readFileSync(path.join(root,'src/index.ts'),'utf8')).toBe('export const kept=1;');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('is a no-op on an already clean checkout',()=>{
    const root=workspace();
    try{
      writeFileSync(path.join(root,'package.json'),'{"name":"root"}');
      expect(prepareIsolatedDependencyTree(root)).toBe(false);
      expect(existsSync(path.join(root,'package.json'))).toBe(true);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});

describe('exact-identity enforcement is unchanged by the isolation',()=>{
  it('still rejects a wrong installed major instead of accepting it as exact',()=>{
    // The isolation removes the stale tree; it must NOT teach the checker to
    // tolerate a wrong package. This guards against "fixing" the failure by
    // weakening the identity comparison.
    const root=workspace();
    try{
      const integrity='sha512-'+Buffer.alloc(64).toString('base64');
      const ws={name:'@undefineds.co/xpod-api',version:'1.0.0'};
      const put=(rel:string,v:any)=>{
        mkdirSync(path.dirname(path.join(root,rel)),{recursive:true});
        writeFileSync(path.join(root,rel),JSON.stringify(v));
      };
      put('packages/api/package.json',ws);
      put('node_modules/gaxios/package.json',{name:'gaxios',version:'7.1.3'});
      // Deliberately the WRONG major at the root slot the lock reserves for 7.0.6.
      put('node_modules/https-proxy-agent/package.json',{name:'https-proxy-agent',version:'5.0.1'});
      const graph:any={kind:'api-producer-declaration-graph-draft',workspaceMode:'api-ui-root-minimal-v2',
        installSelection:{install:['bun','install'],requiresPostInstallGraphComparison:true},
        isolatedInstall:{argv:['bun','install']},
        workspaces:[{name:ws.name,path:'packages/api'}],
        registry:[{lockKey:'gaxios',identity:'gaxios@7.1.3',integrity},
                  {lockKey:'https-proxy-agent',identity:'https-proxy-agent@7.0.6',integrity}],
        edges:[{from:ws.name,name:'gaxios',range:'7.1.3',lockKey:'gaxios',optional:false},
               {from:'gaxios',name:'https-proxy-agent',range:'^7.0.1',lockKey:'https-proxy-agent',optional:false}]};
      const require2=createRequire(import.meta.url);
      const {inspectApiInstalledGraph}=require2('../../scripts/lib/api-scoped-dependency-state.ts') as {
        inspectApiInstalledGraph(input:any):any;
      };
      expect(()=>inspectApiInstalledGraph({root,graph,readWorkspaceManifest:()=>ws}))
        .toThrow('exact lock identity');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});

/**
 * The desktop bootstrap is the SINGLE Electron initialization. Bun skips Electron's
 * postinstall during the canonical root install, and the root restore replaces
 * node_modules afterwards, so the binary must be initialized after the final tree
 * exists - never before. These assertions pin the order without executing the step.
 */
describe('desktop Electron bootstrap follows the root dependency restore',()=>{
  const workflows:[string,string][]=[
    ['ci.yml','desktop-launch-diagnostic'],
    ['candidate.yml','build_desktop_rc'],
    ['release.yml','build_desktop_macos'],
  ];
  const stepsOf=(file:string,job:string)=>{
    const doc=parseYaml(readFileSync(path.join(import.meta.dir,'../../.github/workflows',file),'utf8')) as any;
    return doc.jobs[job].steps as any[];
  };
  const BOOTSTRAP='node node_modules/electron/install.js';
  const RESTORE='bun scripts/restore-root-dependencies.ts';

  for(const [file,job] of workflows){
    it(`${file} initializes Electron exactly once, after the restore`,()=>{
      const steps=stepsOf(file,job);
      const bootstraps=steps.filter(step=>String(step.run??'').includes(BOOTSTRAP));
      expect(bootstraps).toHaveLength(1);
      const restoreAt=steps.findIndex(step=>String(step.run??'').includes(RESTORE));
      const bootstrapAt=steps.indexOf(bootstraps[0]!);
      expect(restoreAt).toBeGreaterThanOrEqual(0);
      // The restore wipes node_modules; a bootstrap before it would be discarded.
      expect(bootstrapAt).toBeGreaterThan(restoreAt);
    });

    it(`${file} bootstraps before the root compile and desktop packaging`,()=>{
      const steps=stepsOf(file,job);
      const bootstrapAt=steps.findIndex(step=>String(step.run??'').includes(BOOTSTRAP));
      const consumerAt=steps.findIndex(step=>/Compile root package outputs|Build desktop with|stage desktop/i.test(String(step.name??'')));
      expect(bootstrapAt).toBeGreaterThanOrEqual(0);
      expect(consumerAt).toBeGreaterThanOrEqual(0);
      expect(consumerAt).toBeGreaterThan(bootstrapAt);
    });
  }
});
