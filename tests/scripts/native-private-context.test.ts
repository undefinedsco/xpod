import { describe, expect, it } from 'vitest';
import { collectMacNativeRuntimeContext, collectLinuxNativeRuntimeContext, controlledNativeRuntimeView } from '../../scripts/lib/independent-admission/native-context';
import { verifyCollectedNativeAdmission } from '../../scripts/lib/independent-admission/native-admission';
describe('private native custody boundaries', () => {
  it('rejects serialized native material and product claims before issuing runtime authority', async () => {
    const claims = { sourceSha: 'a'.repeat(40), target: 'darwin-arm64', status: 'verified', runtimeAbiVerified: true };
    expect(controlledNativeRuntimeView(claims)).toBeUndefined();
    await expect(collectMacNativeRuntimeContext({ artifact: claims as any, nativeOriginals: claims, source: claims })).rejects.toThrow('independent observed macOS originals');
    await expect(collectLinuxNativeRuntimeContext({ artifact: claims as any, nativeOriginals: { ...claims, target: 'linux-x64' }, source: claims })).rejects.toThrow('independent reviewed Linux CSS');
    const result = verifyCollectedNativeAdmission({ passed: true }, { sourceSha: claims.sourceSha, target: claims.target,
      package: '@undefineds.co/xpod-css-darwin-arm64', version: '0.0.1', runHeadSha: claims.sourceSha, readTracked: () => Buffer.alloc(0), readOriginal: () => Buffer.alloc(0), nativeMaterials: claims, collectedArtifact: claims });
    expect(result.status).toBe('pending');
    expect(result.facts.nativeRuntimeAbiVerified).toBe(false);
    expect(result.facts.nativeQualified).toBe(false);
  });
});
