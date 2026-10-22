#!/usr/bin/env python3
"""Own only the real service pack phase, not the complete image build."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
sys.dont_write_bytecode=True
import time

HERE=Path(__file__).resolve().parent
LIMITS=json.loads((HERE/'lib/module-artifact-limits.json').read_text())
META=LIMITS['metadataBytes']

binding_spec=importlib.util.spec_from_file_location('pack_parent_bindings',HERE.parent/'qlever/scripts/sdk-service-pack-bindings.py')
bindings=importlib.util.module_from_spec(binding_spec);binding_spec.loader.exec_module(bindings)
BUILD_COMMANDS=bindings.BUILD_COMMANDS
snapshot_spec=importlib.util.spec_from_file_location('service_build_originals',HERE/'service-build-observations.py')
snapshots=importlib.util.module_from_spec(snapshot_spec);snapshot_spec.loader.exec_module(snapshots)

def closed_receipt(receipt):
    return (type(receipt.get('exit')) is int and receipt['exit']==0 and receipt.get('actualWait') is True and receipt.get('ownedGroupAbsentAfterWait') is True and receipt.get('rawClosedBeforeHash') is True and all(key in receipt and receipt[key] is None for key in ('signal','resourceStop','supervisorError')) and isinstance(receipt.get('cleanupErrors'),list) and not receipt['cleanupErrors'])

def _run(source_sha,include_build=False,root_check=lambda:None,root_observation=None):
    if not re.fullmatch('[0-9a-f]{40}',source_sha):
        raise ValueError('exact candidate source SHA required')
    root=HERE.parent
    if Path.cwd().resolve()!=root:
        raise ValueError('service pack requires the canonical source working directory')
    spec=importlib.util.spec_from_file_location('service_pack_supervisor',HERE/'agentfs-native-ci/supervise.py')
    supervisor=importlib.util.module_from_spec(spec);spec.loader.exec_module(supervisor)
    duration=LIMITS['captureTimeoutMs']/1000
    monotonic_end=time.monotonic()+duration
    unix_end=int(time.time()*1000)+LIMITS['captureTimeoutMs']
    evidence=root/'.test-data/service-pack-phase'
    # Two metadata allocations belong to the actual parent raw and receipt.
    # This is a single upstream pack budget, independent of later collection.
    ceiling=32*META;worker_ceiling=ceiling-2*META
    if include_build:
        # The complete composition inherits one end and one retained allocation.
        # Before each child, both maximum stream/receipt allocations must fit.
        build_charged=0
        evidence.mkdir(parents=True,exist_ok=False)
        def check():
            root_check()
            if time.monotonic()>=monotonic_end:raise TimeoutError('same build/pack parent deadline exhausted')
        before=snapshots.snapshot(root,check)
        snapshots.write_snapshot(evidence/'build-inputs.before.json',before,check,META)
        build_charged=os.lstat(evidence/'build-inputs.before.json').st_size
        for stage,argv in BUILD_COMMANDS:
            check()
            if build_charged+3*META>=ceiling:raise ValueError('same parent build evidence budget exhausted')
            receipt,_=supervisor.run_stage(stage,list(argv),evidence,root,timeout=max(0,monotonic_end-time.monotonic()),absolute_deadline=monotonic_end,raw_limit_bytes=META,receipt_limit_bytes=META,stop_bytes=LIMITS['freeFloorBytes'])
            root_check()
            if not closed_receipt(receipt):raise RuntimeError('actual service build did not close successfully: '+stage)
            build_charged=0
            for file in evidence.iterdir():
                value=os.lstat(file)
                if not stat.S_ISREG(value.st_mode) or value.st_nlink!=1 or value.st_size>ceiling-build_charged:raise ValueError('same parent build evidence inventory')
                build_charged+=value.st_size
        # Both snapshots are additional physical originals, reserved before IO.
        if build_charged+5*META>=ceiling:raise ValueError('same parent post-build original allocation exhausted')
        after=snapshots.snapshot(root,check,paths=[row[0] for row in before['rows']])
        snapshots.write_snapshot(evidence/'build-inputs.after.json',after,check,META)
        outputs=snapshots.snapshot(root,check,generated=True)
        snapshots.write_snapshot(evidence/'build-outputs.after.json',outputs,check,META)
        build_charged=sum(os.lstat(file).st_size for file in evidence.iterdir())
        # Also reserve the final index, pack raw, and pack receipt before pack.
        worker_ceiling=ceiling-build_charged-3*META
        if worker_ceiling<=2*META:raise ValueError('same parent pack allocation exhausted by build evidence')
    root_check()
    if time.monotonic()>=monotonic_end:raise TimeoutError('same parent end exhausted before pack')
    command=['node',str(HERE/'run-npm-pack.cjs'),'.test-data/service-pack','.test-data/service-pack-cache','service','--retain-service-originals',source_sha,str(unix_end),str(worker_ceiling)]
    receipt,_=supervisor.run_stage('pack',command,evidence,root,timeout=duration,absolute_deadline=monotonic_end,raw_limit_bytes=META,receipt_limit_bytes=META,stop_bytes=LIMITS['freeFloorBytes'])
    if receipt['exit']!=0 or receipt['signal'] is not None or receipt['resourceStop'] or not receipt['actualWait'] or not receipt['ownedGroupAbsentAfterWait'] or not receipt['rawClosedBeforeHash']:
        raise RuntimeError('actual service pack did not close successfully; retained original pack receipt required')
    rows=[];charged=0
    for directory in [root/'.test-data/service-pack-originals',root/'.test-data/service-pack-bodies',evidence]:
        for current,dirs,names in os.walk(directory,followlinks=False):
            for name in dirs:
                if not stat.S_ISDIR(os.lstat(Path(current)/name).st_mode):raise ValueError('pack evidence directory link refused')
            for name in sorted(names):
                if time.monotonic()>=monotonic_end:raise TimeoutError('same pack parent end exhausted')
                file=Path(current)/name;value=os.lstat(file)
                if not stat.S_ISREG(value.st_mode) or value.st_size>ceiling-charged:raise ValueError('pack retained shared byte bound')
                charged+=value.st_size
                digest,_=supervisor.bounded_closed_raw(file,value.st_size,monotonic_end)
                rows.append({'path':file.relative_to(root/'.test-data').as_posix(),'bytes':value.st_size,'sha256':digest})
    record={'schemaVersion':1,'kind':'actual-service-pack-parent-originals','sourceSha':source_sha,'deadlineUnixMs':unix_end,'retainedCeilingBytes':ceiling,'chargedOriginalBytes':charged,'originals':rows,'scope':'this build and pack invocation only; not subsequent collector' if include_build else 'this pack invocation only; not whole build or subsequent collector','authorityVerified':False}
    if include_build:record.update(parentModel=bindings.BUILD_PARENT_MODEL,buildChargedOriginalBytes=build_charged,workerRetainedCeilingBytes=worker_ceiling,workingDirectory=root_observation())
    data=(json.dumps(record,indent=2)+'\n').encode()
    if len(data)>META or charged+len(data)>ceiling:raise ValueError('pack parent final original budget exhausted')
    if time.monotonic()>=monotonic_end:raise TimeoutError('pack parent end exhausted before sealing')
    with open(evidence/'materials.json','xb') as output:
        output.write(data);output.flush();os.fsync(output.fileno())
    return record

def run(source_sha,include_build=False):
    if not include_build:return _run(source_sha)
    root=HERE.parent
    if not re.fullmatch('[0-9a-f]{40}',source_sha):raise ValueError('exact candidate source SHA required')
    if root.resolve(strict=True)!=root or Path.cwd().resolve()!=root:raise ValueError('service build requires canonical actual working directory')
    prior=os.lstat(root)
    if not stat.S_ISDIR(prior.st_mode):raise ValueError('actual build source directory required')
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC);primary=None
    first=None
    def check():
        actual=os.lstat(root);held=os.fstat(fd)
        if root.resolve(strict=True)!=root or Path.cwd().resolve()!=root or snapshots.identity(actual)!=snapshots.identity(held) or snapshots.identity(held)[:3]!=first[:3]:raise ValueError('same held actual build working directory changed')
    def observation():
        check();return dict(path=str(root),canonicalPath=str(root),identity=first,completedIdentity=snapshots.identity(os.fstat(fd)))
    try:
        first=snapshots.identity(os.fstat(fd))
        if first!=snapshots.identity(prior):raise ValueError('build directory changed before open')
        check();return _run(source_sha,True,check,observation)
    except BaseException as failure:primary=failure;raise
    finally:
        try:os.close(fd)
        except BaseException:
            if primary is None:raise

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source-sha',required=True);parser.add_argument('--include-build',action='store_true')
    args=parser.parse_args();run(args.source_sha,args.include_build)
