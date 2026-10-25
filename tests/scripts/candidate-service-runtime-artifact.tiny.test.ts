import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectCandidateServiceRuntimeArchive, candidateServiceRuntimeArtifactView } from '../../scripts/lib/independent-admission/candidate-service-runtime-artifact';

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
