import {candidateServiceNativeRuntimeOriginalsView} from './candidate-service-native-runtime-originals';
import {candidateServiceRuntimeArtifactView} from './candidate-service-runtime-artifact';
import {nativeOriginalsView} from './native-original-collector';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';

/** Exactly the four private handles a caller already holds. This binding adds
 * no capability, registry entry or whole-service-source qualification. */
export interface CandidateServiceNativeContext {
  readonly qualification: unknown;
  readonly originals: unknown;
  readonly sdkOriginals: unknown;
  readonly sdkAdmission: unknown;
}

const PREFIX = '/opt/xpod/qlever', ROOT = '/opt/xpod/qlever/';
function need(value: unknown, why: string): asserts value {if (!value) throw Error('Candidate service native source context: ' + why);}
function memberShape(value: any): void {
  need(value && typeof value === 'object' && typeof value.path === 'string' && value.path.length > 0
    && !value.path.endsWith('/') && !/[\u0000-\u001f\u007f\\]/u.test(value.path)
    && (value.type === 'file' || value.type === 'directory' || value.type === 'symlink')
    && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0, 'typed absolute member');
  if (value.type === 'directory') need(value.bytes === 0, 'directory bytes are zero');
  else if (value.type === 'symlink') need(value.bytes === 0 && typeof value.target === 'string' && value.target.length > 0, 'symlink member/target');
  else need(/^[a-f0-9]{64}$/u.test(value.sha256), 'file member sha256');
}

/** Bind the existing native/runtime/relationship views for the exact service
 * originals. Identity is cross-sealed here; no service image is compared with
 * the local runtime image, which is a different artifact. */
export function bindCandidateServiceNativeSource(input: {
  serviceOriginals: unknown; source: unknown; runtimeArtifact: unknown;
  nativeContext: CandidateServiceNativeContext; budget: {check(): void};
}) {
  need(input && typeof input === 'object', 'binding input');
  const budget = input.budget, serviceOriginals = input.serviceOriginals, source = input.source;
  const artifact = input.runtimeArtifact, supplied = input.nativeContext;
  need(budget && typeof budget.check === 'function', 'observation budget');
  need(supplied && typeof supplied === 'object', 'immutable native context input');
  const context: CandidateServiceNativeContext = Object.freeze({
    qualification: supplied.qualification, originals: supplied.originals,
    sdkOriginals: supplied.sdkOriginals, sdkAdmission: supplied.sdkAdmission,
  });
  need([context.qualification, context.originals, context.sdkOriginals, context.sdkAdmission]
    .every(handle => handle !== null && typeof handle === 'object'), 'four private native handles');
  budget.check();
  const obtain = () => {
    const nativeView = candidateServiceNativeRuntimeOriginalsView(
      context.qualification, context.originals, source, context.sdkOriginals, context.sdkAdmission);
    const runtimeView = candidateServiceRuntimeArtifactView(artifact, serviceOriginals, source);
    need(nativeView, 'issued native runtime originals view required');
    need(runtimeView, 'issued service runtime artifact view required');
    return {nativeView, runtimeView};
  };
  const relationship = readCandidateServiceRelationship(serviceOriginals) as any;
  need(relationship && relationship.master && relationship.master.images
    && relationship.master.images.localRuntime && relationship.master.images.service, 'qualified relationship images');
  const validate = (nativeView: any, runtimeView: any) => {
    budget.check();nativeView.assertCurrent(); runtimeView.assertCurrent();
    const nativeOriginals=nativeOriginalsView(context.originals),locator=relationship.master.nativeRuntimeArtifact;
    need(nativeOriginals&&locator&&nativeOriginals.originFacts.artifactId===locator.artifactId
      &&nativeOriginals.originFacts.artifactSha256===locator.artifactSha256,'same related native original artifact');
    const master=nativeOriginals.members.find(row=>row.path==='materials.json');
    need(locator.master?.path==='materials.json'&&master&&master.bytes===locator.master.bytes
      &&master.sha256===locator.master.sha256,'same related native master original');
    const nativeIdentity = nativeView.identity, runtimeIdentity = runtimeView.identity;
    need(nativeIdentity && runtimeIdentity, 'native and runtime identities');
    for (const identity of [nativeIdentity, runtimeIdentity]) {
      need(identity.sourceSha === relationship.sourceSha && identity.runId === relationship.runId
        && identity.runAttempt === relationship.runAttempt, 'native/runtime/relationship source coordinates differ');
    }
    need(nativeIdentity.target===relationship.target&&nativeIdentity.sdkProfile==='service-trixie','native target/profile differs');
    need(nativeIdentity.sdkImage === relationship.sdkImage, 'native SDK image differs from qualified SDK');
    need(nativeIdentity.runtimeImage === relationship.master.localRuntimeImageReferenceByDigest, 'native runtime image differs');
    need(nativeIdentity.runtimeConfigDigest === relationship.master.images.localRuntime.configDigest, 'native runtime config digest differs');
    need(runtimeIdentity.imageDigest === relationship.master.serviceImageReferenceByDigest
      &&runtimeIdentity.imageConfigDigest===relationship.master.images.service.configDigest, 'service runtime image/config differs');
    need(Array.isArray(nativeView.members) && nativeView.members.length > 0, 'native member inventory');
    need(Array.isArray(runtimeView.members) && runtimeView.members.length > 0, 'runtime member inventory');
    const nativeMembers = new Map<string, any>(), runtimeMembers = new Map<string, any>();
    for (const row of nativeView.members) {
      budget.check();memberShape(row);
      need(row.path.startsWith(ROOT) && row.path.length > ROOT.length
        && !row.path.slice(1).split('/').some((part:string) => part === '' || part === '.' || part === '..'), 'native member outside /opt/xpod/qlever');
      need(!nativeMembers.has(row.path), 'duplicate native member');
      nativeMembers.set(row.path, row);
    }
    for (const row of runtimeView.members) {
      budget.check();memberShape(row);
      if (row.path === PREFIX) { need(row.type === 'directory', 'runtime root is a directory'); continue; }
      if (!row.path.startsWith(ROOT)) continue;
      need(!runtimeMembers.has(row.path), 'duplicate runtime member');
      runtimeMembers.set(row.path, row);
    }
    need(runtimeMembers.size === nativeMembers.size, 'native/runtime /opt/xpod/qlever closedset differs');
    for (const [path, row] of nativeMembers) {
      const other = runtimeMembers.get(path);
      need(other && other.type === row.type && other.mode === row.mode && other.bytes === row.bytes, 'native/runtime member differs: ' + path);
      if (row.type === 'file') need(other.sha256 === row.sha256, 'file bytes/sha256 differ: ' + path);
      if (row.type === 'symlink') need(other.target === row.target, 'symlink target differs: ' + path);
    }
    return nativeMembers;
  };
  const initial = obtain();
  const nativeMembers = validate(initial.nativeView, initial.runtimeView);
  const origins = Object.freeze([...nativeMembers.values()]
    .filter((row: any) => row.type === 'file')
    .sort((left: any, right: any) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((row: any) => Object.freeze({path: row.path, kind: 'native-runtime' as const,
      runtimePath: row.path.slice(ROOT.length), original: context.qualification})));
  const assertCurrent = () => {
    budget.check();
    const next = obtain();
    need(next.nativeView === initial.nativeView && next.runtimeView === initial.runtimeView, 'issued views changed identity');
    need(readCandidateServiceRelationship(serviceOriginals) === relationship, 'relationship identity/seal changed');
    validate(next.nativeView, next.runtimeView);budget.check();
  };
  assertCurrent();
  return Object.freeze({nativeContext: context, origins, assertCurrent});
}
