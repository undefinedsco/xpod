#!/usr/bin/env python3
"""Real Linux ptrace/leases -> full production replay, no mocked acquisition."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import traceback
import subprocess
import unittest
spec=importlib.util.spec_from_file_location('generation_e2e_factory',Path(__file__).with_name('test_sdk70_mremap_e2e.py'))
e2e=importlib.util.module_from_spec(spec);sys.modules[spec.name]=e2e;spec.loader.exec_module(e2e)
C=r'''
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
static int handoff(char *archive){
 char marker[4096];snprintf(marker,sizeof(marker),"%s.ready",archive);
 int signal=open(marker,O_WRONLY|O_CREAT|O_EXCL,0600);if(signal<0||write(signal,"ready",5)!=5||close(signal))return 40;
 snprintf(marker,sizeof(marker),"%s.done",archive);
 int tries=0;while(access(marker,F_OK)){if(++tries>5000)return 41;usleep(1000);}
 return 0;
}
int main(int argc,char**argv){
 int fd=-1;
 if(strcmp(argv[2],"existing")){
 fd=open(argv[1],(!strcmp(argv[2],"source-alias")||!strcmp(argv[2],"source-read-only"))?O_RDWR:(O_RDWR|O_CREAT|O_EXCL),0600); if(fd<0)return 2;
 if(write(fd,"!<arch>\n",8)!=8)return 3;if(close(fd))return 4;
 if(!strcmp(argv[2],"create"))return 0;
 }
 const char *input=(!strcmp(argv[2],"source-alias")||!strcmp(argv[2],"source-read-only"))?argv[3]:argv[1];
 int rd=open(input,O_RDONLY);char buf[8];if(rd<0||read(rd,buf,8)!=8)return 5;
 if(!strcmp(argv[2],"source-read-only")){close(rd);return 0;}
 if(!strcmp(argv[2],"foreign-held")&&handoff(argv[1]))return 40;
 if(!strcmp(argv[2],"peer-map")){
  int ready[2];if(pipe(ready))return 50;pid_t peer=fork();if(peer<0)return 51;
  if(!peer){close(ready[0]);if(mmap(0,8,PROT_READ,MAP_PRIVATE,rd,0)==MAP_FAILED)_exit(52);if(write(ready[1],"R",1)!=1)_exit(53);for(;;)pause();}
  close(ready[1]);char token;if(read(ready[0],&token,1)!=1)return 54;close(ready[0]);
 }
 if(!strcmp(argv[2],"mmap-unmap")){
  void *mapping=mmap(0,8,PROT_READ,MAP_PRIVATE,rd,0);if(mapping==MAP_FAILED||munmap(mapping,8))return 60;
 }
 int hold=!strcmp(argv[2],"hold");int map=!strcmp(argv[2],"map");
 if(map&&mmap(0,8,PROT_READ,MAP_PRIVATE,rd,0)==MAP_FAILED)return 6;
 if(!hold&&!map)close(rd);
 if(!strcmp(argv[2],"ar")){
  char member[4096];snprintf(member,sizeof(member),"%s.member",argv[1]);
  int m=open(member,O_WRONLY|O_CREAT|O_EXCL,0600);if(m<0||write(m,"payload",7)!=7||close(m))return 20;
  pid_t child=fork();if(child<0)return 21;
  if(!child){execl("/usr/bin/ar","ar","qc",argv[1],member,(char*)0);_exit(22);}
  int status=0;if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status))return 23;
  return 0;
 }
 fd=open(argv[1],O_WRONLY|O_TRUNC|O_NONBLOCK);if(fd<0){perror("write-open");return 7;}
 if(!strcmp(argv[2],"swap")){int copy=dup(fd);close(fd);dup2(copy,fd);close(copy);}
 if(write(fd,"B",1)!=1)return 8;
 if(!strcmp(argv[2],"truncate")&&(ftruncate(fd,9)||ftruncate(fd,1)))return 30;
 if(!strcmp(argv[2],"foreign")&&handoff(argv[1]))return 40;
 if(close(fd))return 9;
 if(hold)close(rd);
 rd=open(input,O_RDONLY);if(rd<0||read(rd,buf,8)!=1||buf[0]!='B')return 10;
 return close(rd)?11:0;
}
'''

class Generation(e2e.EndToEnd):
 def run_case(self,mode='plain',source=False,enabled=True):
  label=('source-' if source else 'build-')+mode
  base=self.root/label;base.mkdir();originals=base/'originals';originals.mkdir();build=base/'build';build.mkdir();src=base/'source';src.mkdir()
  self.trusted_roots[label]=str(build.resolve())
  observer=e2e.make_observer(originals,str(build.resolve()))
  for key in ('generated_vma_output','generated_vma_shared_mm','generated_vma_private_wake','generated_vma_private_wait_mismatch','generated_vma_coordinated_wait','generated_vma_parked_wait','retained_generated_metadata'):setattr(observer,key,False)
  observer.generated_vma=None
  observer.source=str(src)
  if enabled:
   observer.owned_input_generations=e2e.obs.owned_input_module.Runtime(observer,e2e.obs.SimpleNamespace(probe=e2e.obs.probe,bindings=e2e.obs.bindings,memory_policy=e2e.obs.memory_policy,profile=e2e.obs.profile,path_argument=e2e.obs.path_argument,descriptor_flags=e2e.obs.descriptor_flags))
  binary=e2e.build(C,self.root/'bin','generation-'+label)
  archive=(src if source else build)/'libtest.a'
  alias_source=src/'original-input.a'
  if mode=='source-alias':alias_source.write_bytes(b'AAAAAAAA');os.link(alias_source,archive)
  phase=None;error=None;external=None
  if mode in ('foreign','foreign-held'):
   program="""import os,sys,time,json
from pathlib import Path
p=Path(sys.argv[1]);deadline=time.monotonic()+8
while not Path(str(p)+'.ready').exists():
 if time.monotonic()>deadline:raise RuntimeError('external handshake marker never appeared')
 time.sleep(.001)
try:fd=os.open(p,os.O_WRONLY|os.O_NONBLOCK)
except OSError as error:result=dict(pid=os.getpid(),opened=False,written=0,errorCode=error.errno)
else:
 before=os.fstat(fd);written=os.pwrite(fd,b'Z',0);os.fsync(fd);after=os.fstat(fd);os.close(fd)
 result=dict(pid=os.getpid(),opened=True,written=written,beforeSize=before.st_size,afterSize=after.st_size,afterMtimeNs=after.st_mtime_ns)
Path(str(p)+'.done').write_bytes(b'done')
print(json.dumps(result),flush=True)
sys.stdin.read(1)
"""
   external=subprocess.Popen([sys.executable,'-c',program,str(archive)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:phase=observer.phase('configure',[binary,str(archive),mode,str(alias_source)],time.monotonic()+30,cwd=str(e2e.ROOT),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
  except Exception as exc:error=exc;traceback.print_exc()
  finally:
   observer.close()
   if external is not None:external_stdout,external_stderr=external.communicate('x',timeout=3)
   e2e._reap_all()
  external_result=None
  if external is not None:
   self.assertEqual(external.returncode,0,external_stderr);external_result=json.loads(external_stdout)
   if mode=='foreign':self.assertTrue(external_result['opened']);self.assertEqual(external_result['written'],1)
   else:self.assertFalse(external_result['opened']);self.assertEqual(external_result['errorCode'],11);self.assertEqual(external_result['written'],0)
   self.assertNotIn(external_result['pid'],observer.tasks)
  result=dict(case=label,enabled=enabled,phase=bool(phase),error=(type(error).__name__+': '+str(error)) if error else None,content=archive.read_bytes().hex())
  if external_result:result['externalWriter']=external_result
  if phase:
   self.wire_refs[label]={str(Path(ref['path'])):ref for ref in phase['rawTraceShards']}
   shards=[Path(ref['path']) for ref in phase['rawTraceShards']]
   try:
    self._replay(shards,originals,label=label);result['replay']='pass'
   except Exception as exc:result['replay']='fail';result['replayError']=type(exc).__name__+': '+str(exc);traceback.print_exc()
   _decoder,pairs=self._decode_rows(shards,label);rows=[row for _path,row in pairs];result['generationRows']=[dict(kind=row['kind'],sequence=row['sequence']) for row in rows if 'generation' in row['kind']]
   self.saved=(shards,originals,label)
  print('GENERATION_RESULT '+json.dumps(result,sort_keys=True),flush=True)
  return result
 def run_two_phases(self,source_alias=False):
  base=self.root/'cross-phase';base.mkdir();build=base/'build';build.mkdir();originals=base/'originals';originals.mkdir();source=base/'source';source.mkdir()
  binary=e2e.build(C,self.root/'bin','generation-cross-phase');archive=build/'libtest.a';alias_source=source/'original-input.a'
  if source_alias:alias_source.write_bytes(b'AAAAAAAA');os.link(alias_source,archive)
  observer=e2e.make_observer(originals,str(build.resolve()))
  for key in ('generated_vma_output','generated_vma_shared_mm','generated_vma_private_wake','generated_vma_private_wait_mismatch','generated_vma_coordinated_wait','generated_vma_parked_wait','retained_generated_metadata'):setattr(observer,key,False)
  observer.generated_vma=None;observer.source=str(source)
  observer.owned_input_generations=e2e.obs.owned_input_module.Runtime(observer,e2e.obs.SimpleNamespace(probe=e2e.obs.probe,bindings=e2e.obs.bindings,memory_policy=e2e.obs.memory_policy,profile=e2e.obs.profile,path_argument=e2e.obs.path_argument,descriptor_flags=e2e.obs.descriptor_flags))
  phases=[];error=None
  try:
   for name,mode in [('configure','source-read-only' if source_alias else 'create'),('compile','existing')]:
    try:phases.append((name,observer.phase(name,[binary,str(archive),mode,str(alias_source)],time.monotonic()+30,cwd=str(e2e.ROOT),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})))
    except AssertionError as exc:
     if not source_alias:raise
     error=exc;break
  finally:observer.close();e2e._reap_all()
  if source_alias:
   self.assertIsNotNone(error);self.assertIn('source/dependency inode',str(error));self.assertEqual([name for name,_ in phases],['configure']);self.assertEqual(archive.read_bytes(),b'!<arch>\n')
   print('GENERATION_CROSS_PHASE_SOURCE_REJECTED '+str(error),flush=True);return
  def logical(result):
   for reference in result['rawTraceShards']:
    with open(reference['path'],'rb') as raw:
     def blocks():
      while True:
       data=raw.read(65536)
       if not data:return
       yield data
     yield from e2e.rawwire.iter_shard_records(blocks(),reference,check=lambda:None,maximum_encoded=e2e.obs.load_sdk_execution_limits()['shardBytes'],maximum_logical=e2e.obs.load_sdk_execution_limits()['shardBytes'])
  def original(path,maximum):
   with (originals/path).open('rb') as raw:
    while True:
     data=raw.read(min(maximum,65536))
     if not data:return
     maximum-=len(data);yield data
  report=e2e.bindings.observe([(name,logical(result)) for name,result in phases],original,{},limits=e2e.obs.load_sdk_execution_limits(),generated_build_root=str(build))
  self.assertIsNotNone(report);self.assertEqual(archive.read_bytes(),b'B')
  print('GENERATION_CROSS_PHASE '+json.dumps(dict(phases=[name for name,_ in phases],producer='configure',mutation='compile',phase=True,replay='pass')),flush=True)
 def test_cross_phase(self):self.run_two_phases()
 def test_source_inode_protection_survives_phase_and_build_alias(self):self.run_two_phases(source_alias=True)
 def test_foreign_visible_write(self):
  result=self.run_case('foreign');self.assertFalse(result['phase']);self.assertIn('externalWriter',result);self.assertEqual(result['content'],'5a');self.assertNotIn('unregistered',result['error']);self.assertIn('unexplained',result['error'])
 def test_mapped_then_unmapped_stays_immutable(self):
  result=self.run_case('mmap-unmap');self.assertFalse(result['phase']);self.assertIn('mmap',result['error']);self.assertNotEqual(result['content'],'42')
 def test_source_inode_through_build_hardlink_stays_immutable(self):
  result=self.run_case('source-alias');self.assertFalse(result['phase']);self.assertIn('source/dependency inode',result['error']);self.assertNotEqual(result['content'],'42')
 def test_foreign_held_lease(self):
  result=self.run_case('foreign-held');self.assertFalse(result['phase']);self.assertIn('LeaseError',result['error']);self.assertIn('externalWriter',result)
 def test_peer_mapping(self):
  result=self.run_case('peer-map');self.assertFalse(result['phase']);self.assertIn('live mapping',result['error'])
 def test_truncate(self):
  result=self.run_case('truncate');self.assertTrue(result['phase']);self.assertEqual(result['replay'],'pass')
 def test_replay_mutations(self):
  result=self.run_case();self.assertEqual(result['replay'],'pass')
  shards,originals,label=self.saved
  _decoder,pairs=self._decode_rows(shards,label);retirement=next(row['sequence'] for _path,row in pairs if row['kind']=='owned-input-generation-retired')
  cases=[
   ('owned-root-binding',lambda r:{**r,'ownedInputGenerationModel':'forged-model'},'model'),
   ('owned-input-generation-retired',lambda r:{**r,'kind':'signal-delivery'},'missing-retirement'),
   ('owned-input-generation-retired',lambda r:{**r,'producerCaptureSequence':0},'producer'),
   ('owned-input-generation-retired',lambda r:{**r,'entrySequence':0},'entry'),
   ('owned-input-generation-retired',lambda r:{**r,'barrierSequence':0},'barrier'),
   ('owned-input-generation-retired',lambda r:{**r,'oldLeaseId':1},'lease'),
   ('owned-input-generation-retired',lambda r:{**r,'flags':r['flags']^os.O_TRUNC},'open-flags'),
   ('owned-input-generation-retired',lambda r:{**r,'maps':[]},'peer-maps'),
   ('owned-input-generation-retired',lambda r:{**r,'activeReads':[dict(pid=r['pid'],fd=3)]},'active-read'),
   ('owned-input-generation-peer',lambda r:{**r,'mapsSequence':0},'maps-original'),
   ('exclusive-owned-input-generation-resume',lambda r:{**r,'pid':r['pid']+1000},'writer'),
   ('owned-input-generation-opened',lambda r:{**r,'fd':r['fd']+1},'fd'),
   ('owned-input-generation-opened',lambda r:{**r,'exitSequence':0},'open-exit'),
   ('actual-write-transition',lambda r:{**r,'kind':'signal-delivery'} if r['sequence']>retirement else r,'write-ops'),
   ('owned-input-generation-acquired',lambda r:{**r,'entrySequence':0},'close'),
   ('owned-input-generation-acquired',lambda r:{**r,'afterIdentity':[r['afterIdentity'][0],r['afterIdentity'][1]+1,*r['afterIdentity'][2:]]},'inode'),
   ('owned-input-generation-acquired',lambda r:{**r,'leaseId':1},'token-reuse'),
   ('owned-input-generation-acquired',lambda r:{**r,'originalSequence':0},'postimage'),
   ('owned-input-generation-acquired',lambda r:{**r,'kind':'signal-delivery'},'missing-completion')]
  for kind,transform,tag in cases:
   with self.subTest(tag=tag):
    mutated,changed,newlabel=self._reencode_semantic(shards,label,kind,transform,'generation-'+tag)
    self.assertGreater(changed,0)
    with self.assertRaises((ValueError,AssertionError,KeyError)):self._replay(mutated,originals,label=newlabel)
    print('GENERATION_MUTATION_REJECTED '+tag,flush=True)
 def test_replay_truncate_mutations(self):
  result=self.run_case('truncate');self.assertEqual(result['replay'],'pass');shards,originals,label=self.saved
  cases=[
   ('owned-input-generation-truncate-window',lambda r:{**r,'kind':'signal-delivery'},'missing-window'),
   ('owned-input-generation-truncate-window',lambda r:{**r,'fd':r['fd']+1},'fd'),
   ('owned-input-generation-truncate-window',lambda r:{**r,'length':r['length']+1},'length'),
   ('exclusive-owned-input-truncate-resume',lambda r:{**r,'kind':'signal-delivery'},'missing-resume'),
   ('owned-input-generation-truncated',lambda r:{**r,'after':{**r['after'],'sha256':'0'*64}},'after-projection'),
   ('owned-input-generation-truncated',lambda r:{**r,'result':1},'actual-result'),
   ('owned-input-generation-acquired',lambda r:{**r,'lastWriteTransitionSequence':None},'final-chain')]
  for kind,transform,tag in cases:
   with self.subTest(tag=tag):
    mutated,changed,newlabel=self._reencode_semantic(shards,label,kind,transform,'generation-truncate-'+tag);self.assertGreater(changed,0)
    with self.assertRaises((ValueError,AssertionError,KeyError)):self._replay(mutated,originals,label=newlabel)
    print('GENERATION_TRUNCATE_MUTATION_REJECTED '+tag,flush=True)
 def test_ar(self):
  result=self.run_case('ar');self.assertTrue(result['phase']);self.assertEqual(result['replay'],'pass')
 def test_owned(self):
  result=self.run_case();self.assertTrue(result['phase']);self.assertEqual(result['replay'],'pass')
 def test_idle_read_fd(self):
  result=self.run_case('hold');self.assertTrue(result['phase']);self.assertEqual(result['replay'],'pass')
 def test_live_mapping(self):self.assertFalse(self.run_case('map')['phase'])
 def test_source(self):self.assertFalse(self.run_case(source=True)['phase'])
 def test_replaced_fd(self):self.assertFalse(self.run_case('swap')['phase'])
 def test_before(self):self.assertFalse(self.run_case(enabled=False)['phase'])

def load_tests(loader,standard,pattern):
 return unittest.TestSuite(Generation(name) for name in Generation.__dict__ if name.startswith('test_'))

if __name__=='__main__':
 unittest.main()
