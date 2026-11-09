"""Installed API probes; the caller owns the sandbox and child lifecycle.

These inspect an installed module, never a repository import. They do not
validate Chat, remote Pod access, Inngest, or registry publication.
"""
import json
import pathlib
import time
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError('API probe redirect rejected')


def read_local(base, route, limit):
    url = base + route
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(url, timeout=2) as response:
        if response.geturl() != url or response.status != 200:
            raise ValueError('API probe redirect/status mismatch')
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError('API probe response exceeds bound')
        return body


def healthy(runner, process, base, package_root, runtime):
    deadline = time.monotonic() + runner.plan.get('timeoutSeconds', 180)
    while True:
        runner.observe_group(process)
        runner.gate()
        if process.poll() is not None:
            raise ValueError('public API exited before health')
        try:
            value = json.loads(read_local(base, 'health', 1024))
            if value != {'status': 'ok'}:
                raise ValueError('API health body mismatch')
            break
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise ValueError('API health startup deadline')
            time.sleep(.2)
    assets = []
    for route, relative in [('dashboard/', 'static/dashboard/dashboard.html'),
                            ('settings/', 'static/settings/settings.html')]:
        path = package_root / relative
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(package_root.resolve()):
            raise ValueError('installed API static asset escaped package')
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('installed API static asset exceeds bound')
        expected = path.read_bytes()
        if read_local(base, route, len(expected)) != expected:
            raise ValueError('API static bytes differ from installed module')
        assets.append(relative)
    (runner.output / (runtime + '-api-health.json')).write_text(json.dumps({
        'health': value, 'exactInstalledAssets': assets,
        'chatValidated': False, 'remotePodValidated': False,
    }) + '\n')


# Adapted from the previously executed API30 installed dependency probes.
# The module root is an argument from the verified installed pointer.
PGLITE = """import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';import fs from 'node:fs';
import assert from 'node:assert/strict';import path from 'node:path';
const root=fs.realpathSync(process.argv[2]);const require=createRequire(root+'/package.json');
const resolved=require.resolve('@electric-sql/pglite');
assert(fs.realpathSync(resolved).startsWith(root+path.sep));
const {PGlite}=await import(pathToFileURL(resolved).href);const db=new PGlite();
try{await db.waitReady;const result=await db.query('SELECT 1::int AS value');
assert.equal(result.rows[0].value,1);console.log(JSON.stringify({pglite:true,value:1}));}
finally{await db.close();console.log(JSON.stringify({closed:true}));}
"""

RDF = """import {createRequire} from 'node:module';import fs from 'node:fs';
import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import path from 'node:path';
const root=fs.realpathSync(process.argv[2]);const require=createRequire(root+'/package.json');
const enginePath=require.resolve('@comunica/query-sparql-solid');
assert(fs.realpathSync(enginePath).startsWith(root+path.sep));
const ownerRequire=createRequire(enginePath);const n3Path=ownerRequire.resolve('n3');
assert(fs.realpathSync(n3Path).startsWith(root+path.sep));
await import(pathToFileURL(root+'/entry.mjs').href);
let healthy=false;for(let n=0;n<200;n++){try{const response=await fetch('http://127.0.0.1:'+process.env.API_PORT+'/health');if(response.ok){healthy=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}assert(healthy);
for(const name of ['@comunica/actor-query-result-serialize-sparql-json','@comunica/actor-query-result-serialize-stats']){
const ownPath=require.resolve(name),engineObserverPath=ownerRequire.resolve(name);
assert(fs.realpathSync(ownPath).startsWith(root+path.sep),'observer outside installed module');
assert(fs.realpathSync(engineObserverPath).startsWith(root+path.sep),'engine observer outside installed module');
assert.equal(ownPath,engineObserverPath);
const own=require(name),fromEngine=ownerRequire(name);
assert.equal(own.ActionObserverHttp,fromEngine.ActionObserverHttp);
assert.equal(own.ActionObserverHttp.prototype.__xpodObservedActorsPatched,true);}
const {QueryEngine}=await import(pathToFileURL(enginePath).href);
const {Store,DataFactory}=await import(pathToFileURL(n3Path).href);
const {namedNode,literal,quad}=DataFactory;
const store=new Store([quad(namedNode('urn:module:s'),namedNode('urn:module:p'),literal('actual-installed-rdf'))]);
const engine=new QueryEngine();const bindings=await engine.queryBindings(
'SELECT ?value WHERE { <urn:module:s> <urn:module:p> ?value }',{sources:[store]});
const rows=await bindings.toArray();assert.equal(rows.length,1);
assert.equal(rows[0].get('value').value,'actual-installed-rdf');await engine.invalidateHttpCache();
console.log(JSON.stringify({rdf:true,bindingsStreamClosed:true,actualApiPatchedObserverPrototypeShared:true}));
// The owning harness sends normal TERM to this API parent and waits for closure.
"""


def write_probe(directory, name):
    scripts = {'pglite': PGLITE, 'rdf': RDF}
    if name not in scripts:
        raise ValueError('unknown API dependency probe')
    path = pathlib.Path(directory) / (name + '.mjs')
    with path.open('x') as stream:
        stream.write(scripts[name])
    return path
