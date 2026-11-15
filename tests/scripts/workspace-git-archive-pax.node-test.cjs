const test=require('node:test');const assert=require('node:assert/strict');
const {parseTar}=require('../../scripts/workspace-package-payload.cjs');
const commit='1'.repeat(40),limits={members:20,gitArchiveCommit:commit};
function entry(name,type,body=Buffer.alloc(0)){
 const header=Buffer.alloc(512);header.write(name);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write(type,156);header.write('ustar\0',257);header.write('00',263);let checksum=0;for(const byte of header)checksum+=byte;header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([header,body,Buffer.alloc((512-body.length%512)%512)]);
}
const file=()=>entry('project-'+commit+'/LICENSE','0',Buffer.from('actual original terms'));
const global=(body=Buffer.from('52 comment='+commit+'\n'),type='g')=>entry('pax_global_header',type,body);
const archive=(...rows)=>Buffer.concat([...rows,Buffer.alloc(1024)]);
test('Git PAX support is explicit, exact and preserves actual regular member bytes',()=>{
 const raw=archive(global(),file());assert.throws(()=>parseTar(raw,{members:20}),/Unsupported tar/);const rows=parseTar(raw,limits);assert.equal(rows.length,1);assert.equal(rows[0].content.toString(),'actual original terms');assert.equal(rows[0].path,'project-'+commit+'/LICENSE');assert.equal(parseTar(archive(file()),limits).length,1);assert.equal(parseTar(archive(file()),{members:20}).length,1);
});
test('PAX comment never overrides path, size or link and cannot be late, repeated or malformed',()=>{
 for(const raw of [archive(file(),global()),archive(global(),global(),file()),archive(global(Buffer.from('52 comment='+'2'.repeat(40)+'\n')),file()),archive(global(Buffer.from('51 comment='+commit+'\n')),file()),archive(global(Buffer.from('13 path=evil\n')),file()),archive(global(Buffer.from('52 comment='+commit+'\n'),'x'),file()),archive(global(Buffer.from('52 comment='+commit+'\0')),file())])assert.throws(()=>parseTar(raw,limits));
 const padding=archive(global(),file());padding[512+52]=1;assert.throws(()=>parseTar(padding,limits),/padding/);
 for(const value of [true,'x','A'.repeat(40),'1'.repeat(41)])assert.throws(()=>parseTar(archive(file()),{members:20,gitArchiveCommit:value}),/Invalid tar member/);
});
test('Git archive opt-in retains member bounds, checksum, closed paths and trailer checks',()=>{
 assert.throws(()=>parseTar(archive(global(),file()),{...limits,members:1}),/budget/);const checksum=archive(global(),file());checksum[0]^=1;assert.throws(()=>parseTar(checksum,limits),/checksum/);assert.throws(()=>parseTar(archive(global(),entry('../LICENSE','0',Buffer.from('terms'))),limits),/traversal/);assert.throws(()=>parseTar(archive(global(),file(),file()),limits),/Duplicate/);const tail=archive(global(),file());tail[tail.length-1]=1;assert.throws(()=>parseTar(tail,limits),/nonzero/);assert.throws(()=>parseTar(archive(global(),entry('linked','2')),limits),/Unsupported/);
});
