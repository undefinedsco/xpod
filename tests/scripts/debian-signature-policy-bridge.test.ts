import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {inspectRetainedDebianGpgvExit,inspectDebianSignaturePolicyOriginals} from '../../scripts/lib/independent-admission/debian-signature-policy-bridge';
const read=(name:string)=>readFileSync(fileURLToPath(new URL('../fixtures/independent-admission/debian-bookworm-backports/'+name,import.meta.url)));
function originals(){return {inRelease:read('InRelease.original'),status:read('status.original.raw'),plaintext:read('body.original'),exit:2,acquisitionUTC:Date.parse('2026-10-18T00:00:00Z'),indexPaths:['main/source/Sources.xz']};}
it('retains the actual producer exit without converting nonzero observation into signature success',()=>{
 expect(inspectRetainedDebianGpgvExit(0,0)).toBe(0);expect(inspectRetainedDebianGpgvExit(2,2)).toBe(2);
 for(const [actual,supervised]of [[2,0],[0,2],[1,1],[3,3],[-9,-9],[null,null],[true,true]])expect(()=>inspectRetainedDebianGpgvExit(actual,supervised)).toThrow('fixed gpgv');
 // Retention alone does not classify status or manufacture a capability.
 expect(()=>inspectDebianSignaturePolicyOriginals({...originals(),status:Buffer.from('metadata approved')})).toThrow();
});
it('routes actual independently executed gpgv originals through the sole strict TS suite/key/status policy',()=>{
 const result=inspectDebianSignaturePolicyOriginals(originals());expect(result.codename).toBe('bookworm-backports');expect(result.role).toBe('backports');expect(result.signers).toEqual(['B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8']);expect(result.nonAuthorityCoSignatures).toEqual(['B8E5F13176D2A7A75220028078DBA3BC47EF2265']);
});
it('rejects plaintext substitution, generic exit2 allowance, unsigned tails and expired or mixed suites',()=>{
 const original=originals();
 for(const changed of [{plaintext:Buffer.from('unsigned replacement')},{status:Buffer.from('[GNUPG:] NEWSIG\n[GNUPG:] ERRSIG 78DBA3BC47EF2265 1 8 01 1792246505 9 B8E5F13176D2A7A75220028078DBA3BC47EF2265\n[GNUPG:] NO_PUBKEY 78DBA3BC47EF2265\n')},{status:Buffer.concat([original.status,Buffer.from('[GNUPG:] FAILURE arbitrary 1\n')])},{exit:0},{exit:1},{inRelease:Buffer.concat([original.inRelease,Buffer.from('unsigned trailing')])},{acquisitionUTC:Date.parse('2026-10-25')},{indexPaths:['unknown/source/Sources']}])expect(()=>inspectDebianSignaturePolicyOriginals({...original,...changed})).toThrow();
});
