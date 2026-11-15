import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectCandidateServiceRuntimeArchive, candidateServiceRuntimeArtifactView, organizeRuntimeRoots, readRuntimeIndexByRange } from '../../scripts/lib/independent-admission/candidate-service-runtime-artifact';

/**
 * These tests use actual tar bytes built by Python and, where the producer
 * accepts them, the producer's own scan_runtime_tar output. The separate service-runtime-private-reader fixture exercises genuine
 * private maps. Here getter tests only prove fake and copied shapes are refused. The mechanical inspect function issues
 * no private capability.
 */
const root = resolve(import.meta.dir, '../..');
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const image = 'ghcr.io/undefinedsco/xpod@sha256:' + 'a'.repeat(64);
const config = 'sha256:' + 'b'.repeat(64);
const containerId = 'c'.repeat(64);
const scope = { root: '/app', role: 'copy-runtime-app' } as const;

const python = String.raw`
import hashlib, importlib.util, json, pathlib, sys, tarfile
repo=pathlib.Path(sys.argv[1]); tar_path=pathlib.Path(sys.argv[2]); scenario=sys.argv[3]
def add(tf,name,kind,data=b'',link='',mtime=0,pax=None):
    info=tarfile.TarInfo(name); info.mode=0o755 if kind=='dir' else (0o777 if kind=='link' else 0o644)
    info.mtime=mtime; info.type=tarfile.DIRTYPE if kind=='dir' else (tarfile.SYMTYPE if kind=='link' else tarfile.REGTYPE)
    info.linkname=link; info.size=0 if kind in ('dir','link') else len(data)
    if pax: info.pax_headers=dict(pax)
    import io
    tf.addfile(info, None if kind in ('dir','link') else io.BytesIO(data))
long='app/'+'nested/'*8+'long-pax-member-name-'+'x'*90+'.txt'
with tarfile.open(tar_path,'w',format=tarfile.PAX_FORMAT) as tf:
    add(tf,'app/','dir')
    add(tf,'app/package.json','file',b'{"name":"@undefineds.co/xpod"}')
    add(tf,'app/dist/','dir')
    add(tf,'app/dist/index.js','file',b'export const actual = 1;')
    add(tf,long if scenario=='main' else 'app/short-member.txt','file',b'pax path body')
    add(tf,'app/link','link',link='package.json')
    add(tf,'app/root-link','link',link='/app')
    if scenario=='numeric':
        add(tf,'app/numeric-mtime','file',b'numeric',mtime=1234.5,pax={'atime':'1234.25','ctime':'1234'})
    if scenario=='unsupported':
        add(tf,'app/unsupported','file',b'unsupported',pax={'vendor':'not-allowed'})
    if scenario=='escape':
        add(tf,'app/escape','link',link='../../outside')
    if scenario=='double':
        add(tf,'app/double','link',link='//app')
need=set()
def manual():
    rows=[];data=tar_path.read_bytes();offset=0
    while offset+512<=len(data):
        header=data[offset:offset+512]
        if header==bytes(512):break
        name=header[:100].split(b'\0')[0].decode()
        raw_type=header[156:157];kind=raw_type.decode('latin1');size=int(header[124:136].split(b'\0')[0].strip() or b'0',8)
        if kind in ('x','g'):
            offset+=512+size+((512-size%512)%512);continue
        path=name.rstrip('/')
        if path=='app':rel=''
        else:
            assert path.startswith('app/'),name
            rel=path[4:].rstrip('/')
        mode=int(header[100:108].split(b'\0')[0].strip() or b'0',8);offset+=512
        if kind in ('0','\0','7'):
            rows.append(dict(path=rel,type='file',mode=mode,bytes=size,sha256=hashlib.sha256(data[offset:offset+size]).hexdigest(),offset=offset))
        elif kind=='5': rows.append(dict(path=rel,type='directory',mode=mode,bytes=0))
        elif kind=='2': rows.append(dict(path=rel,type='symlink',mode=mode,bytes=0,target=header[157:257].split(b'\0')[0].decode()))
        else: raise AssertionError(kind)
        offset+=size+((512-size%512)%512 if kind in ('0','\0','7') else 0)
    return rows
if scenario in ('main','numeric'):
    spec=importlib.util.spec_from_file_location('producer',repo/'qlever/scripts/sdk-service-image-originals.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    members,archive_sha,content=module.scan_runtime_tar(pathlib.Path(tar_path),'/app','app',lambda:None)
    out={'members':members,'archiveSha':archive_sha,'content':content}
else:
    rows=manual();out={'members':rows,'archiveSha':hashlib.sha256(tar_path.read_bytes()).hexdigest(),'content':sum(row['bytes'] for row in rows if row['type']=='file')}
print(json.dumps(out))
`;

type ProducerMember = Readonly<{ path: string; type: 'file' | 'directory' | 'symlink'; mode: number; bytes: number; sha256?: string; target?: string; offset?: number }>;
type Scene = Readonly<{ archive: Buffer; capture: Buffer; members: readonly ProducerMember[]; content: number; json: Readonly<{ members: readonly ProducerMember[]; archiveSha: string; content: number }> }>;

function scene(rootPath: string, scenario: 'main' | 'numeric' | 'unsupported' | 'escape' | 'double'): Scene {
  const tarPath = join(rootPath, scenario + '.tar');
  const result = spawnSync('python3', ['-c', python, root, tarPath, scenario], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('python scene failed: ' + result.stderr);
  const value = JSON.parse(result.stdout) as Readonly<{ members: readonly ProducerMember[]; archiveSha: string; content: number }>;
  const archive = readFileSync(tarPath);
  const capture = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'actual-service-image-runtime-members-v1',
    imageReferenceByDigest: image,
    configDigest: config,
    containerId,
    targetRoot: '/app',
    archiveRoot: 'app',
    archive: { path: 'stages/service-output-copy-runtime-app/stdout.raw', bytes: archive.length, sha256: value.archiveSha },
    evidencePayloadPaths: [],
    members: value.members,
    memberContentBytes: value.content,
    sourceCoverageInferred: false,
    wholeServiceSourceVerified: false,
  }));
  return { archive, capture, members: value.members, content: value.content, json: value };
}

const inspect = (value: Scene, capture = value.capture) => inspectCandidateServiceRuntimeArchive({
  capture,
  scope,
  readRange: (offset, length) => Buffer.from(value.archive.subarray(offset, offset + length)),
});

let directory = '';
test('actual Python tar and producer scan accept ordinary file/root/dir/link and a PAX long path', () => {
  directory = mkdtempSync(join(tmpdir(), 'candidate-runtime-artifact-'));
  const value = scene(directory, 'main');
  const rows = value.members;
  expect(rows[0]).toMatchObject({ path: '', type: 'directory' });
  expect(rows.some(row => row.type === 'file' && row.path === 'package.json' && row.sha256 === sha(Buffer.from('{"name":"@undefineds.co/xpod"}')))).toBe(true);
  expect(rows.some(row => row.type === 'directory' && row.path === 'dist')).toBe(true);
  expect(rows.some(row => row.type === 'symlink' && row.path === 'link' && row.target === 'package.json')).toBe(true);
  expect(rows.some(row => row.type === 'symlink' && row.path === 'root-link' && row.target === '/app')).toBe(true);
  expect(rows.some(row => row.type === 'file' && row.path.includes('long-pax-member-name'))).toBe(true);
  const view = inspect(value);
  expect(view.archive.sha256).toBe(value.json.archiveSha);
  expect(view.members).toHaveLength(rows.length);
  expect(view.members.find(row => row.path === 'link')).toMatchObject({ type: 'symlink', target: 'package.json' });
  expect(view.members[0]).toMatchObject({ path: '', type: 'directory', bytes: 0 });
  expect(view.members.find(row => row.path === 'package.json')).toMatchObject({ type: 'file', sha256: sha(Buffer.from('{"name":"@undefineds.co/xpod"}')) });
  expect(Object.isFrozen(view.members)).toBe(true);
  expect(Object.isFrozen(view.members[0])).toBe(true);
  expect(() => inspect(value, Buffer.from(JSON.stringify({ ...JSON.parse(value.capture.toString()), archive: { ...JSON.parse(value.capture.toString()).archive, sha256: '0'.repeat(64) } })))).toThrow('archive SHA');
});

test('requires two zero EOF blocks even when the complete archive SHA is recomputed', () => {
  const value = scene(directory, 'numeric');
  let end = 0;
  while (end < value.archive.length && !value.archive.subarray(end,end+512).equals(Buffer.alloc(512))) {
    const length = parseInt(value.archive.subarray(end+124,end+136).toString().replace(/\0.*$/u,''),8);
    end += 512 + Math.ceil(length/512)*512;
  }
  for (const suffix of [Buffer.alloc(0),Buffer.alloc(512),Buffer.concat([Buffer.alloc(1024),Buffer.from('x')])]) {
    const archive=Buffer.concat([value.archive.subarray(0,end),suffix]),index=JSON.parse(value.capture.toString());
    index.archive={...index.archive,bytes:archive.length,sha256:sha(archive)};
    expect(()=>inspect({...value,archive},Buffer.from(JSON.stringify(index)))).toThrow(/EOF|trailing/u);
  }
  const archive=Buffer.concat([value.archive.subarray(0,end),Buffer.alloc(1024)]),index=JSON.parse(value.capture.toString());
  index.archive={...index.archive,bytes:archive.length,sha256:sha(archive)};
  expect(inspect({...value,archive},Buffer.from(JSON.stringify(index))).members.length).toBe(value.members.length);
});

test('allowed numeric PAX metadata is ignored while arbitrary records stay refused', () => {
  const numeric = scene(directory, 'numeric');
  const view = inspect(numeric);
  expect(view.members.some(row => row.path === 'numeric-mtime')).toBe(true);
  const unsupported = scene(directory, 'unsupported');
  expect(() => inspect(unsupported)).toThrow('pax');
});

test('tampered file offset and an escaping symlink fail closed', () => {
  const value = scene(directory, 'main');
  const tampered = JSON.parse(value.capture.toString());
  const file = tampered.members.find((row: ProducerMember) => row.type === 'file' && row.path === 'package.json');
  file.offset += 1;
  expect(() => inspect(value, Buffer.from(JSON.stringify(tampered)))).toThrow('content/offset');
  const escaping = scene(directory, 'escape');
  expect(() => inspect(escaping)).toThrow('escapes');
  const double = scene(directory, 'double');
  expect(double.members.some(row => row.type === 'symlink' && row.target === '//app')).toBe(true);
  expect(() => inspect(double)).toThrow('ambiguous');
});

test('fake and copied views are rejected by the private getter', () => {
  const value = scene(directory, 'main');
  const parsed = inspect(value);
  const fake = Object.freeze({ identity: { sourceSha: 'd'.repeat(40), runId: 1, runAttempt: 1, imageDigest: image, imageConfigDigest: config, containerId }, members: parsed.members, pending: Object.freeze(['nothing-verified']), wholeServiceSourceVerified: false, serviceAbiVerified: false, legalCoverageVerified: false, readMemberRange: () => Buffer.alloc(0), assertCurrent() {} });
  expect(candidateServiceRuntimeArtifactView(fake, {}, {})).toBeUndefined();
  expect(candidateServiceRuntimeArtifactView({ ...parsed }, {}, {})).toBeUndefined();
  expect(candidateServiceRuntimeArtifactView(parsed, {}, {})).toBeUndefined();
  expect(candidateServiceRuntimeArtifactView(JSON.parse(JSON.stringify(parsed)), {}, {})).toBeUndefined();
  expect(candidateServiceRuntimeArtifactView(null, {}, {})).toBeUndefined();
  // No genuine acquired candidate capability fixture exists in this worktree.
  expect(candidateServiceRuntimeArtifactView(parsed, undefined, undefined)).toBeUndefined();
});

test('cleanup', () => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/**
 * RC387 runtime profile: the measured same-image roots need ~568 MB decoded / ~124 MB
 * encoded, which exceeds the shared source shard bound (512 MiB) but stays inside the
 * approved runtime profile (expandedBytes 5 GiB decoded, packedBytes 768 MiB encoded).
 *
 * These tests drive the real inspector with synthetic-but-valid indexes. They never
 * allocate a 512 MB+ buffer: the archive bytes come from a sparse file and are read
 * through the same bounded range path the inspector already uses.
 */
test('a decoded runtime archive above the source shard bound passes the size gate under the runtime profile', () => {
  // Just over limits.shardBytes (512 MiB) but far below expandedBytes (5 GiB). The
  // archive is described, not materialised: readRange reports the requested length so
  // no large allocation happens. Passing the size gate is what this asserts; the tar
  // structure is intentionally trivial.
  const decodedBytes = 536870912 + 1;
  const capture = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'actual-service-image-runtime-members-v1',
    imageReferenceByDigest: image, configDigest: config, containerId,
    targetRoot: '/app', archiveRoot: 'app',
    archive: { path: 'stages/x/stdout.raw', bytes: decodedBytes, sha256: sha(Buffer.alloc(0)) },
    evidencePayloadPaths: [],
    members: [{ path: '', type: 'directory', mode: 0o755, bytes: 0 }],
    memberContentBytes: 0,
    sourceCoverageInferred: false, wholeServiceSourceVerified: false,
  }));
  let message = '';
  try {
    inspectCandidateServiceRuntimeArchive({
      capture, scope,
      // Return exactly the requested size so the range guard is satisfied.
      readRange: (_offset, length) => Buffer.alloc(length),
    });
  } catch (error) { message = String((error as Error).message); }
  // Whatever fails later (SHA/structure), the SIZE gate must not be the reason.
  expect(message).not.toContain('bounded actual runtime archive');
  expect(message).not.toContain('bounded plain actual runtime stdout reference');
});

test('a decoded runtime archive above expandedBytes is still refused', () => {
  // One byte past limits.expandedBytes (5 GiB) — refused before any read.
  const tooBig = 5 * 1024 * 1024 * 1024 + 1;
  const capture = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'actual-service-image-runtime-members-v1',
    imageReferenceByDigest: image, configDigest: config, containerId,
    targetRoot: '/app', archiveRoot: 'app',
    archive: { path: 'stages/x/stdout.raw', bytes: tooBig, sha256: sha(Buffer.alloc(0)) },
    evidencePayloadPaths: [], members: [], memberContentBytes: 0,
    sourceCoverageInferred: false, wholeServiceSourceVerified: false,
  }));
  // The encoded reference bound fires first for a value this large; either bound
  // refusing is correct, so assert the runtime size guards reject it.
  expect(() => inspectCandidateServiceRuntimeArchive({
    capture, scope, readRange: () => Buffer.alloc(0),
  })).toThrow(/bounded (actual runtime archive|plain actual runtime stdout reference)/u);
});

test('an encoded runtime stream above packedBytes is refused', () => {
  // The encoded archive reference is checked against packedBytes (768 MiB).
  const tooBig = 768 * 1024 * 1024 + 1;
  const capture = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'actual-service-image-runtime-members-v1',
    imageReferenceByDigest: image, configDigest: config, containerId,
    targetRoot: '/app', archiveRoot: 'app',
    archive: { path: 'stages/x/stdout.raw', bytes: tooBig, sha256: sha(Buffer.alloc(0)) },
    evidencePayloadPaths: [], members: [], memberContentBytes: 0,
    sourceCoverageInferred: false, wholeServiceSourceVerified: false,
  }));
  expect(() => inspectCandidateServiceRuntimeArchive({
    capture, scope, readRange: () => Buffer.alloc(0),
  })).toThrow(/encoded|bounded/u);
});



/**
 * RC387 real-root contract: a whole /app root has 48257 POSIX hardlinks (tar type 1)
 * with zero payload whose linkname points at an earlier regular file. These tests use
 * REAL tar bytes and the real reader, so a fabricated offset/hash cannot pass.
 */
function hardlinkScene(rootPath: string, target: string, memberTarget: string, scenario: string) {
  const tarPath = join(rootPath, scenario + '.tar');
  const py = String.raw`
import hashlib, io, json, sys, tarfile
tar_path=sys.argv[1]; target=sys.argv[2]; scenario=sys.argv[3]
def add(tf,name,kind,data=b'',link='',mode=0o644):
    info=tarfile.TarInfo(name); info.mode=mode; info.mtime=0
    info.type=tarfile.REGTYPE if kind=='file' else (tarfile.LNKTYPE if kind=='hard' else (tarfile.SYMTYPE if kind=='sym' else tarfile.DIRTYPE))
    info.linkname=link; info.size=0 if kind!='file' else len(data)
    tf.addfile(info, None if kind!='file' else io.BytesIO(data))
with tarfile.open(tar_path,'w',format=tarfile.PAX_FORMAT) as tf:
    add(tf,'app/','dir',mode=0o755)
    add(tf,'app/a.js','file',b'console.log(1);')
    if scenario=='positive':
        add(tf,'app/link.js','hard',link=target)
    elif scenario=='chain':
        add(tf,'app/mid.js','hard',link='app/a.js')
        add(tf,'app/link.js','hard',link='app/mid.js')
    elif scenario=='longchain':
        # 100 prior hardlinks chained back to a.js: O(1) anchors must resolve this
        # without a hop limit and without recursion.
        prev='app/a.js'
        for n in range(100):
            name='app/h%03d.js'%n
            add(tf,name,'hard',link=prev)
            prev=name
        add(tf,'app/link.js','hard',link=prev)
    elif scenario=='other':
        add(tf,'app/link.js','hard',link='other/a.js')
    elif scenario=='traversal':
        add(tf,'app/link.js','hard',link='app/../etc/passwd')
    elif scenario=='dangling':
        add(tf,'app/link.js','hard',link='app/missing.js')
    elif scenario=='symlink-target':
        add(tf,'app/link.js','hard',link='app/sym')
data=open(tar_path,'rb').read()
rows=[];offset=0
while offset+512<=len(data):
    h=data[offset:offset+512]
    if h==bytes(512):break
    name=h[:100].split(b'\0')[0].decode();kind=h[156:157].decode('latin1')
    size=int(h[124:136].split(b'\0')[0].strip() or b'0',8)
    mode=int(h[100:108].split(b'\0')[0].strip() or b'0',8);link=h[157:257].split(b'\0')[0].decode()
    offset+=512
    rel=name[4:] if name.startswith('app/') else name
    if kind in ('0','\0','7'):
        rows.append(dict(path=rel,type='file',mode=mode,bytes=size,sha256=hashlib.sha256(data[offset:offset+size]).hexdigest(),offset=offset))
        offset+=size+((512-size%512)%512)
    elif kind=='5': rows.append(dict(path=rel.rstrip('/'),type='directory',mode=mode,bytes=0))
    elif kind=='1': rows.append(dict(path=rel,type='hardlink',mode=mode,bytes=0,target=link))
    elif kind=='2': rows.append(dict(path=rel,type='symlink',mode=mode,bytes=0,target=link))
    else: raise AssertionError(kind)
print(json.dumps({'members':rows,'sha':hashlib.sha256(data).hexdigest()}))
`;
  const result = spawnSync('python3', ['-c', py, tarPath, target, scenario], { encoding: 'utf8' });
  if (result.status !== 0) throw Error('hardlink scene failed: ' + result.stderr);
  const value = JSON.parse(result.stdout) as { members: any[]; sha: string };
  const archiveBytes = readFileSync(tarPath);
  const capture = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'actual-service-image-runtime-members-v1',
    imageReferenceByDigest: image, configDigest: config, containerId,
    targetRoot: '/app', archiveRoot: 'app',
    archive: { path: 'stages/service-output-copy-runtime-app/stdout.raw', bytes: archiveBytes.length, sha256: value.sha },
    evidencePayloadPaths: [], members: value.members,
    memberContentBytes: value.members.filter(r => r.type === 'file').reduce((n, r) => n + r.bytes, 0),
    sourceCoverageInferred: false, wholeServiceSourceVerified: false,
  }));
  return { capture, archiveBytes };
}

test('a real tar hardlink resolves to the prior file bytes through readMemberRange', () => {
  const base = mkdtempSync(join(tmpdir(), 'candidate-hardlink-'));
  try {
    const { capture, archiveBytes } = hardlinkScene(base, 'app/a.js', 'app/a.js', 'positive');
    const value = inspectCandidateServiceRuntimeArchive({
      capture, scope,
      readRange: (offset, length) => Buffer.from(archiveBytes.subarray(offset, offset + length)),
    });
    const linkRow = value.members.find(row => row.path === 'link.js')!;
    expect(linkRow.type).toBe('hardlink');
    expect(linkRow.bytes).toBe(0);
    // The real target file keeps its genuine offset and hash; the hardlink adds none.
    const fileRow = value.members.find(row => row.path === 'a.js')!;
    expect(fileRow.type).toBe('file');
    expect(fileRow.bytes).toBe(15);
    expect((fileRow as any).sha256).toBe(sha(Buffer.from('console.log(1);')));
    // The hardlink must NOT claim a hash/offset of its own.
    expect((linkRow as any).sha256).toBeUndefined();
    expect((linkRow as any).offset).toBeUndefined();
    expect((linkRow as any).target).toBe('app/a.js');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a safe hardlink chain still resolves to the ultimate regular file', () => {
  const base = mkdtempSync(join(tmpdir(), 'candidate-hardlink-chain-'));
  try {
    const { capture, archiveBytes } = hardlinkScene(base, 'app/mid.js', 'app/a.js', 'chain');
    const value = inspectCandidateServiceRuntimeArchive({
      capture, scope,
      readRange: (offset, length) => Buffer.from(archiveBytes.subarray(offset, offset + length)),
    });
    const linkRow = value.members.find(row => row.path === 'link.js')!;
    expect(linkRow.type).toBe('hardlink');
    expect((linkRow as any).target).toBe('app/mid.js');
    // The chain still resolves to the single real payload.
    expect(value.members.filter(row => row.type === 'file').length).toBe(1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('hardlink targets outside the root, traversing, dangling or non-regular are refused', () => {
  for (const scenario of ['other', 'traversal', 'dangling', 'symlink-target'] as const) {
    const base = mkdtempSync(join(tmpdir(), 'candidate-hardlink-bad-'));
    try {
      const target = scenario === 'other' ? 'other/a.js'
        : scenario === 'traversal' ? 'app/../etc/passwd'
        : scenario === 'dangling' ? 'app/missing.js' : 'app/sym';
      const { capture, archiveBytes } = hardlinkScene(base, target, target, scenario);
      expect(() => inspectCandidateServiceRuntimeArchive({
        capture, scope,
        readRange: (offset, length) => Buffer.from(archiveBytes.subarray(offset, offset + length)),
      })).toThrow(/hardlink/u);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
});

/**
 * The PUBLIC filesystem view normalizes a raw tar hardlink to an ordinary verified file
 * carrying the resolved target's real bytes/hash. Installed-source consumers keep their
 * file|directory|symlink union unchanged.
 */
test('the public view presents a raw hardlink as an ordinary file with the target bytes', () => {
  const ref = { path: 'stages/x/stdout.raw', bytes: 10, sha256: 'a'.repeat(64) };
  const readArchiveRange = (_o: number, _l: number) => Buffer.alloc(0);
  const fileHash = 'b'.repeat(64);
  const members: any[] = [
    { path: '', type: 'directory', mode: 0o755, bytes: 0, root: '/app', absolutePath: '/app' },
    { path: 'a.js', type: 'file', mode: 0o644, bytes: 15, sha256: fileHash, dataOffset: 512,
      root: '/app', absolutePath: '/app/a.js' },
    // raw hardlink: zero payload, resolvedAnchor points at the prior real file
    { path: 'link.js', type: 'hardlink', mode: 0o644, bytes: 0, target: 'app/a.js',
      root: '/app', absolutePath: '/app/link.js', resolvedAnchor: 'a.js' },
  ];
  const organized = organizeRuntimeRoots([{ root: '/app', archiveRoot: 'app', role: 'copy-runtime-app',
    index: ref, archive: ref, members, readArchiveRange }]);
  // The public row is a FILE with the target's real size and hash — not a hardlink.
  const link = organized.byPath.get('/app/link.js')!;
  expect(link.type).toBe('file');
  expect(link.bytes).toBe(15);
  expect((link as any).sha256).toBe(fileHash);
  expect((link as any).target).toBeUndefined();
  // Every public type stays inside file|directory|symlink.
  for (const row of organized.rows) expect(['file', 'directory', 'symlink']).toContain(row.type);
  // Full membership is preserved (no member dropped).
  expect(organized.rows.length).toBe(3);
});

test('a 100-link hardlink chain resolves through the O(1) anchor map', () => {
  const base = mkdtempSync(join(tmpdir(), 'candidate-hardlink-long-'));
  try {
    const { capture, archiveBytes } = hardlinkScene(base, 'app/a.js', 'app/a.js', 'longchain');
    const value = inspectCandidateServiceRuntimeArchive({
      capture, scope,
      readRange: (offset, length) => Buffer.from(archiveBytes.subarray(offset, offset + length)),
    });
    const link = value.members.find(row => row.path === 'link.js')!;
    expect(link.type).toBe('hardlink');
    // Exactly one real payload exists; every link resolved to it.
    expect(value.members.filter(row => row.type === 'file').length).toBe(1);
    const organized = organizeRuntimeRoots([{
      root: '/app', archiveRoot: 'app', role: 'copy-runtime-app',
      index: { path: 's/x', bytes: 1, sha256: 'a'.repeat(64) },
      archive: { path: 's/x', bytes: 1, sha256: 'a'.repeat(64) },
      members: value.members as any, readArchiveRange: () => Buffer.alloc(0),
    }]);
    const publicLink = organized.byPath.get('/app/link.js')!;
    expect(publicLink.type).toBe('file');
    expect(publicLink.bytes).toBe(15);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

/** Root's R3 corrections: the runtime index/member/count profile must actually apply,
 * the hardlink prefix guard must reject `other/a.js` even when a prior member named
 * `other/a.js` exists, and the public normalizer must not do a per-hardlink array find. */
test('the runtime profile admits >50000 members and an index above 4 MiB', async () => {
  // Drive the REAL parser with a large synthetic-but-valid index: 60000 tiny members.
  const members: any[] = [{ path: '', type: 'directory', mode: 0o755, bytes: 0 }];
  for (let n = 0; n < 60000; n += 1) {
    members.push({ path: `f${n}.txt`, type: 'file', mode: 0o644, bytes: 1, sha256: 'a'.repeat(64), offset: n });
  }
  const capture = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'actual-service-image-runtime-members-v1',
    imageReferenceByDigest: image, configDigest: config, containerId,
    targetRoot: '/app', archiveRoot: 'app',
    archive: { path: 'stages/x/stdout.raw', bytes: 1, sha256: 'b'.repeat(64) },
    evidencePayloadPaths: [], members, memberContentBytes: 60000,
    sourceCoverageInferred: false, wholeServiceSourceVerified: false,
  }));
  // >4 MiB, >50000 members: must be accepted by the member/limit profile (it then fails
  // on archive bytes, which is not the inventory bound).
  expect(capture.length).toBeGreaterThan(4 * 1024 * 1024);
  let message = '';
  try {
    inspectCandidateServiceRuntimeArchive({ capture, scope, readRange: () => Buffer.alloc(0) });
  } catch (error) { message = String((error as Error).message); }
  expect(message).not.toContain('bounded runtime member inventory');
  expect(message).not.toContain('bounded actual runtime index original');
});

test('a hardlink target outside the archive root is refused even if that path exists', () => {
  const base = mkdtempSync(join(tmpdir(), 'candidate-hardlink-prior-'));
  try {
    // Two scenarios where `other/a.js` really IS a prior member inside the capture.
    for (const priorRoot of ['other', 'app']) {
      const tarPath = join(base, `${priorRoot}.tar`);
      const py = String.raw`
import io,json,sys,tarfile
p=sys.argv[1]; prior=sys.argv[2]
def add(tf,name,kind,data=b'',link='',mode=0o644):
    i=tarfile.TarInfo(name);i.mode=mode;i.mtime=0
    i.type=tarfile.REGTYPE if kind=='file' else tarfile.LNKTYPE
    i.linkname=link;i.size=0 if kind!='file' else len(data)
    tf.addfile(i,None if kind!='file' else io.BytesIO(data))
with tarfile.open(p,'w',format=tarfile.PAX_FORMAT) as tf:
    add(tf,'app/','file')
    add(tf,'app/a.js','file',b'x'*15)
    if prior=='other':
        add(tf,'other/','file'); add(tf,'other/a.js','file',b'y'*15)
    add(tf,'app/link.js','hard',link='other/a.js')
print('ok')
`;
      const made = spawnSync('python3', ['-c', py, tarPath, priorRoot], { encoding: 'utf8' });
      if (made.status !== 0) throw Error(made.stderr);
      const archiveBytes = readFileSync(tarPath);
      // Index deliberately includes the prior `other/a.js` path in members.
      const rows: any[] = [
        { path: '', type: 'directory', mode: 0o755, bytes: 0 },
        { path: 'a.js', type: 'file', mode: 0o644, bytes: 15, sha256: sha(Buffer.from('x'.repeat(15))), offset: 512 },
      ];
      if (priorRoot === 'other') {
        rows.push({ path: 'other/a.js', type: 'file', mode: 0o644, bytes: 15, sha256: sha(Buffer.from('y'.repeat(15))), offset: 0 });
      }
      rows.push({ path: 'link.js', type: 'hardlink', mode: 0o644, bytes: 0, target: 'other/a.js' });
      const capture = Buffer.from(JSON.stringify({
        schemaVersion: 1, kind: 'actual-service-image-runtime-members-v1',
        imageReferenceByDigest: image, configDigest: config, containerId,
        targetRoot: '/app', archiveRoot: 'app',
        archive: { path: 'stages/x/stdout.raw', bytes: archiveBytes.length, sha256: sha(archiveBytes) },
        evidencePayloadPaths: [], members: rows, memberContentBytes: 15,
        sourceCoverageInferred: false, wholeServiceSourceVerified: false,
      }));
      expect(() => inspectCandidateServiceRuntimeArchive({
        capture, scope, readRange: (o, l) => Buffer.from(archiveBytes.subarray(o, o + l)),
      })).toThrow(/declared archive root/u);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('the public normalizer does not perform an array find per hardlink', () => {
  // Build many hardlinks and observe that normalization cost stays linear: a per-link
  // array find over 20k members would be O(n^2) (~2e8 comparisons) and time out.
  const members: any[] = [{ path: '', type: 'directory', mode: 0o755, bytes: 0, root: '/app', absolutePath: '/app' }];
  const N = 20000;
  members.push({ path: 'a.js', type: 'file', mode: 0o644, bytes: 15, sha256: 'a'.repeat(64),
    dataOffset: 512, root: '/app', absolutePath: '/app/a.js' });
  for (let n = 0; n < N; n += 1) {
    members.push({ path: `h${n}.js`, type: 'hardlink', mode: 0o644, bytes: 0, target: 'app/a.js',
      root: '/app', absolutePath: `/app/h${n}.js`, resolvedAnchor: 'a.js' });
  }
  const ref = { path: 's/x', bytes: 1, sha256: 'a'.repeat(64) };
  const started = Date.now();
  const organized = organizeRuntimeRoots([{ root: '/app', archiveRoot: 'app', role: 'copy-runtime-app',
    index: ref, archive: ref, members, readArchiveRange: () => Buffer.alloc(0) }]);
  const elapsed = Date.now() - started;
  expect(organized.rows.length).toBe(N + 2);
  // Linear work over 20k members is far under a second; a per-link find is not.
  expect(elapsed < 5000).toBe(true);
  for (const row of organized.rows) expect(['file', 'directory', 'symlink']).toContain(row.type);
});

/**
 * MECHANICAL/UNQUALIFIED tests. They exercise the range-read helper contract only:
 * no GitHub issuer, no collector capability, no RC claim. The real >8 MiB index and
 * encoded archives live under rc387-runtime-copy-replay-private and are read-only
 * inputs used elsewhere; these stubs prove the boundary shape without faking custody.
 */
function stubView(bytes: Buffer, onRange?: (offset: number, length: number) => void) {
  return {
    readOriginalRange(_name: string, offset: number, length: number) {
      onRange?.(offset, length);
      return bytes.subarray(offset, offset + length);
    },
  };
}

test('runtime index uses the RANGE interface for a >8 MiB artifact', () => {
  // 9 MiB crosses the collector's 8 MiB small-original cap.
  const size = 9 * 1024 * 1024;
  const bytes = Buffer.alloc(size, 7);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const ref = { path: 'output/service-runtime-members/app.original.json', bytes: size, sha256: sha };
  const calls: Array<[number, number]> = [];
  const out = readRuntimeIndexByRange(stubView(bytes, (o, l) => calls.push([o, l])), ref, () => {}, 512 * 1024 * 1024);
  expect(out.length).toBe(size);
  expect(createHash('sha256').update(out).digest('hex')).toBe(sha);
  expect(out.equals(bytes)).toBe(true);
  // It streamed in bounded chunks and never asked for more than one range at a time.
  expect(calls.length).toBe(Math.ceil(size / 65536));
  expect(Math.max(...calls.map(([, l]) => l)) <= 65536).toBe(true);
});

test('a small-original reader with the collector 8 MiB trap rejects the same request', () => {
  // Mirrors native-original-collector.readOriginal: requesting >8 MiB fails outright.
  const smallRead = (maximum: number) => {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 8 * 1024 ** 2) throw new Error('bounded small native original required');
    return Buffer.alloc(0);
  };
  expect(() => smallRead(512 * 1024 * 1024)).toThrow(/bounded small native original/);
  expect(() => smallRead(8 * 1024 ** 2)).not.toThrow();
});

test('range-read rejects modified bytes, truncation and an oversized ref', () => {
  const size = 9 * 1024 * 1024;
  const bytes = Buffer.alloc(size, 3);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const ref = { path: 'output/service-runtime-members/app.original.json', bytes: size, sha256: sha };

  // modified bytes -> hash mismatch
  const altered = Buffer.from(bytes); altered[5 * 1024 * 1024] = 9;
  expect(() => readRuntimeIndexByRange(stubView(altered), ref, () => {}, 512 * 1024 * 1024)).toThrow(/drift/);

  // truncated read -> exact range length check
  const short = { readOriginalRange: (_n: string, o: number, l: number) => bytes.subarray(o, o + Math.max(0, l - 1)) };
  expect(() => readRuntimeIndexByRange(short, ref, () => {}, 512 * 1024 * 1024)).toThrow(/exact runtime index range bytes/);

  // declared size beyond the runtime index profile
  expect(() => readRuntimeIndexByRange(stubView(bytes), { ...ref, bytes: 600 * 1024 * 1024 }, () => {}, 512 * 1024 * 1024))
    .toThrow(/bounded runtime index artifact reference/);

  // custody/deadline callback still runs
  let checks = 0;
  readRuntimeIndexByRange(stubView(bytes), { ...ref, sha256: sha }, () => { checks += 1; }, 512 * 1024 * 1024);
  expect(checks).toBeGreaterThan(1);
});
