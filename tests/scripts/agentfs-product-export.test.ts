import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import canonicalHostSources from '../../packages/xpod-cli/scripts/canonical-host-sources.json';
import { commands } from '../../scripts/agentfs-native-ci/mounted/producer-commands.json';
import { scanProduct, validateCliProduct, projectProductBuild, exportProducts, validateClientProduct } from '../../scripts/agentfs-native-ci/mounted/export-products';

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
original=b'original';source=io.BytesIO();host_names=json.loads(sys.argv[4])
source_files={'src/main.ts':original,**{'repository/src/'+n:b'canonical-host' for n in host_names}}
if change=='missing-host':source_files.pop('repository/src/'+host_names[0])
if change=='extra-host':source_files['repository/src/foreign.ts']=b'canonical-host'
if change=='changed-host':source_files['repository/src/'+host_names[0]]=b'changed-host'
source_rows=[{'path':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in source_files.items()]
with tarfile.open(fileobj=source,mode='w:gz') as t:
 for n,b in source_files.items():
  m=tarfile.TarInfo(n);m.size=len(b);t.addfile(m,io.BytesIO(b'replaced' if change=='nested-source' and n=='src/main.ts' else b))
producer={'source-inventory.json':json.dumps({'schemaVersion':1,'files':source_rows}).encode(),'client-source.tar.gz':source.getvalue()}
index={'producer':{'name':manifest['name'],'version':manifest['version']},'sourceAuthority':{'sourceCommit':'a'*40,'dirty':False,'snapshotSHA256':hashlib.sha256(json.dumps(source_rows,separators=(',',':')).encode()).hexdigest(),'scope':'CLI source plus explicitly mapped canonical host and runtime-client source; no claim of release acceptance or external dependency closure.'},'clientPayloads':{'cjsSHA256':hashlib.sha256(b'payload').hexdigest(),'esmSHA256':hashlib.sha256(b'payload').hexdigest()},'clientSource':'client-source.tar.gz','sourceInventory':'source-inventory.json','files':[{'path':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in producer.items()]}
if change=='changed-snapshot':index['sourceAuthority']['snapshotSHA256']='0'*64
if change=='legacy-scope':index['sourceAuthority']['scope']='CLI source plus explicitly mapped canonical runtime-client source; no claim of release acceptance or external dependency closure.'
if change=='unknown-source':index['sourceAuthority']['sourceCommit']=None
if change=='authority-injection':index['sourceAuthority']['credentials']={'argv':['private-marker']}
if change=='authority-snapshot-type':index['sourceAuthority']['snapshotSHA256']={'token':'private-marker'}
if change=='old-source-scope':index['sourceAuthority']['scope']='Package source snapshot only; no claim of release acceptance or dependency closure.'
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
  try {
    for (const name of canonicalHostSources) {
      const file = path.join(root, 'src', name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'canonical-host');
    }
    execFileSync('python3', ['-c', pack, archive, JSON.stringify(manifest), change, JSON.stringify(canonicalHostSources)]); await action(archive, root);
  }
  finally { rmSync(root, { recursive: true, force: true }); }
}
describe('exact product export', () => {
  const receipt = { sourceSHA: source, sourceClean: true, exit: 0, coreSHA256: hash('payload'), driverSHA256: hash('driver'), commands, metafiles: [] };
  it('projects exact safe build commands and drops build-only metadata', () => {
    const projected = projectProductBuild(receipt, source);
    expect(projected).toEqual({ sourceSHA: source, sourceClean: true, exit: 0, coreSHA256: hash('payload'), driverSHA256: hash('driver'), commands });
    expect(Object.keys(projected)).not.toContain('metafiles');
  });
  for (const injected of [ { commands: ['private-marker'] }, { commands: ['bun run build:packages', 'bun packages/xpod-afs/scripts/build-package.ts', 'bun build module-admission.ts --target=node --format=esm'] }, { commands: [...commands].reverse() }, { commands: commands.slice(1) }, { commands: [...commands, 'bun run build:packages'] }, { commands: { argv: 'private-marker' } }, { credentials: { token: 'private-marker' } }, { driverSHA256: { token: 'private-marker' } } ]) {
    it('rejects injected build receipt before actual exporter writes any product', () => fixture('', async (archive, root) => {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
      git('init', '--quiet'); writeFileSync(path.join(root, '.gitignore'), '*\n!.gitignore\n'); git('add', '--', '.gitignore'); git('commit', '--quiet', '-m', 'fixture');
      const actualSHA = git('rev-parse', 'HEAD'); const build = path.join(root, 'build.safe.json');
      writeFileSync(build, JSON.stringify({ ...receipt, sourceSHA: actualSHA, ...injected }));
      const out = path.join(root, 'product-export');
      await expect(exportProducts(root, archive, archive, archive, 'darwin-arm64', actualSHA, build, out, archive)).rejects.toThrow('invalid product build receipt');
      expect(existsSync(out)).toBe(false);
    }));
  }
  it('validates actual serialized public payloads, types and nested producer source', () => fixture('', async (archive, root) => {
    const value = await validateCliProduct(archive, path.join(root, 'materials'), source, hash('payload'), manifest, root);
    expect(value.name).toBe(manifest.name); expect(value.files['dist/tools.d.ts'].sha256).toBe(hash('payload'));
    expect(Object.keys(value.producerSourceAuthority).sort()).toEqual(['dirty', 'scope', 'snapshotSHA256', 'sourceCommit']);
    expect(value.producerSourceAuthority.sourceCommit).toBe(source);
  }));
  for (const change of ['missing-host', 'extra-host', 'changed-host', 'changed-snapshot', 'legacy-scope', 'authority-injection', 'authority-snapshot-type', 'unknown-source', 'old-source-scope', 'dirty', 'unbound-client', 'material-hash', 'extra-material', 'missing-type', 'missing-bin', 'nested-source']) {
    it(`rejects actual ${change} product`, () => fixture(change, async (archive, root) => {
      await expect(validateCliProduct(archive, path.join(root, 'materials'), source, hash('payload'), manifest, root)).rejects.toThrow();
    }));
  }
  for (const change of ['duplicate', 'symlink', 'escape', 'control']) {
    it(`rejects actual ${change} tar members`, () => fixture(change, (archive, root) => {
      expect(() => scanProduct(archive, path.join(root, 'materials'))).toThrow();
    }));
  }
  it('rejects a packed core different from the actual mounted core', () => fixture('', async (archive, root) => {
    await expect(validateCliProduct(archive, path.join(root, 'materials'), source, hash('different'), manifest, root)).rejects.toThrow('payload mismatch');
  }));
  it('keeps product artifact separate from safe consumer evidence and success gated', () => {
    const workflow = readFileSync('.github/workflows/agentfs-module-mounted-acceptance.yml', 'utf8');
    expect(workflow).toContain("if: steps.products.outcome == 'success'");
    expect(workflow).toContain('afs-module-products-${{ matrix.target }}-${{ github.sha }}');
    expect(workflow).toContain('/product-export/'); expect(workflow).toContain('/export/');
    expect(workflow).toContain('bun pm pack --filename "$MODULE_RUN_ROOT/cli.tgz" --ignore-scripts');
  });
});


describe('independent shared client product', () => {
  for (const change of ['', 'missing-session', 'changed-build', 'unbound-notices', 'unbound-peer', 'workspace-runtime', 'missing-notice-object']) {
    it(`validates actual client tar: ${change || 'complete public runtime'}`, () => {
      const parent = path.resolve('.test-data/agentfs-product-export'); mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(path.join(parent, 'client-'));
      try {
        const exports = { '.': { types: './dist/types/index.d.ts', import: './dist/index.mjs', require: './dist/library.cjs' }, './session': { types: './dist/types/session.d.ts', import: './dist/session.mjs', require: './dist/session.cjs' } };
        const clientManifest: any = { name: '@undefineds.co/xpod-client', version: '1', exports, peerDependencies: { sdk: '1' }, peerDependenciesMeta: { sdk: { optional: true } } };
        const entries: Record<string, string> = { 'LICENSE': 'MIT', 'README.md': 'Client', 'dist/peer.cjs': 'peer', 'dist/inputs.json': JSON.stringify({ inputs: { 'src/index.ts': {} } }), 'dist/licenses/index.json': JSON.stringify({ cliSha256: hash('runtime') }), 'dist/library.cjs': 'runtime', 'dist/licenses/objects/notice.txt': 'original notice' };
        for (const value of Object.values(exports)) for (const member of Object.values(value)) entries[member.slice(2)] ??= 'bridge';
        const packageRoot = path.join(root, 'package');
        for (const [name, value] of Object.entries({ ...entries, 'package.json': JSON.stringify(clientManifest), 'src/peer.cjs': 'peer' })) {
          mkdirSync(path.dirname(path.join(packageRoot, name)), { recursive: true }); writeFileSync(path.join(packageRoot, name), value);
        }
        if (change === 'missing-notice-object') delete entries['dist/licenses/objects/notice.txt'];
        if (change === 'missing-session') delete entries['dist/session.cjs'];
        if (change === 'changed-build') entries['dist/library.cjs'] = 'replacement';
        if (change === 'unbound-notices') entries['dist/licenses/index.json'] = JSON.stringify({ cliSha256: hash('other') });
        if (change === 'unbound-peer') writeFileSync(path.join(packageRoot, 'src/peer.cjs'), 'other');
        if (change === 'workspace-runtime') clientManifest.dependencies = { runtime: 'workspace:*' };
        entries['package.json'] = JSON.stringify(clientManifest);
        const archive = path.join(root, 'client.tgz');
        execFileSync('python3', ['-c', `import io,tarfile,json,sys
with tarfile.open(sys.argv[1],'w:gz') as t:
 for n,v in json.loads(sys.argv[2]).items():
  b=v.encode();m=tarfile.TarInfo('package/'+n);m.size=len(b);t.addfile(m,io.BytesIO(b))`, archive, JSON.stringify(entries)]);
        const validate = () => validateClientProduct(archive, path.join(root, 'validation'), packageRoot, source);
        if (change) expect(validate).toThrow();
        else { const result = validate(); expect(result.name).toBe('@undefineds.co/xpod-client'); expect(result.sourceCommit).toBe(source); }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  it('requires separate serialized client and the explicit service boundary gate in CI', () => {
    const workflow = readFileSync('.github/workflows/agentfs-module-mounted-acceptance.yml', 'utf8');
    expect(workflow).toContain('node --test tests/scripts/service-runtime-boundary.node-test.cjs');
    expect(workflow).toContain('bun test ./packages/xpod-client/tests');
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain('bun test ./packages/xpod-client/tests');
    expect(readFileSync('.github/workflows/cli-package.yml', 'utf8')).toContain("'packages/xpod-client/**'");
    expect(readFileSync('scripts/check-cli-package.cjs', 'utf8')).toContain("run('bun', ['run', 'test'], runtimeClientRoot)");
    expect(workflow).toContain('cd packages/xpod-client && bun pm pack');
    const tools = workflow.indexOf('bun run --filter @undefineds.co/xpod-cli build:tools');
    const client = workflow.indexOf('bun run --filter @undefineds.co/xpod-client build');
    const cli = workflow.indexOf('bun run --filter @undefineds.co/xpod-cli build\n');
    expect(tools).toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(tools);
    expect(cli).toBeGreaterThan(client);
    expect(cli).toBeLessThan(workflow.indexOf('prepare-module-inputs.ts native-info'));
    expect(workflow).not.toContain('bun run build:packages');
    expect(workflow).toContain('bun scripts/build-afs-from-producer.ts --mode module --cli-package');
    expect(workflow).toContain('XPOD_AFS_LIFETIME_NATIVE_EVIDENCE: ${{ env.MODULE_RUN_ROOT }}/native/native.zip');
    expect(workflow).toContain('XPOD_AFS_LIFETIME_NATIVE_PINS: ${{ env.MODULE_RUN_ROOT }}/native/native-pins.json');
    expect(workflow).toContain('XPOD_AFS_LIFETIME_TARGET: ${{ matrix.target }}');
    expect(workflow).toContain('run: bun test packages/xpod-afs/tests/producer-build-lifetime.test.ts');
    expect(workflow).toContain('if [ -f "$MODULE_RUN_ROOT/native/native-facts.safe.json" ]; then');
    expect(workflow).toContain('--client "$MODULE_RUN_ROOT/client.tgz"');
  });
});


describe('AgentFS mounted development workflow entry contract', () => {
  const workflow = parse(readFileSync('.github/workflows/agentfs-module-mounted-acceptance.yml', 'utf8'));
  it('runs maintained branch pushes and PR merge candidates without path omissions', () => {
    expect(workflow.on).toEqual({
      pull_request: { branches: ['staging', 'main'] },
      push: { branches: ['staging', 'main'] },
      workflow_dispatch: null,
    });
    const checkout = workflow.jobs['mounted-module'].steps.find((step: any) => step.uses === 'actions/checkout@v4');
    // github.sha is the tested merge commit for pull_request, not the PR head.
    expect(checkout.with).toEqual({ ref: '${{ github.sha }}', 'fetch-depth': 0 });
  });
  it('retains read-only isolated evidence jobs without shared RC or deployment writes', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', packages: 'read', actions: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['mounted-module']);
    const job = workflow.jobs['mounted-module'];
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(job.secrets).toBeUndefined();
    expect(job['timeout-minutes']).toBe(120);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.include.map((entry: any) => entry.target)).toEqual([
      'linux-arm64', 'darwin-arm64', 'linux-x64', 'darwin-x64',
    ]);
    const body = JSON.stringify(job);
    expect(body).not.toMatch(/pull_request_target|secrets\.|gh (?:release|workflow run)|git push|(?:npm|bun) publish|kubectl|deployments:|id-token:/);
    expect(body).toContain('--verify-module-native-source');
    expect(body).toContain('noPromotion');
    const uploads = job.steps.filter((step: any) => step.uses === 'actions/upload-artifact@v4');
    expect(uploads.map((step: any) => step.with.name)).toEqual([
      'afs-module-products-${{ matrix.target }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
      'afs-module-mounted-${{ matrix.target }}-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    ]);
  });
});


it('binds the canonical five receipt commands to actual workflow run steps in order', () => {
  const workflow = parse(readFileSync('.github/workflows/agentfs-module-mounted-acceptance.yml', 'utf8'));
  const steps = workflow.jobs['mounted-module'].steps;
  const actualCommands = (sourceSteps: any[]) => sourceSteps.flatMap((step: any) => typeof step.run === 'string' ? step.run.split('\n') : [])
    .map((line: string) => line.trim())
    .filter((line: string) => /^bun (?:run |build |scripts\/build-afs-from-producer\.ts )/.test(line));
  expect(commands).toHaveLength(5);
  // Only deployment paths/outputs are expanded; no command tokens are discarded.
  const expanded = commands.map((command, index) => {
    if (index === 3) return command.replace('--cli-package packages/xpod-cli', '--cli-package "$GITHUB_WORKSPACE/packages/xpod-cli"')
      + ' --target "$TARGET" --out "$MODULE_RUN_ROOT/build" --native-evidence "$MODULE_RUN_ROOT/native/native.zip" --native-pins "$MODULE_RUN_ROOT/native/native-pins.json"';
    if (index === 4) return command.replace('module-admission.ts', 'scripts/agentfs-native-ci/mounted/module-admission.ts')
      + ' --metafile="$MODULE_RUN_ROOT/driver-inputs.json" --outfile "$MODULE_RUN_ROOT/module-admission.mjs"';
    return command;
  });
  expect(actualCommands(steps)).toEqual(expanded);
  // Counterexamples use the actual run bodies, not just fabricated receipts.
  for (const mutate of [
    (run: string) => run.replace(commands[0], 'bun run build:packages'),
    (run: string) => run.replace(commands[0], ''),
    (run: string) => run.replace(commands[0], commands[2]).replace(commands[1], commands[0]),
    (run: string) => run.replace('--native-pins "$MODULE_RUN_ROOT/native/native-pins.json"', ''),
    (run: string) => run.replace(commands[0], commands[0] + ' --unexpected'),
  ]) {
    const changed = steps.map((step: any) => ({ ...step, run: typeof step.run === 'string' ? mutate(step.run) : step.run }));
    expect(actualCommands(changed)).not.toEqual(expanded);
  }
  const receiptStep = steps.find((step: any) => step.name === 'Build module and core once for this platform').run;
  expect(receiptStep).toContain("'commands':json.load(open(workspace/'scripts/agentfs-native-ci/mounted/producer-commands.json'))['commands']");
});
