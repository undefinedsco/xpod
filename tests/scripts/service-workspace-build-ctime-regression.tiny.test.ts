import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import fixture from './fixtures/rc382-workspace-build-ctime-snapshots.json';
import desktop from './fixtures/rc382-desktop-manifest-transition.json';
import {inspectServiceWorkspaceBuild} from '../../scripts/lib/independent-admission/service-workspace-build-replay';

/** RC382 (run 42333190206, artifact 13558544228) failed with
 * `build source pre/post full identities or bytes differ`. Three package.json
 * rows differ only in `st_ctime_ns`; recorded bytes and all other identity fields
 * match. These snapshots do not identify the writer or prove the absence of
 * intervening writes. The fixture retains those rows plus an unchanged control. */
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
const rows=(snapshot:any)=>snapshot.rows as any[];
/** The RC382 build input is the IMMUTABLE historical `bun.lock`, not today's file.
 *
 * Captured with `git show 1cc4ffaec12e33c6ffc34891ebc364f8543750d0:bun.lock`
 * (sha256 ff70b48d929511d94b9350abbb91ee4980aa9e86532190574fe2f3e42b221042,
 * 790732 bytes) and stored gzip-compressed (deterministic, mtime=0) so the
 * repository does not carry a second full copy of an already-public lockfile.
 *
 * The RC382 snapshot pins that exact hash and size. Reading the live repository
 * lock instead made this fixture depend on unrelated later dependency edits.
 */
const historicalLock=():Buffer=>{
  const raw=gunzipSync(readFileSync(new URL('./fixtures/rc382-workspace-build-bun.lock.gz',import.meta.url)));
  const expected=beforeRows.find((r:any)=>r[0]==='bun.lock');
  expect(sha(raw)).toBe(expected[2]);
  expect(raw.length).toBe(Number(expected[1][3]));
  return raw;
};
/** The fixture keeps the real identity tuples and the verbatim build-input bytes. */
const embedded=(fixture as any).bytes as Record<string,string>;
const beforeRows=rows(fixture.before),afterRows=rows(fixture.after);
const outputs=Buffer.from(JSON.stringify({...fixture.before,generated:true,rows:[],observedFileBytes:0}));
const options=(over:any={})=>({before:Buffer.from(JSON.stringify(fixture.before)),
  after:Buffer.from(JSON.stringify(fixture.after)),outputs,
  // package.json is bound to afterRoot by the parser, not to readGit.
  afterRoot:Buffer.from(embedded['package.json'],'base64'),
  readGit:(name:string)=>{
    if(name==='bun.lock')return {mode:'100644',bytes:historicalLock()};
    if(name==='package.json')return {mode:'100644',bytes:Buffer.from(embedded[name],'base64')};
    const raw=Buffer.from(embedded[name]??'','base64');
    expect(sha(raw)).toBe(beforeRows.find(r=>r[0]===name)[2]);
    expect(raw.length).toBe(Number(beforeRows.find(r=>r[0]===name)[1][3]));
    return {mode:'100644',bytes:raw};
  },
  selected:[],check(){},...over});

test('the real RC382 ctime-only snapshot delta is accepted',()=>{
  // Guard the fixture itself: the only delta really is st_ctime_ns.
  expect(afterRows.length).toBe(beforeRows.length);
  const changedNames=beforeRows.filter((row,i)=>JSON.stringify(row)!==JSON.stringify(afterRows[i])).map(row=>row[0]).sort();
  expect(changedNames).toEqual(['package.json','packages/xpod-cli/package.json','packages/xpod-client/package.json']);
  for(const row of beforeRows){
    const match=afterRows.find(next=>next[0]===row[0])!;
    expect(match[2]).toBe(row[2]);                                  // byte hash identical
    const strip=(t:string[])=>t.filter((_,i)=>i!==5);                // ctime excluded
    expect(strip(match[1])).toEqual(strip(row[1]));
  }
  expect(inspectServiceWorkspaceBuild(options()).recordedBuildSourceSnapshotsMatchImmutableSource).toBe(true);
});

test('real content drift on those same rows is still refused',()=>{
  for(const name of ['package.json','packages/xpod-cli/package.json','packages/xpod-client/package.json']){
    const altered=JSON.parse(JSON.stringify(fixture.after));
    altered.rows.find((row:any)=>row[0]===name)[2]='0'.repeat(64);
    expect(()=>inspectServiceWorkspaceBuild(options({after:Buffer.from(JSON.stringify(altered))}))).toThrow('differ');
  }
  for(const index of [0,1,2,4,6]){ // dev, ino, mode, mtime, nlink
    const altered=JSON.parse(JSON.stringify(fixture.after));
    const row=altered.rows.find((r:any)=>r[0]==='package.json');
    row[1][index]=String(Number(row[1][index])+1);
    expect(()=>inspectServiceWorkspaceBuild(options({after:Buffer.from(JSON.stringify(altered))}))).toThrow();
  }
  const resized=JSON.parse(JSON.stringify(fixture.after));
  const sized=resized.rows.find((r:any)=>r[0]==='package.json');
  sized[1][3]=String(Number(sized[1][3])+1);
  resized.observedFileBytes=Number(resized.observedFileBytes)+1;
  expect(()=>inspectServiceWorkspaceBuild(options({after:Buffer.from(JSON.stringify(resized))}))).toThrow('differ');
  const dropped=JSON.parse(JSON.stringify(fixture.after));
  const lockBytes=Number(dropped.rows.find((r:any)=>r[0]==='bun.lock')[1][3]);
  dropped.rows=dropped.rows.filter((r:any)=>r[0]!=='bun.lock');
  dropped.observedFileBytes=Number(dropped.observedFileBytes)-lockBytes;
  expect(()=>inspectServiceWorkspaceBuild(options({after:Buffer.from(JSON.stringify(dropped))}))).toThrow('differ');
});

/** The gate must accept the snapshot only when the version-stamped desktop
 * manifest is supplied through the verified transition path (never arbitrary
 * bytes), and must refuse a recorded snapshot that needs it but omits it. */
test('a recorded desktop row requires its verified transition originals',()=>{
  const withDesktop:any={...JSON.parse(JSON.stringify(fixture.before))};
  const row=withDesktop.rows.find((r:any)=>r[0]==='package.json');
  withDesktop.rows=[...withDesktop.rows,['desktop/package.json',row[1],row[2]]];
  withDesktop.observedFileBytes=Number(withDesktop.observedFileBytes)+Number(row[1][3]);
  const beforeBuf=Buffer.from(JSON.stringify(withDesktop));
  const afterBuf=Buffer.from(JSON.stringify({...withDesktop}));
  const entry={relative:'desktop/package.json',
    before:Buffer.from((desktop as any).before,'base64'),
    after:Buffer.from((desktop as any).after,'base64'),
    immutable:Buffer.from((desktop as any).before,'base64'),
    name:(desktop as any).name,run:(desktop as any).run,
    sourceSha:(desktop as any).sourceSha,runId:(desktop as any).run.id,
    runAttempt:(desktop as any).run.run_attempt};
  const readGitFor=(name:string)=>{
    if(name==='bun.lock')return {mode:'100644',bytes:historicalLock()};
    if(name==='package.json')return {mode:'100644',bytes:Buffer.from(embedded[name],'base64')};
    return {mode:'100644',bytes:Buffer.from(embedded[name],'base64')};
  };
  // Omitting the required originals fails closed.
  expect(()=>inspectServiceWorkspaceBuild({before:beforeBuf,after:afterBuf,outputs,
    afterRoot:Buffer.from(embedded['package.json'],'base64'),readGit:readGitFor,selected:[],check(){}} as any))
    .toThrow('desktop manifest transition originals required');
});

test('a verified desktop transition admits the recorded snapshot row',()=>{
  // A snapshot that ALSO contains the real version-stamped desktop row: the gate
  // must refuse without the transition originals and accept with them.
  const snap:any=JSON.parse(JSON.stringify(fixture.before));
  const rootRow=snap.rows.find((r:any)=>r[0]==='package.json');
  const desktopBytes=Buffer.from((desktop as any).after,'base64');
  const desktopRow=['desktop/package.json',[...rootRow[1]],(desktop as any).afterSha256];
  desktopRow[1][3]=String(desktopBytes.length);
  snap.rows=[...snap.rows,desktopRow];
  snap.observedFileBytes=Number(snap.observedFileBytes)+desktopBytes.length;
  const snapBuf=Buffer.from(JSON.stringify(snap));
  const entry={relative:'desktop/package.json',
    before:Buffer.from((desktop as any).before,'base64'),after:desktopBytes,
    immutable:Buffer.from((desktop as any).before,'base64'),
    name:(desktop as any).name,run:(desktop as any).run,
    sourceSha:(desktop as any).sourceSha,runId:(desktop as any).run.id,
    runAttempt:(desktop as any).run.run_attempt};
  const readGitWith=(name:string)=>name==='bun.lock'
    ? {mode:'100644',bytes:historicalLock()}
    : {mode:'100644',bytes:Buffer.from(embedded[name],'base64')};
  const call=(versionedManifests:any[])=>inspectServiceWorkspaceBuild({before:snapBuf,after:snapBuf,outputs,
    afterRoot:Buffer.from(embedded['package.json'],'base64'),versionedManifests,
    readGit:readGitWith,selected:[],check(){}} as any);
  // Missing originals: refused.
  expect(()=>call([])).toThrow('desktop manifest transition originals required');
  // Originals whose after-bytes disagree with the recorded row hash: refused.
  const tampered={...entry,after:Buffer.from(JSON.stringify({...JSON.parse(desktopBytes.toString()),version:'0.4.31-rc.999'}))};
  expect(()=>call([tampered])).toThrow();
  // Genuine transition bytes: accepted.
  expect(call([entry]).recordedBuildSourceSnapshotsMatchImmutableSource).toBe(true);
});
