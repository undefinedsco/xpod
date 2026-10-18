"""One normal build route shared by isolated Linux validation and SDK caller.

No registry push, tag, release or capability issuer. The loaded linked image and
outside originals are inputs for the existing SDK publisher's later reviewed
collection role. Old sourcePrepared/build/linked RUN recipes remain unchanged.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
outer=load('sdk-readonly-executor');result_context=load('sdk-readonly-result-context');binding=outer.binding

# This is the existing runtime assembly contract, with its compiled build and
# originals coming from stopped output volumes rather than an omitted commit.
def linked_dockerfile(prepared):
    binding.need(binding.digest(prepared),'immutable actual prepared image config')
    return ('FROM '+prepared+' AS build\nCOPY build/ /opt/qlever-sdk/build/\nCOPY materials/ /opt/qlever-sdk/materials/\n'
        'FROM build AS linked-verification\nARG XPOD_QLEVER_SDK_DEADLINE_UNIX\nARG XPOD_QLEVER_SDK_IDENTITY\n'
        'RUN XPOD_QLEVER_SDK_DEADLINE_UNIX="${XPOD_QLEVER_SDK_DEADLINE_UNIX}" XPOD_QLEVER_SDK_IDENTITY="${XPOD_QLEVER_SDK_IDENTITY}" exec python3 /components/qlever/scripts/sdk-owned-runs.py linked\n'
        'FROM build AS runtime\nCOPY --from=linked-verification /opt/qlever-sdk/materials/linked-inner.json /opt/qlever-sdk/materials/owner-linked.guard.json /opt/qlever-sdk/materials/\n'
        'COPY --from=linked-verification /opt/qlever-sdk/materials/stages/test-adapter /opt/qlever-sdk/materials/stages/test-adapter\n'
        'COPY --from=linked-verification /opt/qlever-sdk/materials/stages/test-runtime /opt/qlever-sdk/materials/stages/test-runtime\n'
        'COPY --from=linked-verification /opt/qlever-sdk/materials/stages/test-adapter.raw.log /opt/qlever-sdk/materials/stages/test-adapter.receipt.json /opt/qlever-sdk/materials/stages/test-runtime.raw.log /opt/qlever-sdk/materials/stages/test-runtime.receipt.json /opt/qlever-sdk/materials/stages/\n')

prepared_argv=binding.prepared_argv

def run(identity,deadline,out,context_originals):
    binding.same_tuple(identity,identity);budget=outer.budgets.ExecutionBudget(deadline);check=lambda:budget.check(60)
    binding.need(outer.platform.system()=='Linux' and os.geteuid()==0,'normal outer route requires actual Linux host root')
    out=Path(out).resolve();binding.need(not out.exists() and out.parent.resolve()==Path(os.environ['RUNNER_TEMP']).resolve() and out.name=='qlever-sdk-outer','fixed host-only output root parent');out.mkdir(mode=0o700)
    stages=[];builder=binding.ownership(identity)+'-builder';platform={'linux-x64':'linux/amd64','linux-arm64':'linux/arm64'}[identity['target']]
    daemon=None
    def stage(name,argv,cap=30,reserve=60):
        record=outer.commands.capture(name,argv,out,Path.cwd(),timeout=budget.timeout(cap,reserve),resource_profile='build' if cap>120 else 'observation');stages.append(record);return outer.bounded_original(out/record['stdout']['path'],binding.META,check)
    def metadata(path):return json.loads(outer.bounded_original(path,binding.META,check))
    def save(name,value,reserve=60):
        budget.check(reserve);data=(json.dumps(value,sort_keys=True)+'\n').encode();binding.need(len(data)<=binding.META,'bounded normal route metadata');path=out/name
        with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
        return dict(path=name,bytes=len(data),sha256=outer.hashlib.sha256(data).hexdigest())
    prepared=None;linked=None;created_builder=False
    try:
        daemon=outer.LocalDaemon(check,lambda value:save('daemon-peer-diagnostic.original.json',value),out/'daemon-activation',lambda:budget.timeout(5,60))
        # A fresh GitHub-hosted job has no services or other candidate writer.
        # Foreign active containers cause refusal; never stop another job.
        binding.need(not stage('require-exclusive-daemon',binding.local_docker(['docker','ps','-q'])).strip(),'exclusive runner daemon required')
        context=metadata(context_originals);binding.need(context['sourceSha']==identity['sourceSha'],'same actual prepared source context')
        names=stage('require-fresh-builder',binding.local_docker(['docker','buildx','ls','--format','{{json .Name}}'])).decode().splitlines();binding.need(builder not in [json.loads(name) for name in names],'owned builder name already exists')
        created_builder=True
        stage('create-owned-builder',binding.local_docker(['docker','buildx','create','--name',builder,'--driver','docker-container','--bootstrap']),120)
        build_metadata=out/'prepared-buildkit.original.json';stage('prepare-source-image',prepared_argv(builder,platform,identity,deadline,build_metadata),19800,1200);prepared=metadata(build_metadata)['containerimage.config.digest'];binding.need(binding.digest(prepared),'actual BuildKit prepared config')
        before=daemon.sample(check);record=outer.execute(prepared,identity,deadline,out/'readonly-executor');cid=json.loads(outer.bounded_original(out/'readonly-executor'/record['originals']['containerAfter']['path'],binding.META,check))['Id']
        # State was already independently closed by execute; recheck immediately
        # before export and reject any other container mounting either output.
        binding.need(json.loads(stage('require-stopped-before-export',binding.local_docker(['docker','inspect','--format','{{json .State.Running}}',cid]))) is False,'export only actual stopped owner')
        users=json.loads(stage('output-volume-users',binding.local_docker(['docker','inspect','--format','{{json .Mounts}}',cid])))
        binding.need({row['Name'] for row in users if row.get('Type')=='volume'}==set(record['volumes'].values()),'same exact owned output volumes')
        for index,volume in enumerate(record['volumes'].values()):
            active=stage('reject-output-volume-writer-'+str(index),binding.local_docker(['docker','ps','-q','--filter','volume='+volume])).decode().splitlines();binding.need(not active,'foreign active output volume writer')
        context_path=Path(os.environ['RUNNER_TEMP']).resolve()/'qlever-sdk-build-work';plan=dict(containerId=cid,context=str(context_path),deadlineUnix=deadline,dockerfile=linked_dockerfile(prepared),remainingRetainedBytes=remaining_ledger(out,context_originals,check))
        save('export.plan.json',plan);stage('export-stopped-outputs',['/usr/bin/python3','-I','-S','-B',str(HERE/'sdk-readonly-result-context.py'),'export','--plan',str(out/'export.plan.json')],600)
        exported=metadata(context_path/'result-context.json');plan.update(export=exported,builder=builder,platform=platform,metadata=str(out/'linked-buildkit.original.json'),identity=identity)
        save('linked.plan.json',plan);stage('compose-linked-image',['/usr/bin/python3','-I','-S','-B',str(HERE/'sdk-readonly-result-context.py'),'build','--plan',str(out/'linked.plan.json')],1200)
        linked=metadata(out/'linked-buildkit.original.json')['containerimage.config.digest'];binding.need(binding.digest(linked),'actual linked image config');after=daemon.sample(check);binding.need(before==after,'same held daemon throughout normal route');activation_originals=daemon.seal_originals()
    finally:
        if daemon is not None:daemon.close()
        if created_builder:
            primary=sys.exc_info()[1]
            try:
                cleanup=dict(builder=builder,deadlineUnix=deadline,originals=str(out));save('cleanup.plan.json',cleanup,0)
                outer.commands.capture('remove-owned-builder',['/usr/bin/python3','-I','-S','-B',str(HERE/'sdk-readonly-result-context.py'),'remove-builder','--plan',str(out/'cleanup.plan.json')],out,Path.cwd(),timeout=budget.timeout(30),resource_profile='cleanup')
            except BaseException as cleanup_error:
                if primary is None:raise
                if hasattr(primary,'add_note'):primary.add_note('Owned builder cleanup failed: '+type(cleanup_error).__name__)
                # Preserve the original stage exception and its closed raw. No
                # success record is sealed when cleanup could not complete.
    final=dict(schemaVersion=1,kind='qlever-readonly-normal-route-originals',identity=identity,deadlineUnix=deadline,sourcePreparedConfig=prepared,linkedImageConfig=linked,stages=stages,readonlyExecutor=outer.rooted_collection(record),resultContext=exported,resultContextDomain='temporary-runtime-build-work-not-source-artifact',daemonActivationOriginals=activation_originals,releaseAccepted=False,pending=['qlever-sdk-readonly-normal-route-registry-and-master-origin-not-yet-registered','qlever-sdk-source-and-lifetime-admission-unverified'])
    save('normal-route.original.json',final);return final

def remaining_ledger(out,context_originals,check):
    total=0
    for root in [Path(out),Path(context_originals).parent]:
        for path in root.rglob('*'):
            check();binding.need(not path.is_symlink(),'no symlink in controller retained ledger')
            if path.is_file():total+=path.stat().st_size
    remaining=result_context.LIMITS['sourceMaterialBytes']-total-3*2*binding.META-16*binding.META
    binding.need(remaining>0,'same total retained source budget exhausted');return remaining

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--identity',required=True);parser.add_argument('--deadline',required=True,type=float);parser.add_argument('--out',required=True);parser.add_argument('--context-originals',required=True);a=parser.parse_args();run(json.loads(a.identity),a.deadline,a.out,a.context_originals)
