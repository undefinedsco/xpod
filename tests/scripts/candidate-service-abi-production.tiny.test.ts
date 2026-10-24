/** Production argument forwarding for the ABI membership producer. */
import{test,expect}from'bun:test';
import{execFileSync}from'node:child_process';
const worker=String.raw`
import importlib.util,sys,types
spec=importlib.util.spec_from_file_location('collector','qlever/scripts/sdk-service-abi-collector.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
calls=[]
def provider(cid):
    calls.append(cid)
    return lambda:42
host=types.SimpleNamespace(container_pid_provider=provider)
args=m.membership_arguments(host,'a'*64,'sha256:'+'b'*64,'ghcr.io/undefinedsco/xpod@sha256:'+'c'*64)
assert calls==['a'*64], 'provider binding only; PID resolution must stay lazy'
assert callable(args['membership_pid_provider']),args
assert args['membership_pid_provider']()==42
assert args['membership_container']=={'containerId':'a'*64,'configDigest':'sha256:'+'b'*64,'imageDigest':'ghcr.io/undefinedsco/xpod@sha256:'+'c'*64}
try:
    m.membership_arguments(types.SimpleNamespace(container_pid_provider=lambda cid:None),'a'*64,'sha256:'+'b'*64,'sha256:'+'c'*64)
    raise SystemExit('non-callable accepted')
except ValueError as error:
    assert 'pid provider' in str(error),error
import inspect
source=inspect.getsource(m.membership_arguments)
assert 'container_pid_provider' in source and 'membership_pid_provider' in source
import pathlib
text=pathlib.Path('qlever/scripts/sdk-service-abi-host-session.py').read_text()
assert 'pre_shutdown_hook=capture_membership' in text
assert 'threading.Thread' not in text and 'probe.join' not in text
assert 'def capture_membership' in text
print('ok')
`;
test('collector forwards actual ABI CID PID locator instead of None',()=>{
 const out=execFileSync('/usr/bin/python3',['-I','-S','-B','-c',worker],{maxBuffer:1024**2}).toString().trim();
 expect(out).toBe('ok');
});
