#!/usr/bin/env python3
"""Own only the real service pack phase, not the complete image build."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time

HERE=Path(__file__).resolve().parent
LIMITS=json.loads((HERE/'lib/module-artifact-limits.json').read_text())
META=LIMITS['metadataBytes']

def run(source_sha):
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
    record={'schemaVersion':1,'kind':'actual-service-pack-parent-originals','sourceSha':source_sha,'deadlineUnixMs':unix_end,'retainedCeilingBytes':ceiling,'chargedOriginalBytes':charged,'originals':rows,'scope':'this pack invocation only; not whole build or subsequent collector','authorityVerified':False}
    data=(json.dumps(record,indent=2)+'\n').encode()
    if len(data)>META or charged+len(data)>ceiling:raise ValueError('pack parent final original budget exhausted')
    if time.monotonic()>=monotonic_end:raise TimeoutError('pack parent end exhausted before sealing')
    with open(evidence/'materials.json','xb') as output:
        output.write(data);output.flush();os.fsync(output.fileno())
    return record

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source-sha',required=True)
    run(parser.parse_args().source_sha)
