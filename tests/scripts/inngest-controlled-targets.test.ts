/** Pure real-policy selectors only; no private authority or target execution. */
import {describe,expect,it} from 'vitest';
import policy from '../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import {controlledInngestTarget,controlledInngestTools,assertControlledInngestBinaryHeader,controlledTargetBinding} from '../../scripts/lib/inngest-controlled-materials';
describe('controlled Inngest native target descriptors',()=>{
 it('selects four pinned native tool pairs from the single policy and rejects unknown targets',()=>{
  expect(Object.keys(policy.targetDescriptors).sort()).toEqual(['darwin-arm64','darwin-x64','linux-arm64','linux-x64']);
  for(const target of Object.keys(policy.targetDescriptors)){const d=controlledInngestTarget(target),tools=controlledInngestTools(target);expect(target).toBe(d.platform+'-'+d.arch);expect(Object.keys(tools).sort()).toEqual(['go','node','pnpm']);expect(tools.go.sha256).toMatch(/^[a-f0-9]{64}$/u);expect(tools.node.sha256).toMatch(/^[a-f0-9]{64}$/u);expect(tools.pnpm.integrity.startsWith('sha512-')).toBe(true);}
  for(const target of ['windows-x64','linux-amd64','darwin-arm64/../linux-arm64'])expect(()=>controlledInngestTarget(target)).toThrow();
 });
 it('requires matching ELF or Mach-O CPU header and rejects every cross-target header',()=>{
  for(const target of Object.keys(policy.targetDescriptors)){
   const format=controlledInngestTarget(target).binaryFormat,header=Buffer.alloc(64);
   if('machine' in format){Buffer.from([127,69,76,70,2,1]).copy(header);header.writeUInt16LE(format.machine,18);}else{header.writeUInt32LE(0xfeedfacf,0);header.writeUInt32LE(format.cpuType,4);}
   assertControlledInngestBinaryHeader(header,target);
   for(const other of Object.keys(policy.targetDescriptors))if(other!==target)expect(()=>assertControlledInngestBinaryHeader(header,other)).toThrow();
   expect(()=>assertControlledInngestBinaryHeader(header.subarray(0,63),target)).toThrow();
  }
 });
 it('only preserves the historical Linux arm64 absent target binding',()=>{
  expect(controlledTargetBinding(undefined,'linux-arm64')).toBe(true);
  for(const target of Object.keys(policy.targetDescriptors)){expect(controlledTargetBinding(target,target)).toBe(true);if(target!=='linux-arm64')expect(controlledTargetBinding(undefined,target)).toBe(false);expect(controlledTargetBinding('unknown',target)).toBe(false);}
 });
});
