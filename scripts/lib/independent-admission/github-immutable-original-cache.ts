/** Only immutable Git contents responses are reusable. Run/job/artifact status
 * always comes from a fresh request; callers receive copies of original bytes. */
const entries=new Map<string,Buffer>();
let resident=0;
const maximumBytes=64*1024**2,maximumEntries=512;
export function immutableGitContentsEndpoint(endpoint:string):boolean {
 return /^https:\/\/api\.github\.com\/repos\/undefinedsco\/xpod\/contents\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\?ref=[a-f0-9]{40}$/u.test(endpoint)
   && !endpoint.split('/').some(part=>part==='..'||part==='.');
}
export function cachedGitContentsOriginal(endpoint:string):Buffer|undefined {
 if(!immutableGitContentsEndpoint(endpoint))return undefined;
 const body=entries.get(endpoint);if(!body)return undefined;
 entries.delete(endpoint);entries.set(endpoint,body);return Buffer.from(body);
}
export function retainGitContentsOriginal(endpoint:string,body:Buffer):void {
 if(!immutableGitContentsEndpoint(endpoint)||body.length>2*1024**2)return;
 const prior=entries.get(endpoint);if(prior){resident-=prior.length;entries.delete(endpoint);}
 while(entries.size>=maximumEntries||resident+body.length>maximumBytes){const first=entries.keys().next().value;if(first===undefined)break;resident-=entries.get(first)!.length;entries.delete(first);}
 entries.set(endpoint,Buffer.from(body));resident+=body.length;
}
