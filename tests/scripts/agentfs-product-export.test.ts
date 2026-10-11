import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProduct, validateCliProduct, projectProductBuild, exportProducts } from '../../scripts/agentfs-native-ci/mounted/export-products';

const source = 'a'.repeat(40);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const manifest = { name: '@undefineds.co/xpod-cli', version: '1', bin: { xpod: './dist/bin/xpod' }, exports: {
  './client': { types: './dist/client.d.ts', import: './dist/client.mjs', require: './dist/client.cjs' },
  './build-tools': { types: './dist/tools.d.ts', import: './dist/tools.mjs', require: './dist/tools.cjs' },
  './producer-materials': './dist/producer-materials/index.json',
} };
const pack = `import tarfile,io,json,hashlib,sys
manifest=json.loads(sys.argv[2]);change=sys.argv[3];files={}
for n in ['dist/xpod.mjs','dist/bin/xpod','LICENSE','README.md','dist/client.d.ts','dist/client.mjs','dist/client.cjs','dist/tools.d.ts','dist/tools.mjs','dist/tools.cjs']:files[n]=b'payload'
files['package.json']=json.dumps(manifest).encode()
original=b'original';source=io.BytesIO()
with tarfile.open(fileobj=source,mode='w:gz') as t:
 m=tarfile.TarInfo('src/main.ts');m.size=len(original);t.addfile(m,io.BytesIO(original if change!='nested-source' else b'replaced'))
producer={'source-inventory.json':json.dumps({'schemaVersion':1,'files':[{'path':'src/main.ts','bytes':len(original),'sha256':hashlib.sha256(original).hexdigest()}]}).encode(),'client-source.tar.gz':source.getvalue()}
index={'producer':{'name':manifest['name'],'version':manifest['version']},'sourceAuthority':{'sourceCommit':'a'*40,'dirty':False,'snapshotSHA256':'b'*64,'scope':'Package source snapshot only; no claim of release acceptance or dependency closure.'},'clientPayloads':{'cjsSHA256':hashlib.sha256(b'payload').hexdigest(),'esmSHA256':hashlib.sha256(b'payload').hexdigest()},'clientSource':'client-source.tar.gz','sourceInventory':'source-inventory.json','files':[{'path':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in producer.items()]}
if change=='unknown-source':index['sourceAuthority']['sourceCommit']=None
if change=='authority-injection':index['sourceAuthority']['credentials']={'argv':['private-marker']}
if change=='authority-snapshot-type':index['sourceAuthority']['snapshotSHA256']={'token':'private-marker'}
if change=='dirty':index['sourceAuthority']['dirty']=True
if change=='unbound-client':index['clientPayloads']['cjsSHA256']='0'*64
if change=='material-hash':index['files'][0]['sha256']='0'*64
for n,b in producer.items():files['dist/producer-materials/'+n]=b
files['dist/producer-materials/index.json']=json.dumps(index).encode()
if change=='extra-material':files['dist/producer-materials/unlisted']=b'extra'
if change=='missing-type':del files['dist/tools.d.ts']
if change=='missing-bin':del files['dist/bin/xpod']
with tarfile.open(sys.argv[1],'w:gz') as t:
 for n,b in files.items():
  m=tarfile.TarInfo('package/'+n);m.size=len(b);m.mode=0o755 if n=='dist/bin/xpod' else 0o644;t.addfile(m,io.BytesIO(b))
 if change in ['duplicate','symlink','escape','control']:
  m=tarfile.TarInfo({'duplicate':'package/LICENSE','symlink':'package/link','escape':'package/../outside','control':'package/bad\\nname'}[change])
  if change=='symlink':m.type=tarfile.SYMTYPE;m.linkname='/private'
  t.addfile(m)
`;
async function fixture(change: string, action: (archive: string, root: string) => Promise<void> | void) {
  const parent = path.resolve('.test-data/agentfs-product-export'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-')); const archive = path.join(root, 'cli.tgz');
  try { execFileSync('python3', ['-c', pack, archive, JSON.stringify(manifest), change]); await action(archive, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
describe('exact product export', () => {
  const commands = ['bun run build:packages', 'bun packages/xpod-afs/scripts/build-package.ts', 'bun build module-admission.ts --target=node --format=esm'];
  const receipt = { sourceSHA: source, sourceClean: true, exit: 0, coreSHA256: hash('payload'), driverSHA256: hash('driver'), commands, metafiles: [] };
  it('projects exact safe build commands and drops build-only metadata', () => {
    const projected = projectProductBuild(receipt, source);
    expect(projected).toEqual({ sourceSHA: source, sourceClean: true, exit: 0, coreSHA256: hash('payload'), driverSHA256: hash('driver'), commands });
    expect(Object.keys(projected)).not.toContain('metafiles');
  });
  for (const injected of [ { commands: ['private-marker'] }, { commands: { argv: 'private-marker' } }, { credentials: { token: 'private-marker' } }, { driverSHA256: { token: 'private-marker' } } ]) {
    it('rejects injected build receipt before actual exporter writes any product', () => fixture('', async (archive, root) => {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
      git('init', '--quiet'); writeFileSync(path.join(root, '.gitignore'), '*\n!.gitignore\n'); git('add', '--', '.gitignore'); git('commit', '--quiet', '-m', 'fixture');
      const actualSHA = git('rev-parse', 'HEAD'); const build = path.join(root, 'build.safe.json');
      writeFileSync(build, JSON.stringify({ ...receipt, sourceSHA: actualSHA, ...injected }));
      const out = path.join(root, 'product-export');
      await expect(exportProducts(root, archive, archive, archive, 'darwin-arm64', actualSHA, build, out)).rejects.toThrow('invalid product build receipt');
      expect(existsSync(out)).toBe(false);
    }));
  }
  it('validates actual serialized public payloads, types and nested producer source', () => fixture('', async (archive, root) => {
    const value = await validateCliProduct(archive, path.join(root, 'materials'), source, hash('payload'), manifest);
    expect(value.name).toBe(manifest.name); expect(value.files['dist/tools.d.ts'].sha256).toBe(hash('payload'));
    expect(Object.keys(value.producerSourceAuthority).sort()).toEqual(['dirty', 'scope', 'snapshotSHA256', 'sourceCommit']);
    expect(value.producerSourceAuthority.sourceCommit).toBe(source);
  }));
  for (const change of ['authority-injection', 'authority-snapshot-type', 'unknown-source', 'dirty', 'unbound-client', 'material-hash', 'extra-material', 'missing-type', 'missing-bin', 'nested-source']) {
    it(`rejects actual ${change} product`, () => fixture(change, async (archive, root) => {
      await expect(validateCliProduct(archive, path.join(root, 'materials'), source, hash('payload'), manifest)).rejects.toThrow();
    }));
  }
  for (const change of ['duplicate', 'symlink', 'escape', 'control']) {
    it(`rejects actual ${change} tar members`, () => fixture(change, (archive, root) => {
      expect(() => scanProduct(archive, path.join(root, 'materials'))).toThrow();
    }));
  }
  it('rejects a packed core different from the actual mounted core', () => fixture('', async (archive, root) => {
    await expect(validateCliProduct(archive, path.join(root, 'materials'), source, hash('different'), manifest)).rejects.toThrow('payload mismatch');
  }));
  it('keeps product artifact separate from safe consumer evidence and success gated', () => {
    const workflow = readFileSync('.github/workflows/agentfs-module-mounted-acceptance.yml', 'utf8');
    expect(workflow).toContain("if: steps.products.outcome == 'success'");
    expect(workflow).toContain('afs-module-products-${{ matrix.target }}-${{ github.sha }}');
    expect(workflow).toContain('/product-export/'); expect(workflow).toContain('/export/');
    expect(workflow).toContain('bun pm pack --filename "$MODULE_RUN_ROOT/cli.tgz" --ignore-scripts');
  });
});
