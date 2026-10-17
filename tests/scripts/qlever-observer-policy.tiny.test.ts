import {test,expect} from 'bun:test';
import {qleverObserverCompanionBindings,QLEVER_OBSERVER_V20} from '../../scripts/lib/independent-admission/qlever-observer-policy';
test('old observer policies stay separate while v20 binds both imported helpers exactly',()=>{
 expect(qleverObserverCompanionBindings('79e34893b946458a904544ddb1cce9110a19fe5052503570c865341e7d0ff6d6')).toHaveLength(0);
 expect(qleverObserverCompanionBindings('a92b227ec186a0f53f85c93a732a0542ee3b712fdb571308395ecf17c07b2d86')).toHaveLength(0);
 const next=qleverObserverCompanionBindings(QLEVER_OBSERVER_V20);
 expect(next.map(row=>row.path)).toEqual(['qlever/scripts/macos_companion_originals.py','qlever/scripts/macos_dependency_inventory.py']);
 expect(next.map(row=>row.sha256)).toEqual(['c5597e1a395229e3043cd8a6ed3178205453cdd535f7b2f0b58149a3bb7f1971','c3ca6c3133667ff2e464cb4a0c4fe49f16a827980f7bc7864737975bf4541c83']);
 expect(()=>qleverObserverCompanionBindings('0'.repeat(64))).toThrow('Unreviewed');
});
