"""Sole service-pack body/parent mechanics; no source, image or grant issuer.

The collector and independent private receiver run these exact functions.
"""
import base64,hashlib,json,re,sys,time
from pathlib import Path
META=json.loads((Path(__file__).resolve().parents[2]/'scripts/lib/module-artifact-limits.json').read_bytes())['metadataBytes']
def need(value,reason):
    if not value:raise ValueError('Service pack bindings: '+reason)
OUTPUT_PACK_ROLE='copy-pack-inputs'
OUTPUT_PACK_PHASE_ROLE='copy-pack-phase'
OUTPUT_PACK_BODY_ROLE='copy-pack-body'
def service_output_worker_argv(source,source_sha,role,image,name,nonce,cid=None,body_path=None,copy_bound=None):
    need(isinstance(source,str) and source.startswith('/') and str(Path(source))==source and not any(p in ['.','..'] for p in source.split('/')) and isinstance(source_sha,str) and re.fullmatch('[a-f0-9]{40}',source_sha),'fixed source worker identity')
    need(role in ['pull','create','inspect','copy','remove','confirm-absent',OUTPUT_PACK_ROLE,OUTPUT_PACK_PHASE_ROLE,OUTPUT_PACK_BODY_ROLE,'cleanup-list','cleanup-inspect','cleanup-remove','cleanup-confirm-absent'],'fixed output worker role')
    argv=['/usr/bin/python3','-I','-S','-B',source+'/qlever/scripts/sdk-service-image-originals.py','--source',source,'--source-sha',source_sha,'--image-worker',role,'--service-image',image,'--container-name',name,'--owner-nonce',nonce]
    if cid is not None:argv+=['--container-id',cid]
    if body_path is not None:argv+=['--body-path',body_path]
    if copy_bound is not None:argv+=['--copy-byte-bound',str(copy_bound)]
    return argv
def pack_body_references(collection):
    refs=collection.get('bodyOriginals');records=collection.get('records')
    need(isinstance(refs,list) and 0<len(refs)<=4095 and isinstance(records,list) and len(records)<=4096,'bounded actual body/reference records')
    seen=set();actual=[r for r in records if isinstance(r,dict) and r.get('kind')=='actual-pack-body'];need(len(actual)==len(refs),'exact body operation count')
    roles=[]
    for index,ref in enumerate(refs,1):
        need(isinstance(ref,dict) and set(ref)=={'path','bytes','sha256'} and type(ref['bytes']) is int and 0<ref['bytes']<=32*META and isinstance(ref['sha256'],str) and re.fullmatch('[a-f0-9]{64}',ref['sha256']),'bounded plain actual body reference')
        need(ref['path']=='service-pack-bodies/objects/'+str(index).zfill(4)+'-'+ref['sha256']+'.original' and ref['path'] not in seen,'exact unique body ordinal path');seen.add(ref['path'])
        matching=[r for r in actual if r.get('reference')==ref];need(len(matching)==1,'unique actual body record')
        row=matching[0];need(row.get('role') in ['seed-npm-pack','public-package-tar','final-service-pack'],'fixed body role')
        need((isinstance(row.get('name'),str) and 0<len(row['name'])<=256) if row['role']=='public-package-tar' else row.get('name') is None,'fixed public body name')
        at=records.index(row);stats=[r for r in records[:at] if isinstance(r,dict) and r.get('kind')=='actual-pack-body-stat' and all(r.get(key)==row.get(key) for key in ['role','name','path','canonicalPath','identity']) and r.get('bytes')==ref['bytes']]
        need(len(stats)==1,'actual body stat/read origin must match');roles.append(row['role'])
    need(roles.count('seed-npm-pack')==roles.count('final-service-pack')==1,'exact seed and final body required')
    return refs

def body_copy_bound(reference):
    need(type(reference.get('bytes')) is int and 0<reference['bytes']<=32*META,'bounded actual body copy size')
    return ((reference['bytes']+511)//512)*512+10240+512

def service_pack_worker_plans(context,record,references):
    need(record.get('schemaVersion')==1 and record.get('kind')=='actual-stopped-service-image-pack-inputs' and record.get('imageReferenceByDigest')==context['image'] and record.get('containerId')==context['cid'],'same stopped image pack observation')
    bodies=record.get('bodies');need(isinstance(bodies,list) and len(bodies)==len(references) and [row.get('reference') for row in bodies]==references,'exact ordered actual body captures')
    phases=[(OUTPUT_PACK_ROLE,record.get('stage'),META,None),(OUTPUT_PACK_PHASE_ROLE,record.get('phase',{}).get('stage'),4*META,None)]+[(OUTPUT_PACK_BODY_ROLE,row.get('stage'),body_copy_bound(ref),ref) for row,ref in zip(bodies,references)]
    result=[]
    for role,stage,maximum,ref in phases:
        need(isinstance(stage,dict),'complete actual pack capture stage')
        label='service-output-'+role+('-'+Path(ref['path']).name[:4] if ref else '')
        command=service_output_worker_argv(context['source'],context['sourceSha'],role,context['image'],context['name'],context['nonce'],context['cid'],ref['path'] if ref else None,None if role==OUTPUT_PACK_ROLE else maximum)
        need(stage.get('name')==label,'actual ordered pack stage label')
        result.append(dict(name=label,command=command,stdoutMaximum=maximum))
    return result

def verify_pack_parent(collection,parent,phase_originals,captured):
    need(parent.get('sourceSha')==collection.get('sourceSha') and parent.get('authorityVerified') is False and parent.get('retainedCeilingBytes')==32*META,'same source/upstream pack budget')
    rows=parent.get('originals');need(isinstance(rows,list) and len(rows)==len(captured) and all(isinstance(r,dict) and set(r)=={'path','bytes','sha256'} for r in rows),'closed actual pack parent index')
    indexed={r['path']:r for r in rows};need(len(indexed)==len(rows) and indexed==captured,'parent metadata/body full retained closed set differs')
    need(type(parent.get('chargedOriginalBytes')) is int and parent['chargedOriginalBytes']==sum(r['bytes'] for r in rows)<=32*META,'actual parent charged byte inventory')
    receipt=json.loads(phase_originals['pack.receipt.json']);raw=phase_originals['pack.raw.log'];budget=collection.get('details',{}).get('budget',{})
    deadline=parent.get('deadlineUnixMs');need(type(deadline) is int and budget.get('deadlineUnixMs')==deadline and budget.get('retainedCeilingBytes')==30*META,'same actual pack worker deadline/allocation')
    need(receipt.get('command')==['node','/app/scripts/run-npm-pack.cjs','.test-data/service-pack','.test-data/service-pack-cache','service','--retain-service-originals',parent['sourceSha'],str(deadline),str(30*META)],'exact upstream pack command')
    need(receipt.get('exit')==0 and type(receipt.get('exit')) is int and receipt.get('signal') is None and receipt.get('resourceStop') is None and receipt.get('supervisorError') is None and isinstance(receipt.get('cleanupErrors'),list) and len(receipt['cleanupErrors'])==0 and all(key in receipt for key in ['signal','resourceStop','supervisorError']) and receipt.get('actualWait') is True and receipt.get('ownedGroupAbsentAfterWait') is True and receipt.get('rawClosedBeforeHash') is True,'pack actual successful wait/closure required')
    need(receipt.get('snapshotOriginalRetained') is not False and not receipt.get('receiptSnapshotOverflow') and receipt.get('rawOverflow') is False and receipt.get('actualRawPipeEof') is True and receipt.get('retainedRawBytes')==len(raw) and receipt.get('rawSHA256')==hashlib.sha256(raw).hexdigest() and receipt.get('rawByteLimit')==META,'complete upstream supervision raw/receipt required')
    need(collection.get('details',{}).get('completion')=='actual-pack-returned' and collection.get('authorityVerified') is False,'actual pack sealed observation only')
    return dict(parentRawClosureVerified=True,packManifestTransformationVerified=False,pending=['same-private-source-and-pack-input-resolution-closure-unverified'])

def main():
    # Fixed input/output and one inherited caller duration, no file/body paths.
    raw=sys.stdin.buffer.read(5*META+1);need(len(raw)<=5*META,'bounded existing metadata request');request=json.loads(raw);end_ms=request.get('deadlineUnixMs');need(type(end_ms) is int and 0<end_ms-time.time()*1000<=120000,'remaining same parent deadline required');end=end_ms/1000
    originals={}
    for row in request['phaseOriginals']:
        need(set(row)=={'name','bytes','sha256','encoding','content'} and row['name'] in ['pack.receipt.json','pack.raw.log'] and row['name'] not in originals and row['encoding']=='base64' and type(row['bytes']) is int and 0<=row['bytes']<=META and isinstance(row['content'],str) and len(row['content'])<=4*((row['bytes']+2)//3),'bounded exact parent original encoding')
        data=base64.b64decode(row['content'],validate=True);need(len(data)==row['bytes'] and hashlib.sha256(data).hexdigest()==row['sha256'],'actual parent original hash');originals[row['name']]=data
    need(set(originals)=={'pack.receipt.json','pack.raw.log'} and time.time()<end,'complete parent originals/remaining deadline');refs=pack_body_references(request['collection']);mechanics=verify_pack_parent(request['collection'],request['parent'],originals,request['captured']);plans=service_pack_worker_plans(request['workerContext'],request['packObservation'],refs);need(time.time()<end,'parent deadline exhausted');output=json.dumps(dict(bodyOriginals=refs,workerPlans=plans,mechanics=mechanics),separators=(',',':')).encode();need(len(output)<=META,'bounded mechanical projection');sys.stdout.buffer.write(output)
if __name__=='__main__':main()
