import type { NativeFile } from '../physical-module-native';
import { collectedArtifactView } from './artifact-collector';
import { createHash } from 'node:crypto';

/** Bounded view of one exact registered product member. It owns no native,
 * source, or release admission authority. Every range is bound to the central
 * collector's same open snapshot fd and a full-member SHA check. */
export interface ProductOriginalView {
  readonly reference: Readonly<NativeFile>;
  readRange(offset: number, length: number): Buffer;
}
const issued = new WeakMap<object, { artifact: unknown; reference: Readonly<NativeFile> }>();
const fail = (message: string): never => { throw Error('Collected product original: ' + message); };

export function collectedProductOriginal(artifact: unknown, reference: Readonly<NativeFile>): ProductOriginalView {
  const view = collectedArtifactView(artifact);
  if (!view) return fail('real collected artifact capability required');
  const member = view.members.find(row => row.path === reference?.path);
  if (!member || reference.sizeBytes !== member.bytes || reference.sha256 !== member.sha256) fail('exact registered member reference required');
  const bound = Object.freeze({ path: member!.path, sizeBytes: member!.bytes, sha256: member!.sha256 });
  const readRange = (offset: number, length: number): Buffer => {
    if (collectedArtifactView(artifact) !== view) return fail('artifact revoked');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || length > 65536 || offset > bound.sizeBytes || length > bound.sizeBytes - offset) return fail('fixed 64KiB bounded range required');
    if (view.readMemberRange) return view.readMemberRange(bound.path, offset, length);
    if (bound.sizeBytes > 8 * 1024 ** 2) return fail('bounded disk range collector required');
    const bytes = view.readMember(bound.path, 8 * 1024 ** 2);
    if (bytes.length !== bound.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== bound.sha256) fail('member changed');
    return Buffer.from(bytes.subarray(offset, offset + length));
  };
  // A zero-length request still performs the full-member hash before issuance.
  readRange(0, 0);
  const result = Object.freeze({ reference: bound, readRange });
  issued.set(result, { artifact, reference: bound }); return result;
}

/** Native adapters use this identity check before admitting observer results.
 * A structural clone remains usable as a test byte reader, never as authority. */
export function collectedProductOriginalBinding(value: unknown): Readonly<{ artifact: unknown; reference: Readonly<NativeFile> }> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const binding = issued.get(value);
  return binding && collectedArtifactView(binding.artifact) ? Object.freeze({ ...binding }) : undefined;
}
