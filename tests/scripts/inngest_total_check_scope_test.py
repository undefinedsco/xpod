"""Accounting scope and exception regression against the fixed pre-optimization definition."""
import ast,errno,json,os,shutil,tempfile
from pathlib import Path
from unittest.mock import patch
BASE=Path(__file__).resolve().parents[2]
OUT=BASE/'.test-data/api-total-check-regression'
OUT.mkdir(parents=True,exist_ok=True)
LEGACY_TOTAL_CHECK="def total_check(work):\n    total=sum(p.stat().st_size for p in work.rglob('*') if p.is_file() and not p.is_symlink() and (p.relative_to(work).parts[0] in ['materials','originals','products'] or p.parent==work and p.suffix=='.json'))\n    need(total<=min(_retained_byte_ceiling,LIMITS['sourceMaterialBytes']),'shared retained material total');need(shutil.disk_usage(work).free>=LIMITS['freeFloorBytes'],'disk floor');return total"
class BudgetError(ValueError):pass
def need(v,r):
 if not v:raise BudgetError(r)
def load(p,source=None):
 s=p.read_text() if source is None else source;node=next(n for n in ast.parse(s).body if isinstance(n,ast.FunctionDef) and n.name=='total_check');env=dict(Path=Path,os=os,shutil=shutil,need=need,LIMITS={'sourceMaterialBytes':1000000,'freeFloorBytes':0},_retained_byte_ceiling=1000000);exec(compile(ast.Module(body=[node],type_ignores=[]),str(p),'exec'),env);return env['total_check'],env
old,oe=load(BASE/'scripts/lib/inngest-controlled-build.py',LEGACY_TOTAL_CHECK);new,ne=load(BASE/'scripts/lib/inngest-controlled-build.py')
results=[]
def compare(label,root,expected=None):
 vals=[]
 for f in [old,new]:
  try:vals.append(('ok',f(root)))
  except BaseException as e:vals.append(('error',type(e).__name__,str(e)))
 assert vals[0]==vals[1],(label,vals)
 if expected is not None:assert vals[0]==('ok',expected),(label,vals)
 results.append({'case':label,'result':vals[0]})
with tempfile.TemporaryDirectory(dir=OUT) as tmp:
 root=Path(tmp)
 for name in ['materials','originals','products','source','tools','nested.json']:(root/name).mkdir()
 (root/'materials/a').write_bytes(b'abc');(root/'materials/deep').mkdir();(root/'materials/deep/b').write_bytes(b'12345');os.link(root/'materials/deep/b',root/'materials/hardlink')
 (root/'source/ignored').write_bytes(b'x'*500);(root/'tools/ignored').write_bytes(b'x'*500);(root/'nested.json/ignored').write_bytes(b'qq');(root/'root.json').write_bytes(b'{}');(root/'unbilled.txt').write_bytes(b'xx');(root/'materials/symlink').symlink_to(root/'source/ignored');(root/'materials/linkdir').symlink_to(root/'source',target_is_directory=True)
 compare('nested-files-hardlink-each-path-symlinks-root-json',root,15)
 (root/'materials/a').write_bytes(b'abcd');compare('counted-mutation',root,16)
 shutil.rmtree(root/'originals');(root/'originals').write_bytes(b'root-file');compare('selected-root-regular-file',root,25)
 (root/'originals').unlink();(root/'originals').symlink_to(root/'source',target_is_directory=True);compare('selected-root-symlink-directory',root,16)
 bad=root/'materials/a';realstat=Path.stat
 for err in [PermissionError(errno.EACCES,'injected'),OSError(errno.EIO,'injected')]:
  captured=[]
  def fault(self,*args,**kwargs):
   if self==bad:raise err
   return realstat(self,*args,**kwargs)
  with patch.object(Path,'stat',fault):
   for f in [old,new]:
    try:f(root)
    except BaseException as e:captured.append(e)
  assert len(captured)==2 and all(e is err for e in captured)
  results.append({'case':'stat-exception-'+type(err).__name__,'sameExceptionObject':True})
 for env in [oe,ne]:env['_retained_byte_ceiling']=1
 compare('over-budget-reject',root)
 for env in [oe,ne]:env['_retained_byte_ceiling']=1000000;env['LIMITS']['freeFloorBytes']=10**30
 compare('disk-floor-reject',root)
 for env in [oe,ne]:env['LIMITS']['freeFloorBytes']=0
 for name in ['materials','originals','products']:
  p=root/name
  if p.is_symlink():p.unlink()
  elif p.is_dir():shutil.rmtree(p)
  elif p.exists():p.unlink()
 compare('missing-selected-roots',root,2)
 # Excluded forests are not part of retained-byte accounting; only the old scan visits them.
 original=Path.rglob;calls=[]
 def tracked(self,*a,**k):calls.append(str(self));return original(self,*a,**k)
 with patch.object(Path,'rglob',tracked):assert new(root)==2
 assert not calls,calls
 results.append({'case':'excluded-forest-not-enumerated','rglobCalls':calls})
print(json.dumps({'passed':len(results)}))
