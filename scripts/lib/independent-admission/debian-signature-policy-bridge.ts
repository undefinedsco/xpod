import {createHash} from 'node:crypto';
import {extractDebianSignedRelease,inspectDebianReleaseSuite,inspectDebianGpgvStatus,type DebianReleaseFamily} from './qlever-debian-signature-policy';
function need(value:unknown,reason:string):asserts value {if(!value)throw Error('Debian signature policy bridge: '+reason);}
/** Narrow original-retention contract only. A retained gpgv exit 2 remains 2;
 * it confers no signature authority or successful verification. Callers must
 * separately bind the exact gpgv argv, wait, signal, raw and original custody. */
export function inspectRetainedDebianGpgvExit(actual:unknown,supervised:unknown):0|2 {
 need((actual===0||actual===2)&&supervised===actual,'same actual/supervised fixed gpgv exit 0 or 2 required');
 return actual;
}
/** Pure mechanics, never a registration/issuer. Only the existing controller
 * observer may supply independently executed gpgv originals and issue a fact.
 * Python producers preserve unclassified originals; they do not copy this
 * key/suite policy or turn exit 2 into an exit 0 receipt. */
export function inspectDebianSignaturePolicyOriginals(input:Readonly<{
 inRelease:Buffer;status:Buffer;plaintext:Buffer;exit:number;
 acquisitionUTC:number;indexPaths:readonly string[];family?:DebianReleaseFamily;
}>) {
 const body=extractDebianSignedRelease(input.inRelease);
 need(input.plaintext.length<=4*1024**2&&input.plaintext.equals(body),'actual gpgv plaintext differs from single signed envelope');
 const suite=inspectDebianReleaseSuite(body,input.acquisitionUTC,input.indexPaths,input.family);
 const signature=inspectDebianGpgvStatus(input.status,suite.role,input.acquisitionUTC,input.exit,true,input.family);
 return Object.freeze({...suite,...signature,verifiedBodySha256:createHash('sha256').update(body).digest('hex')});
}
