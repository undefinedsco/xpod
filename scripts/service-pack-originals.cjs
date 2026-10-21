'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const limits = require('./lib/module-artifact-limits.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function need(value, reason) { if (!value) throw new Error('Service pack originals: ' + reason); }
function identity(value) { return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** An optional recorder for the actual pack invocation, not an authority issuer.
 * The caller supplies its existing absolute deadline and retained-byte ledger.
 * Returned read buffers are the exact bytes used by the production packer. */
function createServicePackOriginals({ directory, bodyDirectory, sourceSha, check, reserveBytes, remainingBytes, metadataStart = () => {}, execFileSync, reserveOriginalMaximum, settleOriginalReservation }) {
  need(typeof check === 'function' && typeof reserveBytes === 'function', 'existing deadline and retained ledger required');
  need(typeof sourceSha === 'string' && /^[a-f0-9]{40}$/u.test(sourceSha), 'exact source SHA required');
  check();
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(path.join(directory, 'objects'), { mode: 0o700 });
  const objects = new Map(), bodies = new Map(), records = [], auxiliaryFds = new Set();
  if (bodyDirectory) { bodyDirectory = path.resolve(bodyDirectory); fs.mkdirSync(bodyDirectory, { mode: 0o700 }); fs.mkdirSync(path.join(bodyDirectory, 'objects'), { mode: 0o700 }); }
  let metadataBytes = 0, finished = false;
  const inputs = require('./service-pack-input-custody.cjs').createServicePackInputCustody({check});
  function metadataTransportBytes(objectRows, actualRecords, extraIndexBytes = 98304) {
    const sample = { schemaVersion: 1, kind: 'actual-service-pack-manifest-inputs', sourceSha, scope: 'same-invocation byte and resolution observations only', authorityVerified: false, originals: objectRows, bodyOriginals: [...bodies.values()], records: actualRecords, details: {} };
    const padded = size => Math.ceil(size / 512) * 512;
    return 2560 + padded(Buffer.byteLength(JSON.stringify(sample, null, 2)) + 1 + extraIndexBytes) + objectRows.reduce((sum, row) => sum + 512 + padded(row.bytes), 0);
  }
  function active() { check(); need(!finished, 'recording already sealed'); }
  function append(row) {
    active(); need(records.length < limits.sourceMaterialFiles, 'bounded original record count');
    const encoded = JSON.stringify(row);
    need(Buffer.byteLength(encoded) <= 16384 && metadataBytes + Buffer.byteLength(encoded) + 1 <= limits.metadataBytes - 1024, 'bounded original metadata');
    need(metadataTransportBytes([...objects.values()], [...records, row]) <= limits.metadataBytes, 'metadata transport aggregate bound');
    metadataBytes += Buffer.byteLength(encoded) + 1; records.push(JSON.parse(encoded));
  }
  function role(value) { need(typeof value === 'string' && /^[a-zA-Z0-9/:._-]{1,128}$/u.test(value), 'fixed bounded original role'); return value; }
  function filePath(value) { need(typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value), 'bounded absolute input path'); return value; }
  function objectBuffer(data) {
    active(); const digest = sha(data), reference = { path: 'objects/' + digest + '.original', bytes: data.length, sha256: digest };
    if (objects.has(digest)) { need(objects.get(digest).bytes === data.length, 'object identity collision'); return reference; }
    need(objects.size < limits.sourceMaterialFiles, 'bounded retained object count');
    need(metadataTransportBytes([...objects.values(), reference], records) <= limits.metadataBytes, 'metadata transport aggregate bound');
    const fd = fs.openSync(path.join(directory, reference.path), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      for (let offset = 0; offset < data.length; offset += limits.rangeBytes) {
        active(); const block = data.subarray(offset, offset + limits.rangeBytes); reserveBytes(block.length); let written = 0;
        while (written < block.length) { active(); const size = fs.writeSync(fd, block, written, block.length - written); need(size > 0, 'original write made no progress'); written += size; }
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    objects.set(digest, reference); return reference;
  }
  function readOriginal(file, inputRole, maximum = limits.metadataBytes) {
    active(); filePath(file); role(inputRole);
    const observed = inputs.readOriginal(file, maximum), data = observed.bytes;
    const reference = objectBuffer(data);
    append({ kind: 'actual-manifest-read', role: inputRole, path: file, canonicalPath: observed.observation.canonicalPath, identity: observed.observation.identity, reference, inputCustody: observed.observation });
    return data;
  }
  function probePath(file, kind) { active(); return inputs.probe(file, kind); }
  function copyTree(source, destination, filter, name) { active();const start=records.length;const ledger=require('./service-pack-copy-ledger.cjs').createCopyLedger({roots:[source,destination,fs.realpathSync(source),path.join(fs.realpathSync(path.dirname(destination)),path.basename(destination))],check:active});const result=inputs.copyTree(source, destination, { filter, record: ledger.add });const reference=objectBuffer(ledger.seal());append({kind:'actual-resolution-event',role:'actual-selected-input-copy-ledger',sourceRoot:source,destinationRoot:destination,reference});retainSelectedInput(source,destination,name,{first:start,last:records.length-1});return result; }
  function capturePublicPack(source, name, archivePath) {
    active();filePath(source);filePath(archivePath);need(typeof name==='string'&&name.length<=256&&typeof execFileSync==='function','actual public package and same parent command required');
    const start=records.length,versionRaw=execFileSync('bun',['--version'],{cwd:source}),version=versionRaw.toString('utf8').trim();
    const selectionRaw=execFileSync('bun',['pm','pack','--dry-run','--ignore-scripts'],{cwd:source});
    const selected=require('./service-pack-public-inputs.cjs').parseActualPackSelection(selectionRaw,version,active),lease=inputs.leaseSelectedFiles(source,selected.files);let error;
    try {
      const selectedMetadata=rows=>{const ledger=require('./service-pack-copy-ledger.cjs').createCopyLedger({roots:[source,fs.realpathSync(source)],check:active});for(const row of rows)ledger.add(row);return objectBuffer(ledger.seal());};
      const before=selectedMetadata(lease.before());
      const packStart=records.length;
      execFileSync('bun',['pm','pack','--ignore-scripts','--filename',archivePath],{cwd:source});
      const packEnd=records.length-1,checkpoint=selectedMetadata(lease.checkpoint());
      const sourceBody=retainPublicSelectedSource(source,name,selected.files,before,checkpoint);
      const after=selectedMetadata(lease.finish());
      append({kind:'actual-resolution-event',role:'actual-public-pack-selected-input-window',name,sourceRoot:source,archivePath,toolVersion:version,selectionCommandRecords:{first:start,last:packStart-1},packCommandRecords:{first:packStart,last:packEnd},before,checkpoint,after,sourceBody});
    } catch(failure){error=failure;throw failure;} finally {lease.close(error);}
  }
  function closeInputs(){let primary;try{inputs.close();}catch(error){primary=error;}for(const fd of [...auxiliaryFds]){try{fs.closeSync(fd);auxiliaryFds.delete(fd);}catch(error){primary??=error;}}if(primary)throw primary;}
  function retainPublicSelectedSource(source,name,names,before,checkpoint){
    active();need(bodyDirectory&&typeof reserveOriginalMaximum==='function'&&typeof settleOriginalReservation==='function','same-parent selected source reservation required');
    const listRaw=Buffer.from(names.map(value=>'package/'+value+'\0').join(''));need(listRaw.length>0&&listRaw.length<=limits.metadataBytes,'bounded actual selection list');
    const listReference=objectBuffer(listRaw),maximum=remainingBytes()-listRaw.length-2*limits.rangeBytes;need(maximum>0,'pending selected source body/list retention budget exhausted');
    const token=reserveOriginalMaximum(maximum+listRaw.length),scratch=fs.mkdtempSync(path.join(path.dirname(directory),'.public-source-')),listPath=path.join(scratch,'selected.original'),temporary=path.join(bodyDirectory,'objects','.pending-public-source-'+records.length);let listFd,bodyFd,primary;
    const full=value=>[...identity(value),String(value.nlink)];
    const hashHeld=(fd,size)=>{const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(limits.rangeBytes);let count=0;while(count<size){active();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,size-count),count);need(n>0,'selected original shortened');digest.update(buffer.subarray(0,n));count+=n;}return digest.digest('hex');};
    const cleanupFd=fd=>{if(fd===undefined||!auxiliaryFds.has(fd))return;try{fs.closeSync(fd);auxiliaryFds.delete(fd);}catch(error){if(!primary)primary=error;}};
    try{
      fs.symlinkSync(fs.realpathSync(source),path.join(scratch,'package'));
      listFd=fs.openSync(listPath,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);auxiliaryFds.add(listFd);
      for(let at=0;at<listRaw.length;){active();const n=fs.writeSync(listFd,listRaw,at,Math.min(limits.rangeBytes,listRaw.length-at),at);need(n>0,'selected list write made no progress');at+=n;}fs.fsyncSync(listFd);
      const listFirst=fs.fstatSync(listFd,{bigint:true});need(listFirst.isFile()&&listFirst.nlink===1n&&Number(listFirst.size)===listRaw.length&&same(full(listFirst),full(fs.lstatSync(listPath,{bigint:true})))&&hashHeld(listFd,listRaw.length)===listReference.sha256,'same held complete selected list before command');
      const commandFirst=records.length;execFileSync('python3',[path.join(__dirname,'service-pack-source-body.py'),scratch,temporary,String(maximum),listPath],{cwd:scratch,maxBuffer:limits.rangeBytes});const commandLast=records.length-1;
      need(same(full(listFirst),full(fs.fstatSync(listFd,{bigint:true})))&&same(full(listFirst),full(fs.lstatSync(listPath,{bigint:true})))&&hashHeld(listFd,listRaw.length)===listReference.sha256&&same(full(listFirst),full(fs.fstatSync(listFd,{bigint:true})))&&same(full(listFirst),full(fs.lstatSync(listPath,{bigint:true}))),'selected list changed across actual tar');
      const pre=fs.lstatSync(temporary,{bigint:true});need(pre.isFile()&&pre.nlink===1n&&pre.size>0n&&pre.size<=BigInt(maximum),'bounded single actual selected archive before open');bodyFd=fs.openSync(temporary,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);auxiliaryFds.add(bodyFd);const first=fs.fstatSync(bodyFd,{bigint:true});need(same(full(pre),full(first)),'same opened selected archive');const digest=hashHeld(bodyFd,Number(first.size));need(same(full(first),full(fs.fstatSync(bodyFd,{bigint:true})))&&same(full(first),full(fs.lstatSync(temporary,{bigint:true}))),'selected archive changed during full hash');
      const canonicalPath=fs.realpathSync(temporary),role='public-selected-input-source-tar';append({kind:'actual-pack-body-stat',role,name,path:temporary,canonicalPath,identity:identity(first),bytes:Number(first.size)});
      const filename=String(bodies.size+1).padStart(4,'0')+'-'+digest+'.original',reference={path:'service-pack-bodies/objects/'+filename,bytes:Number(first.size),sha256:digest};fs.renameSync(temporary,path.join(bodyDirectory,'objects',filename));
      const value={kind:'actual-pack-body',role,name,path:temporary,canonicalPath,identity:identity(first),reference,sourceRoot:source,before,checkpoint,list:{reference:listReference,path:listPath,identity:full(listFirst),postIdentity:full(fs.fstatSync(listFd,{bigint:true}))},commandRecords:{first:commandFirst,last:commandLast},archiveMaximumBytes:maximum};
      cleanupFd(bodyFd);cleanupFd(listFd);if(primary)throw primary;
      fs.unlinkSync(listPath);fs.unlinkSync(path.join(scratch,'package'));fs.rmdirSync(scratch);
      const absent=file=>{const lexical=path.dirname(file),canonical=fs.realpathSync(lexical),fd=fs.openSync(canonical,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);auxiliaryFds.add(fd);const parent=fs.fstatSync(fd,{bigint:true});need(parent.isDirectory()&&same(full(parent),full(fs.statSync(lexical,{bigint:true}))),'same actual absence parent');let missing=false;try{fs.lstatSync(file);}catch(error){need(error.code==='ENOENT','cleanup must be actual ENOENT');missing=true;}need(missing&&same(full(parent),full(fs.fstatSync(fd,{bigint:true})))&&same(full(parent),full(fs.statSync(lexical,{bigint:true})))&&fs.realpathSync(lexical)===canonical,'actual owned temporary absence');const observation={path:file,errno:'ENOENT',parent:{path:lexical,canonicalPath:canonical,identity:full(parent)}};cleanupFd(fd);if(primary)throw primary;return observation;};
      const cleanup=[absent(scratch),absent(temporary)];
      settleOriginalReservation(token,Number(first.size),true);bodies.set(reference.path,reference);append({...value,cleanup,reservation:{maximumBytes:maximum+listRaw.length,listBytes:listRaw.length,settledBytes:Number(first.size),commandHeadroomBytes:2*limits.rangeBytes}});return reference;
    }catch(error){primary=error;throw error;}finally{cleanupFd(bodyFd);cleanupFd(listFd);/* Unproven partials remain fully reserved; parent owns failed scratch. */}
  }
  function retainSelectedInput(source, destination, name, copiedRecords) {
    active();need(typeof reserveOriginalMaximum === 'function' && typeof settleOriginalReservation === 'function' && typeof execFileSync === 'function','same parent source-body reservation required');
    need(typeof name === 'string' && name.length <= 256 && bodyDirectory,'selected input name/body domain required');
    const maximum = remainingBytes() - limits.rangeBytes;need(maximum > 0,'pending source-body retention budget exhausted');
    const token = reserveOriginalMaximum(maximum), scratch = fs.mkdtempSync(path.join(path.dirname(directory),'.source-body-'));
    const temporary = path.join(bodyDirectory,'objects','.pending-source-'+records.length);let fd,error;
    try {
      fs.symlinkSync(fs.realpathSync(destination),path.join(scratch,'package'));
      execFileSync('python3',[path.join(__dirname,'service-pack-source-body.py'),scratch,temporary,String(maximum)]);
      fd=fs.openSync(temporary,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const first=fs.fstatSync(fd,{bigint:true});need(first.isFile()&&first.size>0n&&first.size<=BigInt(maximum),'actual bounded selected input archive');
      const bodyCanonical=fs.realpathSync(temporary);append({kind:'actual-pack-body-stat',role:'selected-input-source-tar',name,path:temporary,canonicalPath:bodyCanonical,identity:identity(first),bytes:Number(first.size)});
      const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(limits.rangeBytes);let count=0;
      while(count<Number(first.size)){active();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(first.size)-count),count);need(n>0,'source body shortened');digest.update(buffer.subarray(0,n));count+=n;}
      need(same(identity(first),identity(fs.fstatSync(fd,{bigint:true})))&&same(identity(first),identity(fs.lstatSync(temporary,{bigint:true}))),'same retained source body');
      const hash=digest.digest('hex'),filename=String(bodies.size+1).padStart(4,'0')+'-'+hash+'.original',reference={path:'service-pack-bodies/objects/'+filename,bytes:count,sha256:hash};
      fs.renameSync(temporary,path.join(bodyDirectory,'objects',filename));fs.unlinkSync(path.join(scratch,'package'));fs.rmdirSync(scratch);
      // The sole output's complete held size proves the unwritten reservation
      // remainder has no physical archive; no second temporary body exists.
      settleOriginalReservation(token,count,true);bodies.set(reference.path,reference);
      append({kind:'actual-pack-body',role:'selected-input-source-tar',name,path:temporary,canonicalPath:bodyCanonical,identity:identity(first),sourceRoot:source,destinationRoot:destination,copiedRecords,reference});return reference;
    }catch(failure){error=failure;throw failure;}finally{if(fd!==undefined){try{fs.closeSync(fd);}catch(failure){if(!error)throw failure;}}if(error){try{fs.unlinkSync(path.join(scratch,'package'));fs.rmdirSync(scratch);}catch(_){} /* Unknown/partial body remains fully reserved. */}}
  }
  function readManifest(file, inputRole) { return JSON.parse(readOriginal(file, inputRole).toString('utf8')); }
  function retainBuffer(data, inputRole) {
    active(); role(inputRole); need(Buffer.isBuffer(data) && data.length >= 0 && data.length <= limits.metadataBytes, 'bounded actual manifest buffer');
    const reference = objectBuffer(data); append({ kind: 'actual-buffer', role: inputRole, reference }); return reference;
  }
  function event(value) {
    active(); need(value && typeof value === 'object' && !Array.isArray(value), 'actual resolution event required');
    // This records resolution mechanics; reader replay must rejoin actual
    // manifest references and source roots, never trust edge booleans as proof.
    append({ kind: 'actual-resolution-event', ...value });
  }
  function retainBody(file, inputRole, name) {
    active(); filePath(file); need(['seed-npm-pack', 'public-package-tar', 'final-service-pack'].includes(inputRole), 'fixed actual body role');
    need(bodyDirectory && typeof remainingBytes === 'function', 'actual body directory and parent remaining ledger required');
    if (inputRole === 'public-package-tar') need(typeof name === 'string' && name.length <= 256, 'actual public package identity required');
    const canonical = fs.realpathSync(file), fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let first, target, temporary, count = 0; const digests = ['sha256', 'sha1', 'sha512'].map(algorithm => crypto.createHash(algorithm));
    try {
      first = fs.fstatSync(fd, { bigint: true });
      need(first.isFile() && first.size > 0n && first.size <= BigInt(limits.packedBytes), 'bounded actual pack body');
      append({ kind: 'actual-pack-body-stat', role: inputRole, name: name || null, path: file, canonicalPath: canonical, identity: identity(first), bytes: Number(first.size) });
      const actualRemaining = remainingBytes();
      if (first.size > BigInt(actualRemaining)) {
        const error = new Error('Service pack originals: pending actual pack-body-retention-budget-exhausted:' + inputRole);
        // The actual FD stat is already held, and no body byte has been read.
        // Parent raw retention preserves finite capacity evidence even when no
        // complete collection can be sealed. Never print the candidate path.
        const diagnostic = {kind:'actual-service-pack-body-budget-refused',role:inputRole,ordinal:bodies.size+1,bytes:Number(first.size),remainingBytes:actualRemaining,authorityVerified:false,bodyRetained:false};
        try { process.stderr.write('SERVICE_PACK_BODY_BUDGET '+JSON.stringify(diagnostic)+'\n'); } catch (_) { /* Preserve the original budget refusal. */ }
        throw error;
      }
      temporary = path.join(bodyDirectory, 'objects', '.pending-' + records.length);
      target = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const buffer = Buffer.alloc(limits.rangeBytes);
      while (true) {
        active(); const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break;
        count += size; need(count <= Number(first.size), 'actual body grew'); const block = buffer.subarray(0, size); reserveBytes(size);
        let written = 0; while (written < size) { active(); const n = fs.writeSync(target, block, written, size - written); need(n > 0, 'body write made no progress'); written += n; }
        digests.forEach(digest => digest.update(block));
      }
      fs.fsyncSync(target); active();
      need(count === Number(first.size) && same(identity(first), identity(fs.fstatSync(fd, { bigint: true }))) && fs.realpathSync(file) === canonical && same(identity(first), identity(fs.statSync(canonical, { bigint: true }))), 'actual body input identity changed');
    } finally { if (target !== undefined) fs.closeSync(target); fs.closeSync(fd); }
    const digest = digests[0].digest('hex'), filename = String(bodies.size + 1).padStart(4, '0') + '-' + digest + '.original';
    const reference = { path: 'service-pack-bodies/objects/' + filename, bytes: count, sha256: digest };
    const destination = path.join(bodyDirectory, 'objects', filename);
    // Each actual role has its own physical copy, even if the bytes happen to
    // match another stage. Every copy has already been charged before writing.
    fs.renameSync(temporary, destination); bodies.set(reference.path, reference);
    const value = { kind: 'actual-pack-body', role: inputRole, name: name || null, path: file, canonicalPath: canonical, identity: identity(first), reference, shasum: digests[1].digest('hex'), integrity: 'sha512-' + digests[2].digest('base64') };
    append(value); return value;
  }
  function seal(value = {}) {
    active(); need(Buffer.byteLength(JSON.stringify(value)) <= 65536, 'bounded original collection details'); const collection = { schemaVersion: 1, kind: 'actual-service-pack-manifest-inputs', sourceSha, scope: 'same-invocation byte and resolution observations only', authorityVerified: false, originals: [...objects.values()], bodyOriginals: [...bodies.values()], records, details: { ...value, inputCustodyModel: 'actual-service-pack-input-custody-v2',publicInputCustodyModel:'actual-selected-public-input-source-v1' } };
    const data = Buffer.from(JSON.stringify(collection, null, 2) + '\n'); need(data.length <= limits.metadataBytes, 'bounded final original collection');
    const padded = size => Math.ceil(size / 512) * 512;
    const metadataTarBound = 2048 + 512 + padded(data.length) + [...objects.values()].reduce((sum, row) => sum + 512 + padded(row.bytes), 0);
    need(metadataTarBound <= limits.metadataBytes, 'metadata transport aggregate bound');
    metadataStart();
    const fd = fs.openSync(path.join(directory, 'materials.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { for (let at = 0; at < data.length; at += limits.rangeBytes) { active(); const block = data.subarray(at, at + limits.rangeBytes); reserveBytes(block.length); let written = 0; while (written < block.length) { active(); const count = fs.writeSync(fd, block, written, block.length - written); need(count > 0, 'collection write made no progress'); written += count; } } fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    finished = true; return Object.freeze({ path: 'materials.json', bytes: data.length, sha256: sha(data) });
  }
  return Object.freeze({ readOriginal, readManifest, probePath, copyTree, capturePublicPack, retainBuffer, retainBody, event, seal, close: closeInputs, execFileSync });
}
module.exports = { createServicePackOriginals };
