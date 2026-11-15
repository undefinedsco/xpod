'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const parent = path.join(root, '.test-data/physical-module-readback'); fs.mkdirSync(parent, { recursive: true });
const temporary = fs.mkdtempSync(path.join(parent, 'case-'));
try {
  const result = spawnSync('python3', ['-B', '-c', String.raw`
from pathlib import Path
import hashlib,io,json,sys,tarfile
from unittest.mock import patch
source=Path(sys.argv[1]).read_text();code=source.split("const readback=spawnSync('python3',['-c',\x60",1)[1].split('\x60,path.resolve(output)]',1)[0]
root=Path(sys.argv[2]);observed=[]
for case in ['valid','body','mode','extra','duplicate']:
 rows=[];items=[]
 for index in range(64):
  name='files/'+str(index);body=('actual-'+str(index)).encode();rows.append(dict(path=name,size=len(body),sha256=hashlib.sha256(body).hexdigest(),mode=0o644));items.append(('package/'+name,body,0o644))
 items.insert(0,('package/package.json',json.dumps(dict(xpodModule=dict(files=rows))).encode(),0o644))
 if case=='body':items[-1]=(items[-1][0],b'wrong',0o644)
 if case=='mode':items[-1]=(items[-1][0],items[-1][1],0o755)
 if case=='extra':items.append(('package/extra',b'x',0o644))
 if case=='duplicate':items.append(items[-1])
 archive=root/(case+'.tgz')
 with tarfile.open(archive,'w:gz',format=tarfile.USTAR_FORMAT) as stream:
  for name,body,mode in items:
   info=tarfile.TarInfo(name);info.size=len(body);info.mode=mode;stream.addfile(info,io.BytesIO(body))
 calls=[0];real=tarfile.TarFile.getmember
 def counted(self,*args,**kwargs):calls[0]+=1;return real(self,*args,**kwargs)
 rejected=False
 with patch.object(sys,'argv',['readback',str(archive)]),patch.object(tarfile.TarFile,'getmember',counted):
  try:exec(compile(code,'actual-production-readback','exec'),{})
  except (AssertionError,KeyError,tarfile.TarError):rejected=True
 assert rejected==(case!='valid'),case
 if case=='valid':assert calls[0]==0,'per-member linear tar lookup returned'
 observed.append(dict(case=case,rejected=rejected,getmemberCalls=calls[0]))
print(json.dumps(observed))
`, path.join(root, 'scripts/lib/physical-module-archive.ts'), temporary], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr); const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 5); assert.equal(rows[0].rejected, false); assert.ok(rows.slice(1).every(row => row.rejected));
  console.log('physical readback: indexed lookup and all four integrity refusals passed');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
