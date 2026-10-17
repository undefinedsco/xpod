import { test, expect } from 'bun:test';
import { collectNativeAdmissionOriginals, nativeOriginalsView } from './native-original-collector';
test('native original custody rejects serialized origins before filesystem access',async()=>{
  expect(nativeOriginalsView({})).toBeUndefined();
  expect(nativeOriginalsView(null)).toBeUndefined();
  await expect(collectNativeAdmissionOriginals({githubOrigin:{} as never,acquisitionRoot:'/must-not-read'})).rejects.toThrow('registered independent native origin required');
});
