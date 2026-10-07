import { parseMembershipAuthorityBinding, type MembershipAuthorityBinding } from './canonicalRoomSource';
import { MatrixError } from './MatrixError';

export interface NamedCanonicalRead {
  readonly sourceIri: string;
  readonly sourcePodId: string;
  readonly sourceRoot: string;
  readonly ownerWebId: string;
  readonly binding: MembershipAuthorityBinding;
}
interface NamedCanonicalReadInput extends NamedCanonicalRead {
  fetch: typeof fetch;
  beforeRequest: () => Promise<void>;
}
const readers = new WeakMap<object, Pick<NamedCanonicalReadInput, 'fetch' | 'beforeRequest'>>();

/** Internal capability; never a caller-supplied fetch or a substitute Solid caller session. */
export async function createNamedCanonicalRead(input: NamedCanonicalReadInput): Promise<NamedCanonicalRead> {
  const binding = parseMembershipAuthorityBinding(input.binding);
  if (!binding || typeof input.beforeRequest !== 'function' || typeof input.fetch !== 'function') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'An explicit named canonical transport is required');
  }
  await input.beforeRequest();
  const capability = Object.freeze({ sourceIri: input.sourceIri, sourcePodId: input.sourcePodId,
    sourceRoot: input.sourceRoot, ownerWebId: input.ownerWebId, binding: Object.freeze(binding) });
  readers.set(capability, { fetch: input.fetch, beforeRequest: input.beforeRequest });
  return capability;
}
export function namedCanonicalTransport(capability: NamedCanonicalRead): Pick<NamedCanonicalReadInput, 'fetch' | 'beforeRequest'> {
  const transport = readers.get(capability);
  if (!transport) throw new MatrixError(403, 'M_FORBIDDEN', 'The named canonical read capability is not internal');
  return transport;
}
