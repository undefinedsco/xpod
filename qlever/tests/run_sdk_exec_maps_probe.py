"""Queued single-backend exec/VMA/FD observation; never SDK/source authority."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('maps_probe_cleanup',ROOT/'qlever/tests/run_sdk_prepared_input_probe.py');shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
LIMITS=dict(sourceMaterialBytes=256*1024**2,shardBytes=64*1024**2)
CODE=r'''
import ctypes,os,platform,sys,json
lib=ctypes.CDLL(None,use_errno=True);lib.mmap.restype=ctypes.c_void_p;lib.mmap.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_long];lib.mprotect.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int]
fd=os.open(sys.argv[1],os.O_RDONLY);address=lib.mmap(None,4096,1,2,fd,0);assert address not in [None,ctypes.c_void_p(-1).value];assert lib.mprotect(address,4096,5)==0
nr={'x86_64':329,'aarch64':288}[platform.machine()];lib.syscall.restype=ctypes.c_long;pkey=lib.syscall(ctypes.c_long(nr),ctypes.c_void_p(address),ctypes.c_size_t(4096),ctypes.c_int(5),ctypes.c_int(-1));pkey_errno=ctypes.get_errno() if pkey else 0
# A valid file FD does not change MAP_ANONYMOUS into a file-backed mapping.
anonymous=lib.mmap(None,4096,3,2|32,fd,0);assert anonymous not in [None,ctypes.c_void_p(-1).value];assert lib.mprotect(anonymous,4096,7)==0
print(json.dumps(dict(pkeyActualReturn=pkey,pkeyActualErrno=pkey_errno,mappedBytes=ctypes.string_at(address,36).hex(),scope='no mapped payload executed')));os.close(fd)
'''
def run(destination):
    out=Path(destination);out.mkdir(parents=True,exist_ok=False);originals=out/'originals';originals.mkdir();build=out/'build';build.mkdir();source=ROOT/'qlever/tests/fixtures/sdk-tool-mapping';fixture=source/'input.original'
    mounts=Path('/proc/self/mountinfo').read_bytes();shared.backend.probe.effective_readonly(source,mounts);shared.backend.probe.effective_readonly('/usr/bin/python3',mounts);(out/'mountinfo.original.raw').write_bytes(mounts)
    observer=shared.backend.Observer(originals,source,build,deadline_monotonic=time.monotonic()+120,maximum_bytes=LIMITS['sourceMaterialBytes'],maximum_file_bytes=LIMITS['shardBytes'],selected_names=None,capture_toolchain=True,shared_tasks=True)
    result={}
    try:
        phase=observer.phase('configure',['/usr/bin/python3','-c',CODE,str(fixture)],cwd=str(source),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
        def reader(name,maximum):
            with (originals/name).open('rb') as stream:
                count=0
                while True:
                    block=stream.read(65536)
                    if not block:break
                    count+=len(block);assert count<=maximum;yield block
        report=shared.backend.bindings.observe([('configure',(line for path in sorted(originals.glob('configure*jsonl')) for line in path.open('rb')))],reader,{},limits=LIMITS)
        result=dict(actualPhase=phase,report=report,sourceOriginal=dict(bytes=fixture.stat().st_size,sha256=hashlib.sha256(fixture.read_bytes()).hexdigest()),overallSdkSourceVerified=False)
        raw_files={row['sequence']:row for path in sorted(originals.glob('configure*jsonl')) for row in (json.loads(line) for line in path.open('rb')) if row['kind']=='toolchain-original' and row.get('captureKind')=='file'}
        assert len(raw_files)==len(phase['observedToolFiles']) and raw_files,'complete samephase tool descriptor set required'
        for descriptor in phase['observedToolFiles']:
            raw=raw_files[descriptor['captureSequence']]
            assert descriptor['actualOriginalPath']==raw['observedPath'] and descriptor['identity']==raw['identity'] and descriptor['actualMode']==raw['identity'][2] and descriptor['phase']==raw['phase']=='configure'
            assert descriptor['sourceKind']=='actual-tool-file-fd-snapshot' and descriptor['role']=='observed-tool-file' and descriptor['rawEventKind']=='toolchain-original'
            assert {**descriptor['original'],'path':Path(descriptor['original']['path']).name}==raw['original']
        assert report['toolchainActualExecImages']>=1 and report['toolchainFileSnapshots'] and report['toolchainSourceClosureVerified'] is False
        assert 'anonymous-or-JIT-mapping-source-unresolved' in report['toolchainPending']
    except BaseException as error:result.update(errorType=type(error).__name__,error=str(error));raise
    finally:
        (out/'before-cleanup.observation.json').write_text(json.dumps(result,indent=2)+'\n');result['cleanup']=shared.close_actual(observer,out/'cleanup.actual.jsonl');(out/'observation.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':run(sys.argv[1])
