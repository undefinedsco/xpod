import {test, expect} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectNativeHostOriginals} from '../../scripts/lib/independent-admission/candidate-service-native-host-originals';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// The fixture executes the real producer's command constructors, with a capture
// transport. It tests protocol semantics, not Docker or a positive private cap.
function fixture() {
  const helper = fileURLToPath(new URL('../../qlever/scripts/sdk-service-native-runtime-host.py', import.meta.url));
  const rows = JSON.parse(execFileSync('python3', ['-B', '-c', `
import importlib.util,json,sys,types
from pathlib import Path
spec=importlib.util.spec_from_file_location('host',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
rows={};nonce='a'*16;runtime='b'*64;builder='c'*64
sdk='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'d'*64
image='ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:'+'e'*64
config='sha256:'+'f'*64
class Budget:
 deadline=999999.0
 def check(self):pass
 def remaining(self):return 134217728
 def reserve(self,n):pass
budget=Budget()
def stage(name,command,*args,**kwargs):
 text={'host-git-head':'1'*40,'host-runtime-inspect':config,'host-runtime-create':runtime,'host-builder-create':builder}.get(name,'')
 rows[name]={'command':command,'text':text}
 return {'exit':0,'actualWait':True,'ownedGroupAbsentAfterWait':True},text
repo=h.ROOT;evidence=Path('/evidence')
h.git_head(repo,stage=stage,budget=budget,evidence=evidence)
stage('host-runtime-pull',['docker','pull',image])
h.inspect_image(image,stage=stage,budget=budget,evidence=evidence)
h.create_container('xpod-native-runtime-copy-'+nonce,image,stage=stage,budget=budget,evidence=evidence)
h.capture_runtime(runtime,Path('/expected'),stage=stage,budget=budget,evidence=evidence,inner=types.SimpleNamespace(manifest=lambda *args,**kwargs:{}))
h.build_inputs(source_sha='1'*40,sdk_image=sdk,tag='xpod-native-build-inputs:'+nonce,stage=stage,budget=budget,evidence=evidence)
h.create_builder('xpod-native-build-'+nonce,'xpod-native-build-inputs:'+nonce,repo=repo,inputs=Path('/inputs'),out=Path('/out'),source_sha='1'*40,sdk_image=sdk,runtime_image=image,runtime_config=config,run_id=1,run_attempt=1,job='publish',inner_maximum=100000000,deadline=999999.0,stage=stage,budget=budget,evidence=evidence)
stage('host-builder-start',['docker','start','--attach',builder])
for cid in [builder,runtime]:h.remove_container(cid,stage=stage,evidence=evidence,deadline=999999.0)
print(json.dumps(rows))
`, helper], {timeout: 5000}).toString());
  const originals = new Map<string, Buffer>(); let index = 0;
  for (const [name, row] of Object.entries(rows) as [string, any][]) {
    const raw = Buffer.from(row.text), at = ++index * 100;
    originals.set('host/' + name + '.raw.log', raw);
    originals.set('host/' + name + '.receipt.json', Buffer.from(JSON.stringify({command: row.command, exit: 0, signal: null,
      pid: 3, pgid: 3, actualWait: true, ownedGroupAbsentAfterWait: true, rawClosedBeforeHash: true,
      actualRawPipeEof: true, rawOverflow: false, resourceStop: null, supervisorError: null, cleanupErrors: [],
      retainedRawBytes: raw.length, rawSHA256: sha(raw), startedUTC: new Date(at).toISOString(), closedUTC: new Date(at + 1).toISOString()})));
  }
  const input = {identity: {sourceSha: '1'.repeat(40), sdkImage: 'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:' + 'd'.repeat(64),
    runtimeImage: 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + 'e'.repeat(64), runtimeConfigDigest: 'sha256:' + 'f'.repeat(64), runId: 1, runAttempt: 1, job: 'publish'},
    containers: {runtimeContainerId: 'b'.repeat(64), buildContainerId: 'c'.repeat(64)}, window: {started: 0, completed: 10000},
    read(name: string) {const bytes = originals.get(name); if (!bytes) throw Error('missing ' + name); return Buffer.from(bytes);}, check() {}};
  return {input, originals, change(name: string, mutate: (row: any) => void) {const path = 'host/' + name + '.receipt.json'; const row = JSON.parse(originals.get(path)!.toString()); mutate(row); originals.set(path, Buffer.from(JSON.stringify(row)));}};
}
test('real host command constructors join exact image, SDK, owned containers and cleanup', () => {
 const value = fixture(); expect(inspectNativeHostOriginals(value.input).stageCount).toBe(10);
});
test('reject changed runtime image, CID, extra builder command and nonclosed stage', () => {
 for (const mutate of [
   (value: ReturnType<typeof fixture>) => {value.input.identity.runtimeConfigDigest = 'sha256:' + '0'.repeat(64);},
   (value: ReturnType<typeof fixture>) => {value.input.containers.runtimeContainerId = 'a'.repeat(64);},
   (value: ReturnType<typeof fixture>) => value.change('host-builder-create', row => row.command.push('--privileged')),
   (value: ReturnType<typeof fixture>) => value.change('host-builder-start', row => {row.ownedGroupAbsentAfterWait = false;}),
   (value: ReturnType<typeof fixture>) => {value.input.window.completed = 200;},
 ]) {const value = fixture(); mutate(value); expect(() => inspectNativeHostOriginals(value.input)).toThrow();}
});
test('reject raw tamper and missing cleanup original', () => {
 const value = fixture(); value.originals.set('host/host-runtime-inspect.raw.log', Buffer.from('wrong'));
 expect(() => inspectNativeHostOriginals(value.input)).toThrow();
 const missing = fixture(); missing.originals.delete('host/host-owned-remove-' + 'c'.repeat(12) + '.receipt.json');
 expect(() => inspectNativeHostOriginals(missing.input)).toThrow();
});
