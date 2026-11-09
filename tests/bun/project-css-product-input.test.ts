import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireIndependentProductInput, CSS_PRODUCT_WORKFLOW } from '../../scripts/acquire-independent-product-input';
import { parseCssPackReceipt, projectCssProductInput, type CssProductProjectionInput } from '../../scripts/project-css-product-input';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Synthetic transport bytes, never real CSS/native/consumer qualification.
async function fixture(alter: (producer: any) => void = () => {}, packAlter: (packed: any) => void = () => {}) {
  mkdirSync('.test-data/css-product-projection', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/css-product-projection/case-')); roots.push(root);
  const source = 'a'.repeat(40), head = 'b'.repeat(40);
  const made = spawnSync('python3', ['-c', "import tarfile,io,sys\nwith tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as t:\n b=b'{}';i=tarfile.TarInfo('package/package.json');i.size=len(b);t.addfile(i,io.BytesIO(b))"]);
  if (made.status !== 0) throw Error('tiny tar fixture');
  const archive = made.stdout;
  const packed: any = { archive: '/original/build/product.tgz', sha256: hash(archive), integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), members: 1, publicationMode: 'preview', status: 'controlled-preview', releaseAccepted: false, nativeAdmission: false };
  packAlter(packed);
  const raw = Buffer.from('Components.js: original component generation log\n{"valid":true,"qlever-local":"passed"}\n' + JSON.stringify(packed) + '\n');
  const producer: any = { schemaVersion: 1, kind: 'css-module-product-production', status: 'controlled-preview-materials',
    context: { repository: 'undefinedsco/xpod', workflowPath: CSS_PRODUCT_WORKFLOW,
      workflowRef: `undefinedsco/xpod/${CSS_PRODUCT_WORKFLOW}@refs/pull/62/merge`, workflowSha: source,
      runId: 42, runAttempt: 2, event: 'pull_request', runHeadSha: head, githubSha: source,
      actualCheckoutSha: source, target: 'darwin-arm64', version: '0.0.0-preview.1', actualMacOSVersion: '15.7', actualMachine: 'arm64' },
    sourceBefore: { sha: source, status: '' }, sourceAfter: { sha: source, status: '' },
    archive: { path: 'product.tgz', bytes: archive.length, sha256: hash(archive), integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), members: 1 },
    packRaw: { path: 'evidence/pack.raw.log', bytes: raw.length, sha256: hash(raw) }, phases: [],
    published: false, releaseQualified: false, consumerValidated: false, legalClearance: false, nativeAdmission: false,
    blockers: ['preview-not-publishable'] };
  const extra: Array<{ path: string; body: string }> = [];
  const add = (name: string, data: Buffer) => { extra.push({path: name, body: data.toString('base64')}); return {path:name,bytes:data.length,sha256:hash(data)}; };
  producer.phases = ['install','tools','client','cli','afs-client','dependency-state','pack'].map(name => ({name,
    receipt: add(`evidence/${name}.receipt.json`,Buffer.from('{"synthetic":true}')),
    raw: name === 'pack' ? producer.packRaw : add(`evidence/${name}.raw.log`,Buffer.alloc(0)),
  }));
  producer.nativeAcquisition = {artifactId:7,nativeJobId:8,officialIdentityAuthenticated:false,releaseAccepted:false,
    originals:['run.raw.json','artifact.metadata.raw.json','native-jobs.raw.json','native.zip','qlever-local-runtime-darwin-arm64.tar.gz','qlever-local-acceptance.json'].map(name => add('originals/'+name,Buffer.from('synthetic native original '+name)))};
  alter(producer);
  const producerBytes = Buffer.from(JSON.stringify(producer, null, 2) + '\n');
  const zip = path.join(root, 'original.zip');
  const files = [{ path: 'producer.receipt.json', body: producerBytes.toString('base64') }, { path: 'product.tgz', body: archive.toString('base64') },
    { path: 'evidence/pack.raw.log', body: raw.toString('base64') }, { path: 'decoy/product.tgz', body: Buffer.from('not-selected').toString('base64') }, ...extra];
  const zipped = spawnSync('python3', ['-c', "import json,zipfile,base64,sys\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for r in json.loads(sys.argv[2]):z.writestr(r['path'],base64.b64decode(r['body']))", zip, JSON.stringify(files)]);
  if (zipped.status !== 0) throw Error('tiny ZIP fixture');
  const bytes = readFileSync(zip), digest = hash(bytes);
  const run = { id: 42, run_attempt: 2, head_sha: head, repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' },
    status: 'completed', conclusion: 'success', event: 'pull_request', workflow_id: 7, path: CSS_PRODUCT_WORKFLOW,
    run_started_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:02:00Z' };
  const artifact = { id: 91, name: `css-module-products-darwin-arm64-${source}-42-2`, size_in_bytes: bytes.length,
    digest: 'sha256:' + digest, expired: false, workflow_run: { id: 42, head_sha: head }, created_at: '2026-10-15T00:01:00Z' };
  const transport = (async (url: any) => {
    const address = String(url);
    if (address.endsWith('/attempts/2')) return Response.json(run);
    if (address.endsWith('/workflows/7')) return Response.json({ id: 7, path: CSS_PRODUCT_WORKFLOW });
    if (address.endsWith('/artifacts/91')) return Response.json(artifact);
    if (address.endsWith('/zip')) return new Response(bytes);
    throw Error('unexpected endpoint');
  }) as typeof fetch;
  const acquired = path.join(root, 'acquired');
  await acquireIndependentProductInput({ schemaVersion: 1, sourceSha: source, runHeadSha: head, runId: 42, runAttempt: 2, artifactId: 91, artifactSha256: digest }, acquired, { fetch: transport });
  const input: CssProductProjectionInput = { schemaVersion: 1, acquisitionRoot: acquired,
    custodyReceiptSha256: hash(readFileSync(path.join(acquired, 'receipt.json'))),
    members: { producer: 'producer.receipt.json', archive: 'product.tgz', packRaw: 'evidence/pack.raw.log' } };
  return { root, acquired, input, archive, raw, producerBytes, output: path.join(root, 'projected') };
}
test('CSS preserves original three members and complete evidence inventory without expanding inner archives', async () => {
 const f=await fixture();const result=await projectCssProductInput(f.input,f.output);
 for(const [name,bytes] of [['product.tgz',f.archive],['pack.raw.log',f.raw],['producer.receipt.json',f.producerBytes]] as const)
  expect(readFileSync(path.join(f.output,name)).equals(bytes)).toBe(true);
 expect(result.sourceSha).toBe('a'.repeat(40));expect(result.runHeadSha).toBe('b'.repeat(40));
 expect(result.originalEvidence.phases.length).toBe(7);expect(result.originalEvidence.native.length).toBe(6);
 expect(result.selectedMembersProjected).toBe(3);expect(result.innerArchiveExpanded).toBe(false);
 expect(existsSync(path.join(f.output,'native-runtime'))).toBe(false);
 for(const key of ['actualCheckoutVerified','exactAttemptAdmitted','phaseClosureAdmitted','consumerValidated','registryConsumerValidated','legalClearance','nativeAdmission','published','releaseQualified'] as const) expect(result[key]).toBe(false);
 const consumer=JSON.parse(readFileSync(path.join(f.output,'consumer-input.json'),'utf8'));
 expect(consumer.package.name).toBe('@undefineds.co/xpod-css-darwin-arm64');expect(consumer.archive.sha256).toBe(hash(f.archive));
});
for(const change of ['source','attempt','event-head','dirty','workflow','macos','clearance','archive','phase-count','phase-ref','native-count','native-ref','native-admission']) test('rejects CSS claim mismatch '+change,async()=>{
 const f=await fixture(p=>{
  if(change==='source')p.context.actualCheckoutSha='c'.repeat(40);
  if(change==='attempt')p.context.runAttempt=3;
  if(change==='event-head')p.context.runHeadSha='a'.repeat(40);
  if(change==='dirty')p.sourceAfter.status=' M source.ts';
  if(change==='workflow')p.context.workflowPath='.github/workflows/api-module-product.yml';
  if(change==='macos')p.context.actualMacOSVersion='14.7';
  if(change==='clearance')p.legalClearance=true;
  if(change==='archive')p.archive.path='decoy/product.tgz';
  if(change==='phase-count')p.phases.pop();
  if(change==='phase-ref')p.phases[0].raw.sha256='0'.repeat(64);
  if(change==='native-count')p.nativeAcquisition.originals.pop();
  if(change==='native-ref')p.nativeAcquisition.originals[0].path='decoy/native.zip';
  if(change==='native-admission')p.nativeAcquisition.releaseAccepted=true;
 });
 await expect(projectCssProductInput(f.input,f.output)).rejects.toThrow();expect(existsSync(f.output)).toBe(false);
});
test('changed ZIP or saved metadata blocks projection and existing destinations remain intact',async()=>{
 const f=await fixture();writeFileSync(path.join(f.acquired,'artifact.zip'),'changed');
 await expect(projectCssProductInput(f.input,f.output)).rejects.toThrow('ZIP');
 const m=await fixture();const original=path.join(m.acquired,'metadata/run.original.json');chmodSync(original,0o600);writeFileSync(original,'{}');
 await expect(projectCssProductInput(m.input,m.output)).rejects.toThrow('metadata original hash');
 const e=await fixture();mkdirSync(e.output);writeFileSync(path.join(e.output,'original'),'keep');
 await expect(projectCssProductInput(e.input,e.output)).rejects.toThrow('already exists');expect(readFileSync(path.join(e.output,'original'),'utf8')).toBe('keep');
});
test('CSS pack decoder keeps original chatter but rejects duplicate archive results',()=>{
 const pack={archive:'/original',sha256:'a'.repeat(64),integrity:'sha512-'+'A'.repeat(86)+'==',members:1};
 expect(parseCssPackReceipt(Buffer.from('Components.js original log\n{"valid":true}\n'+JSON.stringify(pack))).archive).toBe('/original');
 expect(()=>parseCssPackReceipt(Buffer.from(JSON.stringify(pack)+'\n'+JSON.stringify(pack)))).toThrow('unique');
});
