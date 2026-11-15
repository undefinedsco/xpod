/** Deterministic pre-shutdown membership phase over a real short-lived child. */
import{test,expect}from'bun:test';
import{execFileSync}from'node:child_process';
import fs from'node:fs';import path from'node:path';
const worker=String.raw`
import importlib.util,json,os,signal,sys,tempfile,time
spec=importlib.util.spec_from_file_location('transport','qlever/scripts/sdk-service-abi-transport.py')
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
root=tempfile.mkdtemp();root=os.path.realpath(root)
child_code=r'''
import json,os,sys
root=sys.argv[1]
open(os.path.join(root,'started'),'w').close()
print(json.dumps({'type':'ready','abiVersion':1,'adapterAbiVersion':1,'physicalBackendAbiVersion':1}),flush=True)
for line in sys.stdin:
    value=json.loads(line)
    if value.get('type')=='query':
        open(os.path.join(root,'query-done'),'w').close()
        print(json.dumps({'type':'result','id':value.get('id'),'status':'ok'}),flush=True)
    elif value.get('type')=='shutdown':
        open(os.path.join(root,'shutdown'),'w').close()
        break
sys.exit(0)
'''
def start(hook=None):
    argv=[sys.executable,'-I','-S','-B','-c',child_code,root]
    return t.SmokeProcess(argv,expected_abi={'abiVersion':1,'adapterAbiVersion':1,'physicalBackendAbiVersion':1},parent_deadline=time.monotonic()+10,byte_limit=1024*1024,reserve=lambda n:None,cleanup_seconds=2,pre_shutdown_hook=hook)
# Positive: hook runs after query and before shutdown, while pid alive.
events=[];holder={}
def positive():
    child=holder['child'];pid=child.session.process.pid
    assert child.session.process.poll() is None,'callback must run before process exit'
    os.kill(pid,0)
    assert os.path.exists(os.path.join(root,'query-done')),'query must precede callback'
    assert not os.path.exists(os.path.join(root,'shutdown')),'shutdown must not precede callback'
    events.append((pid,os.getpid()))
child=start(positive);holder['child']=child
assert json.loads(child.read_protocol_line())['type']=='ready'
child.write(json.dumps({'type':'query','id':'q1'})+'\n')
assert json.loads(child.read_protocol_line())['type']=='result'
child.write(json.dumps({'type':'shutdown'})+'\n')
stdout,stderr=child.communicate()
assert child.returncode==0 and stderr==''
assert events and events[0][0]==child.session.process.pid
assert os.path.exists(os.path.join(root,'shutdown'))
assert child.pre_shutdown_done is True
# Failure: callback error prevents shutdown delivery; close still owns the group.
root2=os.path.realpath(tempfile.mkdtemp())
def bad():
    raise RuntimeError('actual phase failure')
argv=[sys.executable,'-I','-S','-B','-c',child_code,root2]
child2=t.SmokeProcess(argv,parent_deadline=time.monotonic()+10,byte_limit=1024*1024,reserve=lambda n:None,cleanup_seconds=2,pre_shutdown_hook=bad)
assert json.loads(child2.read_protocol_line())['type']=='ready'
child2.write(json.dumps({'type':'query','id':'q2'})+'\n')
assert json.loads(child2.read_protocol_line())['status']=='ok'
try:
    child2.write(json.dumps({'type':'shutdown'})+'\n')
    raise SystemExit('callback failure was swallowed')
except RuntimeError as error:
    assert 'actual phase failure' in str(error)
assert not os.path.exists(os.path.join(root2,'shutdown')),'failed callback must prevent shutdown bytes'
assert child2.session.process.poll() is None,'failed callback leaves owned process for cleanup'
child2.session.close()
cleanup=child2.session.cleanup
assert cleanup['actualRootWait'] is True and cleanup['ownedGroupAbsent'] is True and cleanup['cleanupErrors']==[]
# Budget abort propagates without writing shutdown; cleanup remains owned.
root3=os.path.realpath(tempfile.mkdtemp())
argv=[sys.executable,'-I','-S','-B','-c',child_code,root3]
child3=t.SmokeProcess(argv,parent_deadline=time.monotonic()+10,byte_limit=1024*1024,reserve=lambda n:None,cleanup_seconds=2,pre_shutdown_hook=lambda:None)
child3.session.end=time.monotonic()-1
try:
    child3.write(json.dumps({'type':'shutdown'})+'\n')
    raise SystemExit('budget abort was swallowed')
except TimeoutError:
    pass
assert not os.path.exists(os.path.join(root3,'shutdown'))
child3.session.close()
assert child3.session.cleanup['actualRootWait'] is True and child3.session.cleanup['ownedGroupAbsent'] is True
# Optional hook preserves existing consumers exactly.
root4=os.path.realpath(tempfile.mkdtemp())
argv=[sys.executable,'-I','-S','-B','-c',child_code,root4]
child4=t.SmokeProcess(argv,parent_deadline=time.monotonic()+10,byte_limit=1024*1024,reserve=lambda n:None,cleanup_seconds=2)
assert json.loads(child4.read_protocol_line())['type']=='ready'
child4.write(json.dumps({'type':'shutdown'})+'\n')
child4.communicate()
assert child4.returncode==0 and not hasattr(child4,'pre_shutdown_done') or child4.pre_shutdown_done is False
print(json.dumps({'positive':True,'failure':True,'budget':True,'optional':True}))
`;
test('synchronous membership callback runs after queries, before shutdown, on a live PID',()=>{
 const result=JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B','-c',worker],{maxBuffer:1024**2}).toString());
 expect(result).toEqual({positive:true,failure:true,budget:true,optional:true});
},20000);
