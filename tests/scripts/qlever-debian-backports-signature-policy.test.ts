import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {extractDebianSignedRelease,inspectDebianReleaseSuite,inspectDebianGpgvStatus,DEBIAN_BOOKWORM_KEYS} from '../../scripts/lib/independent-admission/qlever-debian-signature-policy';
const directory=new URL('../fixtures/independent-admission/debian-bookworm-backports/',import.meta.url);
const read=(name:string)=>readFileSync(fileURLToPath(new URL(name,directory)));
const at=Date.parse('2026-10-18T00:00:00Z');
it('binds actual independently fetched backports original to real gpgv plaintext/status and existing archive12 key only',()=>{
 const index=JSON.parse(read('originals.index.json').toString()) as {path:string;bytes:number;sha256:string}[];
 for(const row of index){const bytes=read(row.path);expect(bytes.length).toBe(row.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);}
 const body=extractDebianSignedRelease(read('InRelease.original'));expect(body.equals(read('body.original'))).toBe(true);
 const suite=inspectDebianReleaseSuite(body,at,['main/source/Sources.xz']);expect(suite.codename).toBe('bookworm-backports');expect(suite.role).toBe('backports');expect(suite.validUntilPresent).toBe(true);
 const status=inspectDebianGpgvStatus(read('status.original.raw'),suite.role,at,JSON.parse(read('exit.original.json').toString()).gpgvActualExit,true);
 expect(status.signers).toEqual([DEBIAN_BOOKWORM_KEYS[0]!.primary]);expect(status.nonAuthorityCoSignatures).toEqual(['B8E5F13176D2A7A75220028078DBA3BC47EF2265']);
});
it('rejects origin/label/codename/suite mixing, missing expiry and actual job times outside the signed window',()=>{
 const body=read('body.original');
 for(const [from,to]of [['Origin: Debian Backports','Origin: Debian'],['Label: Debian Backports','Label: Debian'],['Codename: bookworm-backports','Codename: trixie-backports'],['Suite: oldstable-backports','Suite: stable-backports']])expect(()=>inspectDebianReleaseSuite(Buffer.from(body.toString().replace(from,to)),at,['main/source/Sources'])).toThrow('suite');
 expect(()=>inspectDebianReleaseSuite(Buffer.from(body.toString().replace(/^Valid-Until:.*\n/mu,'')),at,['main/source/Sources'])).toThrow('requires Valid-Until');
 for(const date of ['2026-10-17T00:00:00Z','2026-10-25T00:00:00Z'])expect(()=>inspectDebianReleaseSuite(body,Date.parse(date),['main/source/Sources'])).toThrow('valid');
 expect(()=>inspectDebianReleaseSuite(body,at,['main/binary-amd64/Packages.xz'])).toThrow('component');
});
it('rejects stable-release/security key roles and unknown-only approvals for backports',()=>{
 const base=JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/independent-admission/debian-bookworm-keys/official-gpgv-status.json',import.meta.url)),'utf8')) as {observations:{status:string}[]};
 expect(()=>inspectDebianGpgvStatus(Buffer.from(base.observations[0]!.status),'backports',at,2,true)).toThrow('reviewed');
 expect(()=>inspectDebianGpgvStatus(Buffer.from(base.observations[2]!.status),'backports',at,2,true)).toThrow('reviewed');
 const status=read('status.original.raw').toString();const unknown=status.slice(status.indexOf('[GNUPG:] NEWSIG',status.indexOf('[GNUPG:] NEWSIG')+1));
 expect(()=>inspectDebianGpgvStatus(Buffer.from('[GNUPG:] PLAINTEXT 74 0 \n'+unknown),'backports',at,2,true)).toThrow('exit/status');
 expect(()=>inspectDebianGpgvStatus(Buffer.from(status),'backports',at,0,true)).toThrow('exit/status');
 expect(()=>inspectDebianGpgvStatus(Buffer.from(status+'[GNUPG:] BADSIG 78DBA3BC47EF2265\n'),'backports',at,2,true)).toThrow();
});
