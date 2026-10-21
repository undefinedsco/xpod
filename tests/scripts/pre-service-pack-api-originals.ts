/** Ordinary historical source bytes, never a source capability or runtime fallback. */
import originals from '../fixtures/independent-admission/pre-service-pack-api-originals.json';
import {createHash} from 'node:crypto';
export function preServicePackOriginal(name:string):Buffer|undefined{
 const row=originals.files.find(row=>row.path===name);if(!row)return undefined;
 const raw=Buffer.from(row.rawBase64,'base64');if(raw.length!==row.bytes||createHash('sha256').update(raw).digest('hex')!==row.sha256)throw Error('Historical pack API original drift');return raw;
}
