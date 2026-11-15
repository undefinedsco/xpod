import {test,expect} from 'bun:test';
import {canonicalServiceRegistryTarball,observeCandidateServiceRegistryOriginal,observeVerifierRegistryOriginal,VERIFIER_REGISTRY_ORIGINAL_PACKAGES,registryLegalOriginalArchiveModes} from '../../scripts/lib/independent-admission/legal-registry-originals';
test('new service URL contract covers exact scoped/unscoped/prerelease without extending legacy verifier scope',async()=>{
 expect(canonicalServiceRegistryTarball('negotiate','1.0.1')).toBe('https://registry.npmjs.org/negotiate/-/negotiate-1.0.1.tgz');
 expect(canonicalServiceRegistryTarball('@scope/name','1.2.3-rc.1')).toBe('https://registry.npmjs.org/@scope/name/-/name-1.2.3-rc.1.tgz');
 for(const [name,version] of [['../name','1.0.0'],['@scope/name?x','1.0.0'],['name','latest'],['name','1.0.0#x'],['name','1.0.0/other'],['https://else/name','1.0.0']])expect(()=>canonicalServiceRegistryTarball(name,version)).toThrow();
 expect(VERIFIER_REGISTRY_ORIGINAL_PACKAGES.length).toBe(6);await expect(observeVerifierRegistryOriginal({source:{},name:'negotiate',version:'1.0.1'})).rejects.toThrow('outside fixed');expect(registryLegalOriginalArchiveModes({})).toBeUndefined();
 let touched=false;await expect(observeCandidateServiceRegistryOriginal({originals:{},source:{},pack:{facts:{officialSelectedPayloadVerified:true}},name:'negotiate',version:'1.0.1',budget:{check(){touched=true;},remainingMs(){return 1;},reserveBytes(){touched=true;}}})).rejects.toThrow('same private');expect(touched).toBe(false);
});
