'use strict';
const limits=require('./lib/module-artifact-limits.json');
function need(value,why){if(!value)throw Error('Service pack actual selection: '+why);}
/** Parse only the tool's observed dry-run protocol. This is not an npm files
 * rule implementation and issues no source fact. The real archive must later
 * close this exact selection against actual held inputs and original bytes. */
function parseActualPackSelection(raw,version,check=()=>{}){
 need(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=limits.metadataBytes&&typeof version==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version),'bounded observed tool output/version');
 need(typeof check==='function','existing parent check');check();
 const text=raw.toString('utf8');need(Buffer.from(text).equals(raw)&&text.endsWith('\n')&&!/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text),'exact UTF8 LF-only output');const lines=text.split('\n');let cursor=0;const next=()=>lines[cursor++];
 const banner=next();need(new RegExp('^bun pack v'+version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' \\([a-f0-9]{7,40}\\)$','u').test(banner)&&next()==='','actual version banner/separator');const files=[],seen=new Set();
 while(lines[cursor]?.startsWith('packed ')){
  check();const line=next(),match=/^packed ([0-9]+(?:\.[0-9]+)?(?:[kKMGT]?B)) (.+)$/u.exec(line);need(match,'exact actual selected row');const file=match[2];need(Buffer.byteLength(file)<=4096&&!file.startsWith('/')&&!file.includes('\\')&&file.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&!seen.has(file)&&files.length<limits.members,'bounded unique actual selected member');seen.add(file);files.push(file);
 }
 need(files.length>0&&seen.has('package.json')&&next()==='','complete actual selected file rows');const filename=next();need(typeof filename==='string'&&filename.length<=4096&&!/[\\/\u0000-\u001f\u007f]/u.test(filename)&&filename.endsWith('.tgz')&&next()==='','actual output filename/separator');const total=/^Total files: ([0-9]+)$/u.exec(next()||'');need(total&&Number(total[1])===files.length&&/^Unpacked size: [0-9]+(?:\.[0-9]+)?(?:[kKMGT]?B)$/u.test(next()||'')&&cursor===lines.length-1&&lines[cursor]==='','actual selected count/closed dry-run output');
 return Object.freeze({files:Object.freeze(files),filename,toolVersion:version});
}
module.exports={parseActualPackSelection};
