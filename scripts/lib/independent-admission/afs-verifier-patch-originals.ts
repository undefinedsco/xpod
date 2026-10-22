/** Mechanical unified-diff projection only. This never issues source or tool authority. */
const MAXIMUM = 8 * 1024 ** 2;
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('AFS verifier patch: ' + reason); }
const safe = (name: string) => Boolean(name) && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; before: string[]; after: string[] }
interface Target { path: string; hunks: Hunk[]; oldNoNewlineAt?: number; newNoNewlineAt?: number }
/** Strict existing-file textual diff subset used by the three reviewed Bun patches.
 * There is no fuzzy matching, offset search, shell patch process or script evaluation.
 */
export function applyVerifierUnifiedPatch(originals: ReadonlyMap<string, Buffer>, patch: Buffer): ReadonlyMap<string, Buffer> {
  need(patch.length > 0 && patch.length <= MAXIMUM && !patch.includes(0), 'bounded text patch required');
  const text = patch.toString('utf8'); need(Buffer.from(text).equals(patch) && text.endsWith('\n'), 'UTF-8 newline patch required');
  const lines = text.split('\n'); lines.pop();
  const targets: Target[] = []; let current: Target | undefined, i = 0;
  while (i < lines.length) {
    const line = lines[i++]!;
    if (line.startsWith('diff --git ') || /^index [a-f0-9]+\.\.[a-f0-9]+(?: [0-7]{6})?$/u.test(line)) continue;
    if (line.startsWith('--- a/')) {
      const name = line.slice(6); need(safe(name) && lines[i++] === '+++ b/' + name && !targets.some(row => row.path === name), 'canonical unique existing file target required');
      current = {path: name, hunks: []}; targets.push(current); continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line);
    need(header && current, 'unsupported patch record');
    const hunk: Hunk = {oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), newStart: Number(header[3]), newCount: Number(header[4] ?? 1), before: [], after: []};
    need([hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every(Number.isSafeInteger) && hunk.oldStart > 0 && hunk.newStart > 0, 'invalid hunk coordinates');
    let previous: string | undefined;
    while (i < lines.length && (/^[ +\-]/u.test(lines[i]!) || lines[i] === '\\ No newline at end of file') && !lines[i]!.startsWith('--- a/')) {
      const body = lines[i++]!;
      if (body === '\\ No newline at end of file') {
        need(previous, 'newline marker without body');
        if (previous !== '+') { need(current.oldNoNewlineAt === undefined, 'duplicate old newline marker'); current.oldNoNewlineAt = hunk.oldStart - 1 + hunk.before.length; }
        if (previous !== '-') { need(current.newNoNewlineAt === undefined, 'duplicate new newline marker'); current.newNoNewlineAt = hunk.newStart - 1 + hunk.after.length; }
        previous = undefined; continue;
      }
      const kind = body[0], value = body.slice(1); previous = kind;
      if (kind !== '+') hunk.before.push(value);
      if (kind !== '-') hunk.after.push(value);
    }
    need(hunk.before.length === hunk.oldCount && hunk.after.length === hunk.newCount, 'hunk line counts differ');
    current.hunks.push(hunk);
  }
  need(targets.length > 0 && targets.every(row => row.hunks.length), 'nonempty file hunks required');
  const result = new Map<string, Buffer>();
  for (const target of targets) {
    const original = originals.get(target.path);
    need(original && original.length <= MAXIMUM && !original.includes(0), 'bounded original file required:' + target.path);
    const source = original.toString('utf8'); need(Buffer.from(source).equals(original), 'UTF-8 original required');
    const hasNewline = source.endsWith('\n');
    const input = (hasNewline ? source.slice(0, -1) : source).split('\n'), output: string[] = []; let cursor = 0;
    need(target.oldNoNewlineAt === undefined ? hasNewline : !hasNewline && target.oldNoNewlineAt === input.length, 'upstream final newline differs');
    for (const hunk of target.hunks) {
      const at = hunk.oldStart - 1;
      need(at >= cursor && at + hunk.oldCount <= input.length, 'overlapping or out-of-bounds hunk');
      for (let index = cursor; index < at; index++) output.push(input[index]!);
      need(output.length === hunk.newStart - 1 && hunk.before.every((line, offset) => input[at + offset] === line), 'exact upstream preimage differs:' + target.path);
      for (const line of hunk.after) output.push(line); cursor = at + hunk.oldCount;
    }
    for (let index = cursor; index < input.length; index++) output.push(input[index]!);
    need(target.newNoNewlineAt === undefined || target.newNoNewlineAt === output.length, 'projected final newline position differs');
    const bytes = Buffer.from(output.join('\n') + (target.newNoNewlineAt === undefined ? '\n' : '')); need(bytes.length <= MAXIMUM, 'projected file exceeds bound'); result.set(target.path, bytes);
  }
  return result;
}

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { derivedSourceView, assertDerivedSourceCurrent } from './source-context';
import { registryLegalOriginalView, registryLegalLockEntries, VERIFIER_REGISTRY_ORIGINAL_PACKAGES } from './legal-registry-originals';
import { captureLegalFileIdentity, assertLegalFileIdentity } from './legal-file-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
export const AFS_VERIFIER_PATCH_PACKAGES: readonly string[] = VERIFIER_REGISTRY_ORIGINAL_PACKAGES;
const scripts = Object.freeze({
  'scripts/patch-jose.js': '7a2956ec29c71f00f5769718c6452d61a810c74c2ec5fab1a6a80c597c2dbd18',
  'scripts/patch-inrupt-authn-refresh.js': '08a2ad5753a3e0d8862f28c26ebed5e809c71cdb809e0d3e6f644f0ce30a8b1b',
  'scripts/patch-inrupt-authn-transport.js': '45ada339a237dcafc714f1c77fce313a97ae1f74d0e8986d7aa38dd10a955f04',
  'scripts/patch-inrupt-authn-operation-cleanup.js': '2ecdb915eb500f0c61646155ce3a8e19be7fcb40ea6897d7093349871da99487',
});
const diffs = Object.freeze({
  'oidc-provider@9.5.1': ['patches/oidc-provider@9.5.1.patch', 'ab20339bffd5ddb7041a79f83624da24baabedeabde95ee9f055cf091015b037'],
  '@undefineds.co/drizzle-solid@0.3.25': ['patches/@undefineds.co%2Fdrizzle-solid@0.3.25.patch', '15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789'],
  '@solid/community-server@8.0.0-alpha.1': ['patches/@solid%2Fcommunity-server@8.0.0-alpha.1.patch', '36b8796d16459344b6ee7b83f3cfd98d2325ef4cc144bb33e6a3710b6e234283'],
} satisfies Record<string, readonly string[]>);
interface PackageIdentity {readonly name: string; readonly version: string; readonly path: string; readonly logicalPaths?: readonly string[]}
interface SnapshotFile {readonly path: string; readonly kind: string; readonly bytes?: number; readonly sha256?: string; readonly target?: string}
/** One reviewed official-to-installed projection used by both whole-package
 * verification and selected service members. It issues no new capability.
 * The caller must still prove aliases, selected bytes/modes and full membership.
 */
export function projectReviewedInstalledPackage(input:{source:unknown;original:unknown;logicalPaths:readonly string[]}) {
 const source=derivedSourceView(input.source);need(source,'immutable private source required');assertDerivedSourceCurrent(input.source);
 const original=registryLegalOriginalView(input.original);need(original&&original.sourceSha===source.sourceSha,'same-source official original required');
 const lockBytes=source.readTracked('bun.lock'),lock=registryLegalLockEntries(lockBytes),pkg=JSON.parse(source.readTracked('package.json').toString());
 const item={name:original.name,version:original.version},identity=item.name+'@'+item.version;
 need(original.integrity===lock.get(identity)&&original.lockSha256===hash(lockBytes),'official patched package immutable SRI differs:'+identity);
 need(Array.isArray(input.logicalPaths)&&input.logicalPaths.length>0&&input.logicalPaths.every(safe),'actual logical instance paths required');
 const isTop=(name:string)=>input.logicalPaths.includes('node_modules/'+name);let changed=0;
    const sourceBytes = (name: string, expected: string) => { const bytes = source.readTracked(name); need(bytes.length <= MAXIMUM && hash(bytes) === expected, 'reviewed immutable patch source differs:' + name); return bytes; };
    const loaded = new Map<string, any>();
    const transform = (name: keyof typeof scripts) => {
      let module = loaded.get(name); if (module) return module;
      const bytes = sourceBytes(name, scripts[name]), filename = fileURLToPath(new URL('../../' + name.slice(8), import.meta.url));
      const identity = captureLegalFileIdentity(filename); need(identity.size <= BigInt(MAXIMUM) && readFileSync(filename).equals(bytes), 'reviewed local transform differs');
      // This exact local verifier file is fixed by reviewed SHA and immutable Git.
      // Candidate script bytes and caller-selected paths are never evaluated.
      delete require.cache[require.resolve(filename)]; module = require(filename); assertLegalFileIdentity(identity);
      need(readFileSync(filename).equals(bytes), 'reviewed transform changed while loading'); loaded.set(name, module); return module;
    };
      const expected = new Map(original.members.map(row => [row.path, {bytes: row.bytes, sha256: row.sha256}]));
      const modified = new Map<string, Buffer>();
      const read = (name: string) => {
        const prior = modified.get(name); if (prior) return prior;
        const row = expected.get(name); need(row && row.bytes <= MAXIMUM, 'bounded upstream patch target missing:' + name);
        const bytes = original.readMember(name); need(bytes.length === row.bytes && hash(bytes) === row.sha256, 'upstream original bytes differ'); return bytes;
      };
      const update = (name: string, project: (text: string) => string) => { const bytes = read(name), text = bytes.toString('utf8'); need(Buffer.from(text).equals(bytes), 'patch target UTF-8 differs'); const result = Buffer.from(project(text)); need(result.length <= MAXIMUM, 'projected patch target bound'); modified.set(name, result); };
      const diff = diffs[identity as keyof typeof diffs];
      if (diff) {
        need(pkg.patchedDependencies?.[identity] === diff[0], 'immutable Bun patch declaration differs');
        const patch = sourceBytes(diff[0]!, diff[1]!);
        const before = new Map<string, Buffer>();
        for (const line of patch.toString().split('\n').filter(line => line.startsWith('--- a/'))) before.set(line.slice(6), read(line.slice(6)));
        for (const [name, bytes] of applyVerifierUnifiedPatch(before, patch)) modified.set(name, bytes);
      } else need(!Object.prototype.hasOwnProperty.call(pkg.patchedDependencies ?? {},identity), 'unreviewed Bun patch version:' + identity);
      if (item.name === 'jose' && expected.has('dist/node/esm/index.js')) update('package.json', transform('scripts/patch-jose.js').patchPackageManifest);
      // The actual postinstall addresses the top-level core/browser package.
      // Nested copies are independent untouched originals, not silently patched.
      if (item.name === '@inrupt/solid-client-authn-core' && isTop(item.name)) {
        need(item.version === '3.1.1', 'unreviewed core patch version');
        const refresh = transform('scripts/patch-inrupt-authn-refresh.js'), transport = transform('scripts/patch-inrupt-authn-transport.js');
        update('src/authenticatedFetch/fetchFactory.ts', refresh.patchSource); for (const name of ['dist/index.js', 'dist/index.mjs']) update(name, refresh.patchBundle);
        for (const [name, kind] of [['src/authenticatedFetch/dpopUtils.ts', 'source'], ['src/authenticatedFetch/fetchFactory.ts', 'factory'], ['dist/authenticatedFetch/dpopUtils.d.ts', 'dts'], ['dist/index.js', 'cjs'], ['dist/index.mjs', 'esm']]) update(name!, text => transport.patchResourceDpop(text, kind));
      }
      if (item.name === '@inrupt/solid-client-authn-browser' && isTop(item.name)) {
        need(item.version === '3.1.1', 'unreviewed browser patch version');
        const transport = transform('scripts/patch-inrupt-authn-transport.js'), cleanup = transform('scripts/patch-inrupt-authn-operation-cleanup.js');
        for (const [name, method] of [['src/Session.ts', 'patchSessionSource'], ['src/dependencies.ts', 'patchDependenciesSource'], ['src/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.ts', 'patchHandlerSource'], ['dist/index.js', 'patchBundle'], ['dist/index.mjs', 'patchBundle'], ['dist/Session.d.ts', 'patchSessionDts'], ['dist/dependencies.d.ts', 'patchDependenciesDts'], ['dist/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.d.ts', 'patchHandlerDts']]) update(name!, transport[method!]);
        update('src/Session.ts', cleanup.patchSource); for (const name of ['dist/index.js', 'dist/index.mjs']) update(name, cleanup.patchBundle);
      }
      for (const [name, bytes] of modified) { const row = expected.get(name)!; if (hash(bytes) !== row.sha256) changed++; expected.set(name, {bytes: bytes.length, sha256: hash(bytes)}); }

 assertDerivedSourceCurrent(input.source);
 return Object.freeze({members:expected,changed,readMember(name:string){const raw=modified.get(name)??original.readMember(name),row=expected.get(name);need(row&&raw.length===row.bytes&&hash(raw)===row.sha256,'projected member bytes differ');return Buffer.from(raw);}});
}

/** Six reviewed package families only. The other installer inputs are reported
 * separately as controlled frozen-install facts, never as observed registry tars. */
export function inspectAfsVerifierPatchedPackages(input: {
  readonly source: unknown; readonly originals?: readonly unknown[];
  readonly packages: readonly PackageIdentity[]; readonly files: readonly SnapshotFile[];
}): Readonly<{verified: boolean; pending: readonly string[]; facts: Readonly<Record<string, unknown>>}> {
  const pending: string[] = [], facts: Record<string, unknown> = {}; let count = 0, changed = 0;
  try {
    const source = derivedSourceView(input.source); need(source, 'immutable private source required'); assertDerivedSourceCurrent(input.source);
    const lockBytes = source.readTracked('bun.lock'), lock = registryLegalLockEntries(lockBytes);
    const selected = input.packages.filter(row => AFS_VERIFIER_PATCH_PACKAGES.includes(row.name));
    need(selected.length > 0, 'actual patched package identities missing');
    for (const item of selected) {
      need(safe(item.path) && Array.isArray(item.logicalPaths) && item.logicalPaths.length > 0, 'snapshot package paths invalid');
      const resolve = (name: string): string => {
        need(safe(name), 'snapshot alias path invalid');
        for (let pass = 0; pass < 40; pass++) {
          const parts = name.split('/'); let replaced = false;
          for (let at = 1; at <= parts.length; at++) {
            const link = input.files.find(row => row.path === parts.slice(0, at).join('/') && row.kind === 'symlink');
            if (!link) continue;
            need(typeof link.target === 'string', 'snapshot alias target missing');
            name = path.posix.normalize(path.posix.join(path.posix.dirname(link.path), link.target, ...parts.slice(at)));
            need(safe(name), 'snapshot alias escapes root'); replaced = true; break;
          }
          if (!replaced) return name;
        }
        throw Error('AFS verifier patch: snapshot alias cycle');
      };
      need(item.logicalPaths.every(name => resolve(name + '/package.json') === item.path + '/package.json'), 'snapshot logical package alias differs');
      const identity = item.name + '@' + item.version;
      const candidates = (input.originals ?? []).map(cap => ({cap,view:registryLegalOriginalView(cap)})).filter(({view}) => view?.sourceSha === source.sourceSha && view.name === item.name && view.version === item.version);
      need(candidates.length === 1, 'official patched package original missing or ambiguous:' + identity); const original = candidates[0]!.view!;
      need(original.integrity === lock.get(identity) && original.lockSha256 === hash(lockBytes), 'official patched package immutable SRI differs:' + identity);
      const rows = input.files.filter(row => row.path.startsWith(item.path + '/') && !input.packages.some(other => other.path !== item.path && other.path.startsWith(item.path + '/') && row.path.startsWith(other.path + '/')));
      need(diffs[identity as keyof typeof diffs]||['jose','@inrupt/solid-client-authn-core','@inrupt/solid-client-authn-browser'].includes(item.name),'unreviewed Bun patch version:'+identity);
      const projection=projectReviewedInstalledPackage({source:input.source,original:candidates[0]!.cap,logicalPaths:item.logicalPaths!}),expected=projection.members;changed+=projection.changed;
      need(rows.length === expected.size && rows.every(row => { const actual = expected.get(row.path.slice(item.path.length + 1)); return row.kind === 'file' && actual && actual.bytes === row.bytes && actual.sha256 === row.sha256; }), 'actual package full byte universe differs from official patched projection:' + identity);
      count++;
    }
    assertDerivedSourceCurrent(input.source); facts.officialPatchedPackageProjectionVerified = true; facts.officialPatchedPackageInstances = count; facts.projectedChangedFiles = changed;
  } catch (error) { facts.officialPatchedPackageProjectionVerified = false; pending.push((error as Error).message); }
  return Object.freeze({verified: pending.length === 0, pending: Object.freeze(pending), facts: Object.freeze(facts)});
}
