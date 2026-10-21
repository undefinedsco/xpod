"""New numeric kernel mapping protocol; pure replay, never kernel execution."""
import copy,hashlib,importlib.util,unittest
from pathlib import Path
from qlever.tests.test_sdk_generated_vma_bindings import fixture,two_epochs,rebound_epochs,renumber,observe,b
spec=importlib.util.spec_from_file_location('kernel_link_leaf',Path(__file__).resolve().parents[1]/'scripts/sdk-generated-vma-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def stat_raw(pid=10,start=123):return str(pid).encode()+b' (fixed task) t '+b' '.join([b'0']*18+[str(start).encode()])+b'\n'
def lease():return dict(directoryIdentity=[1,100,0o40500,0,1,1],statIdentity=[1,101,0o100444,0,1,1],statOriginal=m.raw_record(stat_raw()),starttime='123')
def upgrade(rows,originals):
 rows=copy.deepcopy(rows);originals=copy.deepcopy(originals);root=next(r for r in rows if r['kind']=='owned-root-binding');root['generatedVmaModel']=m.MODEL
 serial=20000
 def row(kind,template,**fields):
  nonlocal serial
  serial+=1;return dict(kind=kind,phase=template['phase'],sequence=serial,observedMonotonicNs=template['observedMonotonicNs'],**fields)
 def original(data,template,maps=False):
  name='capture-'+str(serial)+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());return row('toolchain-original' if maps else 'write-original',template,**(dict(captureKind='maps',observedPid=10) if maps else {}),original=ref),ref
 for win in [r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='map']:
  win.update(reservationBytes=m.reservation_bytes(0,4*1024**2),selectedIdentity=copy.deepcopy(win['identity']),selectedOriginal=copy.deepcopy(win['beforeOriginal']),selectedFlags=2,procLease=lease())
  epoch=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['windowSequence']==win['sequence']);actual=next(r for r in rows if r['sequence']==epoch['exitSequence']);pre=next(r for r in rows if r['sequence']==win['barrierSequence']);post=row('all-stop-barrier',epoch,pids=pre['pids'],osStates=pre['osStates'],taskOwnership=pre['taskOwnership']);rows.insert(rows.index(actual)+1,post)
  bodyrow,bodyref=original(originals[win['beforeOriginal']['path']],epoch);rows.insert(rows.index(epoch),bodyrow)
  firstmaps=next(r for r in rows if r.get('original')==epoch['mapsOriginal'] and r['kind']=='toolchain-original');rows.remove(bodyrow);rows.insert(rows.index(firstmaps),bodyrow)
  link=m.raw_record(win['path'].encode());common=dict(pid=10,entrySequence=win['entrySequence'],postBarrierSequence=post['sequence'],range=[epoch['mapping']['startHex'],epoch['mapping']['endHex']],link=link,procLease=lease());first=row('generated-vma-kernel-link-original',epoch,**common,mapsOriginal=epoch['mapsOriginal']);confirmrow,confirm=original(originals[epoch['mapsOriginal']['path']],epoch,True);lastbodyrow,lastbody=original(originals[win['beforeOriginal']['path']],epoch);last=row('generated-vma-kernel-link-original',epoch,**common,mapsOriginal=confirm)
  rows[rows.index(epoch):rows.index(epoch)]=[first,confirmrow,lastbodyrow,last]
  epoch.pop('mapFilesIdentity');epoch['kernelMappingEvidence']=dict(kind=m.MAPPING_KIND,postBarrierSequence=post['sequence'],selectedFd=win['fd'],selectedIdentity=copy.deepcopy(win['identity']),retainedIdentity=copy.deepcopy(win['identity']),namedIdentity=copy.deepcopy(win['identity']),selectedFlags=2,beforeOriginal=win['selectedOriginal'],postOriginal=bodyref,confirmationOriginal=lastbody,mapsConfirmationOriginal=confirm,linkBefore=link,linkAfter=link,procBefore=lease(),procAfter=lease(),linkBeforeSequence=first['sequence'],linkAfterSequence=last['sequence'])
 renumber(rows)
 for r in rows:r['observedMonotonicNs']=str(100000000000+r['sequence']*1000000)
 return rows,originals
class Tests(unittest.TestCase):
 def test_two_abis_same_new_fd_and_both_close_orders(self):
  for arch in m.ABI:
   for make in [fixture,two_epochs,lambda a:rebound_epochs(a,True,False),lambda a:rebound_epochs(a,False,True)]:
    rows,originals=upgrade(*make(arch));report=observe(rows,originals);self.assertTrue(report['generatedMappedConsumerByteCustodyVerified']);self.assertFalse(report['overallSdkSourceVerified'])
 def test_numeric_fd_body_proc_and_kernel_link_mutations_both_abis(self):
  for arch in m.ABI:
   for field,value in [('selectedFd',99),('selectedFlags',0),('selectedIdentity',[1,99,0o100600,1,11,11]),('kind','fake'),('postBarrierSequence',1),('linkBeforeSequence',1)]:
    rows,originals=upgrade(*fixture(arch));epoch=next(r for r in rows if 'kernelMappingEvidence' in r);epoch['kernelMappingEvidence'][field]=value
    with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
   for change in ['wronglink','deleted','starttime','procobject','maps','body','legacy','version','missingbarrier','peer']:
    rows,originals=upgrade(*fixture(arch));epoch=next(r for r in rows if 'kernelMappingEvidence' in r);proof=epoch['kernelMappingEvidence']
    if change in ['wronglink','deleted']:proof['linkBefore']=m.raw_record(b'/opt/qlever-sdk/build/wrong'+(b' (deleted)' if change=='deleted' else b''))
    elif change=='starttime':proof['procAfter']['starttime']='124'
    elif change=='procobject':proof['procAfter']['directoryIdentity'][1]=999
    elif change=='maps':proof['mapsConfirmationOriginal']['sha256']='0'*64
    elif change=='body':proof['postOriginal']['sha256']='0'*64
    elif change=='legacy':epoch['mapFilesIdentity']=epoch['identity']
    elif change=='version':rows[0]['generatedVmaModel']=m.LEGACY_MODEL
    elif change=='missingbarrier':rows.remove(next(r for r in rows if r['sequence']==proof['postBarrierSequence']));renumber(rows)
    elif change=='peer':
     index=rows.index(next(r for r in rows if r['sequence']==proof['linkBeforeSequence']));row=copy.deepcopy(rows[index]);row.update(kind='kernel-syscall',op='entry',pid=99,arch=arch,nr=172 if arch==0xc00000b7 else 39,args=[0]*6,sequence=99999);rows.insert(index,row);renumber(rows)
    with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_legacy_full_two_epoch_protocol_remains_strict(self):
  for arch in m.ABI:
   self.assertTrue(observe(*rebound_epochs(arch,True))['generatedMappedConsumerByteCustodyVerified'])
   rows,originals=fixture(arch);next(r for r in rows if 'mapFilesIdentity' in r)['mapFilesIdentity'][1]=99
   with self.assertRaises((ValueError,AssertionError)):observe(rows,originals)
if __name__=='__main__':unittest.main()
