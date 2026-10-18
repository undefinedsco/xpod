"""Pure outside-RUN Docker/provider mechanics. No JSON issuer or host-root claim."""
import hashlib
import json
import re
MODEL='controller-owned-daemon-readonly-image-v1'
WRITABLE={'/opt/qlever-sdk/build','/opt/qlever-sdk/materials'}
META=4*1024**2

def need(value,why):
    if not value:raise ValueError('readonly SDK executor: '+why)
def digest(value):return isinstance(value,str) and re.fullmatch(r'sha256:[a-f0-9]{64}',value) is not None
def identity(value):
    need(isinstance(value,list) and len(value)==6 and all(type(v) is int and 0<=v<1<<64 for v in value),'full actual identity');return value
def same_tuple(value,expected):
    need(value==expected and isinstance(value,dict),'exact source/job/target tuple')
    need(re.fullmatch('[a-f0-9]{40}',value.get('sourceSha','')) and type(value.get('runId')) is int and value['runId']>0 and type(value.get('runAttempt')) is int and value['runAttempt']>0 and value.get('target') in ['linux-x64','linux-arm64'] and value.get('sdkProfile')=='module-bookworm-gcc12','supported SDK source tuple')
IMAGE_TEMPLATE='{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RootFS":{{json .RootFS}},"Volumes":{{json .Config.Volumes}},"OnBuild":{{json .Config.OnBuild}}}'
CONTAINER_TEMPLATE='{"Id":{{json .Id}},"Image":{{json .Image}},"Path":{{json .Path}},"Args":{{json .Args}},"HostConfig":{"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"Privileged":{{json .HostConfig.Privileged}},"CapAdd":{{json .HostConfig.CapAdd}},"CapDrop":{{json .HostConfig.CapDrop}},"PidMode":{{json .HostConfig.PidMode}},"IpcMode":{{json .HostConfig.IpcMode}},"CgroupnsMode":{{json .HostConfig.CgroupnsMode}},"VolumesFrom":{{json .HostConfig.VolumesFrom}},"Binds":{{json .HostConfig.Binds}},"Devices":{{json .HostConfig.Devices}},"DeviceRequests":{{json .HostConfig.DeviceRequests}},"SecurityOpt":{{json .HostConfig.SecurityOpt}},"RestartPolicy":{{json .HostConfig.RestartPolicy}},"Tmpfs":{{json .HostConfig.Tmpfs}},"NetworkMode":{{json .HostConfig.NetworkMode}}},"Mounts":{{json .Mounts}},"Healthcheck":{{json .Config.Healthcheck}},"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}}}'

def local_docker(command):
    need(command and command[0]=='docker' and '--host' not in command and '--context' not in command,'fixed local Docker endpoint only')
    return ['docker','--host','unix:///var/run/docker.sock',*command[1:]]

def ownership(identity):
    same_tuple(identity,identity)
    key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()[:24]
    return 'xpod-sdk-ro-'+key

def prepared_argv(builder,platform,identity,deadline,metadata):
    same_tuple(identity,identity);need(re.fullmatch('[A-Za-z0-9_-]{1,100}',builder) is not None,'owned builder name')
    need(platform=={'linux-x64':'linux/amd64','linux-arm64':'linux/arm64'}[identity['target']],'native target/platform exact pair')
    return local_docker(['docker','buildx','build','--builder',builder,'--file','docker/qlever-runtime-sdk/Dockerfile.module-bookworm','--target','source-prepared','--platform',platform,'--progress','rawjson','--load','--no-cache-filter','source-prepared','--metadata-file',str(metadata),'--build-arg','XPOD_QLEVER_BUILD_JOBS=2','--build-arg','XPOD_QLEVER_SDK_DEADLINE_UNIX='+str(deadline),'--build-arg','XPOD_QLEVER_SDK_IDENTITY='+json.dumps(identity,sort_keys=True,separators=(',',':')),'.'])

def create_argv(image,identity,deadline,network,nonce):
    need(digest(image) and network in ['none','bridge'] and re.fullmatch('[a-f0-9]{64}',nonce) is not None,'fixed config image/network/nonce')
    name=ownership(identity);volumes={destination:name+'-'+role for destination,role in [('/opt/qlever-sdk/build','build'),('/opt/qlever-sdk/materials','materials')]}
    argv=['docker','create','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--no-healthcheck','--restart','no','--ipc','private','--cgroupns','private','--network',network,'--cpus','4','--memory','4g','--pids-limit','256','--tmpfs','/tmp:rw,nosuid,nodev,size=1073741824']
    for destination,volume in volumes.items():argv+=['--mount','type=volume,src='+volume+',dst='+destination]
    argv+=['--env','XPOD_QLEVER_SDK_IDENTITY='+json.dumps(identity,sort_keys=True,separators=(',',':')),'--env','XPOD_QLEVER_SDK_DEADLINE_UNIX='+str(deadline),'--env','XPOD_QLEVER_EXECUTOR_NONCE='+nonce,'--env','XPOD_QLEVER_BUILD_JOBS=2','--entrypoint','/usr/bin/python3',image,'-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py']
    return argv,volumes

def verify_container(value,image,volumes):
    need(value['Image']==image and digest(image),'actual prepared config image differs')
    need(re.fullmatch('[a-f0-9]{64}',value['Id']) is not None,'actual container ID')
    h=value['HostConfig'];need(h['ReadonlyRootfs'] is True and h['Privileged'] is False and h['CapAdd'] in [None,[]] and h['CapDrop']==['ALL'],'readonly capless actual container required')
    need(h['PidMode']=='' and h['IpcMode']=='private' and h['CgroupnsMode']=='private' and h['VolumesFrom'] in [None,[]] and h['Binds'] in [None,[]] and h['Devices'] in [None,[]] and h['DeviceRequests'] in [None,[]],'foreign host/namespace/socket/device sharing')
    need(h['SecurityOpt']==['no-new-privileges'] and h['RestartPolicy']['Name']=='no' and value['Healthcheck']['Test']==['NONE'],'uncontrolled extra process/privilege policy')
    mounts=value['Mounts'];need(len(mounts)==2 and {m['Destination'] for m in mounts}==WRITABLE,'exact writable output mount universe')
    for m in mounts:need(m['Type']=='volume' and m['Name']==volumes[m['Destination']] and m['RW'] is True and m.get('Propagation','') in ['', 'rprivate'],'unexpected provider or propagation')
    need(h['Tmpfs']=={'/tmp':'rw,nosuid,nodev,size=1073741824'} and h['NetworkMode'] in ['none','bridge'],'exact temporary/network contract')
    need(value['Path']=='/usr/bin/python3' and value['Args']==['-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py'],'fixed PID1 entrypoint')
    return value['Id']
def verify_stages(record,originals,image,cid):
    def read(ref):
        need(isinstance(ref,dict) and type(ref.get('bytes')) is int and 0<=ref['bytes']<=META,'bounded supervised stage original')
        raw=originals[ref['path']];need(len(raw)==ref['bytes'] and hashlib.sha256(raw).hexdigest()==ref['sha256'],'supervised original bytes changed');return raw
    output=record['outputRoot'];need(isinstance(output,str) and output.startswith('/') and not any(v in ['.','..',''] for v in output.split('/')[1:]),'canonical controller output path')
    create,volumes=create_argv(image,record['identity'],record['deadlineUnix'],record['network'],record['nonce'])
    expected=[('image',['docker','image','inspect','--format',IMAGE_TEMPLATE,image]),('existing-volumes',['docker','volume','ls','--format','{{.Name}}'])]
    expected += [('create-volume-'+role,['docker','volume','create',volume]) for role,volume in zip(['build','materials'],volumes.values())]
    expected += [('create-executor',create),('start-executor',['docker','start',cid]),('container-before',['docker','container','inspect','--format',CONTAINER_TEMPLATE,cid]),('root-diff-before',['docker','diff',cid]),('copy-prepared',['docker','cp',cid+':/opt/qlever-sdk/materials/source-prepared.json',output+'/source-prepared.copied.json']),('release-executor',['docker','cp',output+'/release.original',cid+':/opt/qlever-sdk/materials/readonly-executor.release']),('wait-executor',['docker','wait',cid]),('executor-logs',['docker','logs',cid]),('container-after',['docker','container','inspect','--format',CONTAINER_TEMPLATE,cid]),('root-diff-after',['docker','diff',cid]),('stop-executor',['docker','stop','--time','10',cid]),('confirm-stopped',['docker','container','inspect','--format','{{json .State.Running}}',cid])]
    stages=record['stages'];need(len(stages)==len(expected),'complete fixed outer command universe');outputs={};completed=0
    for stage,(name,command) in zip(stages,expected):
        need(stage['name']==name,'outer stages omitted/reordered');actual=json.loads(read(stage['receipt']));supervisor=json.loads(read(stage['supervisionReceipt']));read(stage['supervisionRaw'])
        need(actual['command']==local_docker(command) and actual['exit']==0 and actual['signal'] is None and actual['actualWait'] is True and actual['rawClosedBeforeHash'] is True,'actual fixed command/wait differs')
        need(supervisor['exit']==0 and supervisor['signal'] is None and not supervisor.get('resourceStop') and not supervisor.get('supervisorError') and not supervisor.get('cleanupErrors') and supervisor['actualWait'] is True and supervisor['rawClosedBeforeHash'] is True and supervisor['ownedGroupAbsentAfterWait'] is True and actual['pgid']==supervisor['pgid'],'outer supervisor wait/closure differs')
        need(type(actual['startedUnixNs']) is int and type(actual['completedUnixNs']) is int and completed<=actual['startedUnixNs']<=actual['completedUnixNs']<=int(record['deadlineUnix']*1e9),'one actual outer execution deadline/order');completed=actual['completedUnixNs']
        prefix=stage['receipt']['path'].rsplit('/',1)[0]+'/'
        for field in ['stdout','stderr']:
            need(stage[field]==dict(actual[field],path=prefix+actual[field]['path']),'same closed actual raw reference');data=read(stage[field])
            if field=='stdout':outputs[name]=data
    need(outputs['create-executor'].decode().strip()==cid and outputs['start-executor'].decode().strip()==cid and outputs['wait-executor'].decode().strip()=='0','created/started/actualwait originals differ')
    need(json.loads(outputs['confirm-stopped']) is False,'actual cleanup container remains live')
    need(not outputs['root-diff-before'].strip() and not outputs['root-diff-after'].strip(),'actual readonly root modified')
    for role in ['image','containerBefore','containerAfter']:
        label=re.sub(r'([A-Z])',lambda m:'-'+m[1].lower(),role)
        need(json.loads(outputs[label])==json.loads(read(record['originals'][role])),'outer copied metadata differs from actual Docker stdout')
    return outputs

def verify(record,originals,expected):
    need(record.get('schemaVersion')==1 and record.get('model')==MODEL,'explicit outer executor schema')
    same_tuple(record['identity'],expected)
    def read(role):
        ref=record['originals'][role];need(set(ref)=={'path','bytes','sha256'} and 0<=ref['bytes']<=META,'bounded original role')
        data=originals[ref['path']];need(len(data)==ref['bytes'] and hashlib.sha256(data).hexdigest()==ref['sha256'],'actual outer original differs');return json.loads(data)
    image=read('image');need(image['Id']==record['preparedImageConfig'] and digest(image['Id']) and image['Os']=='linux' and image['Architecture']==('amd64' if expected['target']=='linux-x64' else 'arm64'),'prepared image actual platform/config')
    need(image['Volumes'] in [None,{}] and image['OnBuild'] in [None,[]] and image['RootFS']['Type']=='layers' and image['RootFS']['Layers'] and all(digest(v) for v in image['RootFS']['Layers']),'immutable image layer/input contract')
    daemon=read('daemonBefore');need(daemon==read('daemonAfter') and daemon['uid']==0 and daemon['pid']>0 and daemon['socket']=='unix:///var/run/docker.sock' and daemon['executablePath']=='/usr/bin/dockerd' and re.fullmatch('[a-f0-9]{64}',daemon['executableSha256']) and daemon['controllerPidNamespace']==daemon['daemonPidNamespace']==daemon['hostPidNamespace'] and daemon['controllerRootIdentity']==daemon['daemonRootIdentity'],'same actual local host/root Docker daemon required')
    if daemon.get('associationModel') is not None:
        need(daemon['associationModel']=='systemd-listener-v1','unknown actual daemon association model')
        import importlib.util
        from pathlib import Path
        spec=importlib.util.spec_from_file_location('activation_receiver',Path(__file__).with_name('sdk-local-daemon-originals.py'));activation=importlib.util.module_from_spec(spec);spec.loader.exec_module(activation)
        collection=read('daemonActivation');prefix=record['originals']['daemonActivation']['path'].rsplit('/',1)[0]+'/'
        registered={ref['path']:ref for ref in record['originals'].values()}
        def activated_original(ref):
            rooted=dict(ref,path=prefix+ref['path']);need(registered.get(rooted['path'])==rooted,'actual activation raw is not same registered executor original');return originals[rooted['path']]
        proof=activation.verify_collection(collection,activated_original)
        for field,left in [('mainPid','pid'),('daemonExecutableIdentity','executableIdentity'),('daemonExecutableSha256','executableSha256'),('controllerPidNamespace','controllerPidNamespace'),('daemonPidNamespace','daemonPidNamespace'),('hostPidNamespace','hostPidNamespace'),('controllerRootIdentity','controllerRootIdentity'),('daemonRootIdentity','daemonRootIdentity'),('listenerIdentity','listenerIdentity'),('service','activationService')]:need(proof[field]==daemon[left],'same held actual activated daemon cross-seal')
        stage_by_name={row['name']:row for row in record['stages']}
        created=json.loads(originals[stage_by_name['create-executor']['receipt']['path']]);waited=json.loads(originals[stage_by_name['wait-executor']['receipt']['path']])
        need(proof['serviceWindows'][0]['completedUnixNs']<=created['startedUnixNs'] and proof['serviceWindows'][-1]['startedUnixNs']>=waited['completedUnixNs'],'actual daemon association must enclose complete owned executor interval')
    before=read('containerBefore');after=read('containerAfter');cid=verify_container(before,image['Id'],record['volumes']);need(verify_container(after,image['Id'],record['volumes'])==cid,'container swapped')
    need(before['State']['Running'] is True and before['State']['Pid']>0 and after['State']['Running'] is False and after['State']['ExitCode']==0 and after['State']['OOMKilled'] is False,'actual container start/zero terminal wait')
    wait=read('wait');need(wait=={'containerId':cid,'exitCode':0,'actualDockerWait':True},'actual wait result')
    prepared=read('sourcePrepared');need(read('sourcePreparedCopied')==prepared,'actual cp original differs from semantic prepared metadata');same_tuple(prepared['identity'],expected)
    need(prepared['deadlineUnix']==record['deadlineUnix'],'one prepared/build deadline')
    host=read('hostBefore');need(host['containerPid']==before['State']['Pid'] and host['rootPidStarttime'].isdigit() and host['namespacePids']==[host['containerPid'],1] and host['ready']==dict(pid=1,nonce=record['nonce'],identity=expected,deadlineUnix=record['deadlineUnix']) and host['command']==['/usr/bin/python3','-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py'],'actual daemon PID1/starttime/release handshake')
    host_after=read('hostBeforeRelease');need(host_after==host,'held provider/task identity changed before release')
    for role in ['mnt','pid','user']:
        row=host['namespaces'][role];identity(row['identity']);need(re.fullmatch(role+r':\[([0-9]+)\]',row['link']) is not None,'actual host namespace role');need(int(row['link'].split('[')[1][:-1])==row['identity'][1],'held namespace inode')
    identity(host['rootIdentity']);need(host['children']==[],'source RUN began before outer initial ownership observation');root_mount=host['rootMount'];need(type(root_mount['mountId']) is int and root_mount['mountId']>0 and root_mount['mount']=='/' and 'ro' in root_mount['options'] and root_mount['propagation']==[],'actual private readonly root mount')
    release=record['originals']['release'];need(originals[release['path']]==(record['nonce']+'\n').encode() and len(originals[release['path']])==release['bytes'] and hashlib.sha256(originals[release['path']]).hexdigest()==release['sha256'],'actual controller release nonce original differs')
    verify_stages(record,originals,image['Id'],cid)
    need(read('rootDiffBefore')==[] and read('rootDiffAfter')==[],'prepared image root unexpectedly changed')
    return dict(schemaVersion=1,model=MODEL,containerId=cid,preparedImageConfig=image['Id'],rootfsDiffIds=image['RootFS']['Layers'],hostNamespaceOriginal=host,scope='Owned Docker daemon/kernel is trusted; actual read-only image-backed root and isolated writable build/materials only',daemonManagedReadOnlyExecutorVerified=True,globalHostWriterAbsenceVerified=False,toolchainLifetimeImmutabilityVerified=False,wholeSdkSourceVerified=False)

def join_provider(proof,provider):
    """Consumes already independently verified same-SDK stopped-FD provider facts."""
    need(proof['daemonManagedReadOnlyExecutorVerified'] is True,'outer actual executor absent')
    host=proof['hostNamespaceOriginal'];need(provider['mountNamespaceIdentityDecimal']==[str(v) for v in host['namespaces']['mnt']['identity']] and provider['rootIdentityDecimal']==[str(v) for v in host['rootIdentity']],'actual provider outside owned image namespace/root')
    p=provider['provider'];need(p['mount']=='/' and 'ro' in p['mountOptions'] and p['mountId']==host['rootMount']['mountId'],'selected tool must use same read-only image root, not output/tmp/provider alias')
    need(provider['mountNamespace']==host['namespaces']['mnt']['link'],'provider namespace link differs')
    return dict(providerBoundToOwnedImageRoot=True,preparedImageConfig=proof['preparedImageConfig'],scope=proof['scope'],globalHostWriterAbsenceVerified=False)


def scan_archive(archive_path,plan):
    """Same retained private-SDK ZIP, one deadline and one aggregate metadata ledger."""
    import importlib.util
    from pathlib import Path
    import time
    spec=importlib.util.spec_from_file_location('readonly_sdk_zip',Path(__file__).with_name('sdk-zip-originals.py'));zip_reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(zip_reader)
    milliseconds=plan['remainingMilliseconds'];need(type(milliseconds) is int and 0<milliseconds<=120000,'remaining parent budget required');end=time.monotonic()+milliseconds/1000;charged=0;cache={}
    def check():
        if time.monotonic()>=end:raise TimeoutError('readonly SDK same parent deadline exhausted')
    with zip_reader.registered_zip_originals(archive_path,'readonly-executor/',check,master_reference=plan['masterReference']) as member:
        def read(ref):
            nonlocal charged
            check();key=(ref['path'],ref['bytes'],ref['sha256'])
            if key in cache:return cache[key]
            need(type(ref['bytes']) is int and 0<=ref['bytes']<=META and charged+ref['bytes']<=META,'one readonly metadata retained ledger');data=bytearray();digest=hashlib.sha256()
            with member(ref) as raw:
                while True:
                    check();chunk=raw.read(min(65536,ref['bytes']+1-len(data)))
                    if not chunk:break
                    data.extend(chunk);need(len(data)<=ref['bytes'],'readonly SDK original expanded beyond exact ref');digest.update(chunk)
            need(len(data)==ref['bytes'] and digest.hexdigest()==ref['sha256'],'actual readonly SDK bytes/SHA differ');charged+=len(data);cache[key]=bytes(data);return cache[key]
        master=json.loads(read(plan['masterReference']));same_tuple(master['identity'],plan['identity']);reference=master.get('readonlyExecutor');need(isinstance(reference,dict) and reference['path'].startswith('readonly-executor/'),'actual SDK has no outer readonly executor original')
        registered={ref['path']:ref for ref in master['originals']};need(registered.get(reference['path'])==reference,'same registered master executor reference');record=json.loads(read(reference))
        refs=[*record['originals'].values(),*[row[field] for row in record['stages'] for field in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']]]
        originals={}
        for ref in refs:need(registered.get(ref['path'])==ref,'outer executor original not same master member');originals[ref['path']]=read(ref)
        proof=verify(record,originals,plan['identity'])
        actual_daemon=json.loads(originals[record['originals']['daemonBefore']['path']])
        if actual_daemon.get('associationModel') is not None:
            normal_ref=master.get('buildkit',{}).get('record');need(isinstance(normal_ref,dict) and normal_ref.get('path')=='normal-route.original.json' and registered.get(normal_ref['path'])==normal_ref,'same master normal daemon route original')
            normal=json.loads(read(normal_ref));same_tuple(normal['identity'],plan['identity']);need(normal['readonlyExecutor']==record and normal['sourcePreparedConfig']==record['preparedImageConfig'],'same normal/executor actual interval')
            refs=normal.get('daemonActivationOriginals');need(isinstance(refs,dict) and 0<len(refs)<=33 and 'daemonActivation' in refs,'normal held daemon proof required')
            for value in refs.values():need(registered.get(value['path'])==value and value['path'].startswith('daemon-activation/'),'same master normal activation ref');read(value)
            import importlib.util
            from pathlib import Path
            spec=importlib.util.spec_from_file_location('normal_activation_receiver',Path(__file__).with_name('sdk-local-daemon-originals.py'));activation=importlib.util.module_from_spec(spec);spec.loader.exec_module(activation)
            collection=json.loads(read(refs['daemonActivation']));by_path={value['path']:value for value in refs.values()}
            def normal_original(value):
                rooted=dict(value,path='daemon-activation/'+value['path']);need(by_path.get(rooted['path'])==rooted,'complete normal activation raw graph');return read(rooted)
            normal_proof=activation.verify_collection(collection,normal_original)
            for key,field in [('mainPid','pid'),('service','activationService'),('daemonExecutableIdentity','executableIdentity'),('daemonExecutableSha256','executableSha256'),('listenerIdentity','listenerIdentity'),('controllerPidNamespace','controllerPidNamespace'),('daemonPidNamespace','daemonPidNamespace'),('hostPidNamespace','hostPidNamespace'),('controllerRootIdentity','controllerRootIdentity'),('daemonRootIdentity','daemonRootIdentity')]:need(normal_proof[key]==actual_daemon[field],'normal/SDK executor must bind same actual daemon/listener')
            stages={row['name']:row for row in normal['stages']}
            def stage_receipt(name):
                stage=stages[name]
                fixed={'receipt':'stages/'+name+'/command.receipt.json','supervisionReceipt':'stages/'+name+'.receipt.json','supervisionRaw':'stages/'+name+'.raw.log'}
                for role,path in fixed.items():need(stage[role]['path']==path and registered.get(path)==stage[role],'same master fixed normal phase raw')
                actual=json.loads(read(stage['receipt']));supervisor=json.loads(read(stage['supervisionReceipt']));raw=read(stage['supervisionRaw'])
                need(actual['exit']==0 and actual['signal'] is None and actual['actualWait'] is True and actual['rawClosedBeforeHash'] is True,'normal phase actual wait')
                need(supervisor['exit']==0 and supervisor['signal'] is None and supervisor['actualWait'] is True and supervisor['ownedGroupAbsentAfterWait'] is True and supervisor['rawClosedBeforeHash'] is True and not supervisor.get('resourceStop') and not supervisor.get('supervisorError') and not supervisor.get('cleanupErrors') and actual['pgid']==supervisor['pgid'],'normal phase supervised closure')
                need(hashlib.sha256(raw).hexdigest()==supervisor['rawSHA256'],'normal phase supervision raw hash')
                for role in ['stdout','stderr']:
                    expected=dict(actual[role],path='stages/'+name+'/'+actual[role]['path']);need(stage[role]==expected and registered.get(expected['path'])==expected,'normal phase actual member raw binding')
                need(type(actual['startedUnixNs']) is int and type(actual['completedUnixNs']) is int and 0<actual['startedUnixNs']<=actual['completedUnixNs']<=int(normal['deadlineUnix']*1e9),'normal phase same deadline')
                root=record['outputRoot'].rsplit('/',1)[0]
                controller=json.loads(normal_original(collection['frames'][0]['serviceStage']['receipt']))['command'][4].rsplit('/',1)[0]
                command=prepared_argv(ownership(plan['identity'])+'-builder',{'linux-x64':'linux/amd64','linux-arm64':'linux/arm64'}[plan['identity']['target']],plan['identity'],normal['deadlineUnix'],root+'/prepared-buildkit.original.json') if name=='prepare-source-image' else ['/usr/bin/python3','-I','-S','-B',controller+'/sdk-readonly-result-context.py','build','--plan',root+'/linked.plan.json']
                need(actual['command']==command,'normal actual fixed command')
                return actual
            prepared=stage_receipt('prepare-source-image');linked=stage_receipt('compose-linked-image')
            need(normal_proof['serviceWindows'][0]['completedUnixNs']<=prepared['startedUnixNs'] and normal_proof['serviceWindows'][-1]['startedUnixNs']>=linked['completedUnixNs'],'normal held daemon interval must enclose prepare through linked composition')
        providers=plan['providers'];need(isinstance(providers,list) and 0<len(providers)<=50000,'same private execution selected providers required')
        for provider in providers:check();join_provider(proof,provider)
        check();return dict(schemaVersion=1,sdkReadOnlyExecutorProtocolOriginalsVerified=True,selectedProvidersBoundToImageRoot=len(providers),preparedImageConfig=proof['preparedImageConfig'],scope=proof['scope'],globalHostWriterAbsenceVerified=False,toolchainLifetimeImmutabilityVerified=False,wholeSdkSourceVerified=False)

if __name__=='__main__':
    import sys
    need(len(sys.argv)==2,'fixed readonly executor archive argument');raw=sys.stdin.buffer.read(META+1);need(len(raw)<=META,'bounded readonly receiver plan');print(json.dumps(scan_archive(sys.argv[1],json.loads(raw)),sort_keys=True))
