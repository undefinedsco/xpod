import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import fixture from './fixtures/rc382-desktop-manifest-transition.json';
import snapshotFixture from './fixtures/rc382-workspace-build-ctime-snapshots.json';
import {resolveDesktopVersionedManifest,DESKTOP_VERSIONED_MANIFEST,inspectServiceWorkspaceBuild} from '../../scripts/lib/independent-admission/service-workspace-build-replay';

/** DATA-PLUMBING test only: byte readers are mocked here and no issued
 * capability, custody or whole-CI qualification is claimed. The adapter under
 * test is the SAME one the production call site uses, so this exercises real
 * wiring rather than a test-local mirror. */
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
const before=Buffer.from((fixture as any).before,'base64');
const after=Buffer.from((fixture as any).after,'base64');
const run=(fixture as any).run;
const master=(over:any={})=>({sourceOriginals:{
  desktopManifestBefore:{path:'desktop-before.original.json',bytes:before.length,sha256:sha(before)},
  desktopManifestAfter:{path:'desktop-after.original.json',bytes:after.length,sha256:sha(after)},...over}});
const source=(over:any={})=>({
  readOriginal:(descriptor:any)=>descriptor.path==='desktop-before.original.json'?Buffer.from(before):Buffer.from(after),
  readImmutableGit:(relative:string,exact:number)=>{
    expect(relative).toBe(DESKTOP_VERSIONED_MANIFEST.relative);
    return {mode:'100644',bytes:Buffer.from(before)};
  },
  run,sourceSha:(fixture as any).sourceSha,runId:run.id,runAttempt:run.run_attempt,
  expectedVersion:(fixture as any).expectedVersion,...over});

test('the production adapter constructs the verified desktop transition itself',()=>{
  const entry=resolveDesktopVersionedManifest(source() as any,master());
  expect(entry.relative).toBe('desktop/package.json');
  expect(entry.name).toBe('@undefineds.co/xpod-desktop');
  expect(entry.before.equals(before)).toBe(true);
  expect(entry.after.equals(after)).toBe(true);
  expect(entry.immutable.equals(before)).toBe(true);
  expect(entry.expectedVersion).toBe('0.4.31-rc.382');
});

test('the adapter refuses foreign, missing or tampered catalogue references',()=>{
  // Missing descriptors.
  expect(()=>resolveDesktopVersionedManifest(source() as any,{} as any)).toThrow();
  expect(()=>resolveDesktopVersionedManifest(source() as any,{sourceOriginals:{desktopManifestBefore:{path:'x',bytes:1,sha256:'a'.repeat(64)}}} as any)).toThrow();
  // A path outside the same issued closed set is refused by the closed-set
  // reader (this is the contract the production reader enforces).
  const foreign={...master(),sourceOriginals:{...master().sourceOriginals,
    desktopManifestAfter:{path:'other-catalogue/desktop.json',bytes:after.length,sha256:sha(after)}}};
  const closedSetSource={...source(),readOriginal:(descriptor:any)=>{
    const known=['desktop-before.original.json','desktop-after.original.json'];
    if(!known.includes(descriptor.path))throw Error('desktop original outside same retained closed set');
    return descriptor.path==='desktop-before.original.json'?Buffer.from(before):Buffer.from(after);
  }};
  expect(()=>resolveDesktopVersionedManifest(closedSetSource as any,foreign as any)).toThrow();
  // A reader that returns bytes not matching the descriptor hash is refused.
  const liar={...source(),readOriginal:()=>Buffer.from(before)};
  expect(()=>resolveDesktopVersionedManifest(liar as any,master())).toThrow();
  // Recorded after bytes that do not match the descriptor length are refused by
  // the closed-set reader / length check.
  const wrongLen={...master(),sourceOriginals:{...master().sourceOriginals,
    desktopManifestAfter:{path:'desktop-after.original.json',bytes:after.length+5,sha256:sha(after)}}};
  expect(()=>resolveDesktopVersionedManifest(source() as any,wrongLen as any)).toThrow();
  // Same descriptor path for before and after.
  const same={...master(),sourceOriginals:{
    desktopManifestBefore:{path:'same.json',bytes:before.length,sha256:sha(before)},
    desktopManifestAfter:{path:'same.json',bytes:after.length,sha256:sha(after)}}};
  expect(()=>resolveDesktopVersionedManifest(source() as any,same as any)).toThrow();
  // Oversized descriptor bound.
  const huge={...master(),sourceOriginals:{...master().sourceOriginals,
    desktopManifestAfter:{path:'desktop-after.original.json',bytes:129*1024,sha256:sha(after)}}};
  expect(()=>resolveDesktopVersionedManifest(source() as any,huge as any)).toThrow();
});

test('a forged versioned entry for an unrelated manifest is rejected by the gate',()=>{
  // Even a perfectly valid version transition may not be supplied for another path.
  const rows:any=JSON.parse(JSON.stringify(snapshotFixture.before));
  const row=rows.rows.find((r:any)=>r[0]==='package.json');
  const snapRows=[...rows.rows,['desktop/package.json',[...row[1]],(fixture as any).afterSha256]];
  snapRows[snapRows.length-1][1][3]=String(after.length);
  const snap={...rows,rows:snapRows,observedFileBytes:Number(rows.observedFileBytes)+after.length};
  const buf=Buffer.from(JSON.stringify(snap));
  const outputs=Buffer.from(JSON.stringify({...snap,generated:true,rows:[],observedFileBytes:0}));
  const good=resolveDesktopVersionedManifest(source() as any,master());
  // A valid-version forged entry for a different manifest path is refused.
  const forged={...good,relative:'packages/xpod-cli/package.json',name:'@undefineds.co/xpod-cli'};
  const call=(versionedManifests:any[])=>inspectServiceWorkspaceBuild({before:buf,after:buf,outputs,
    afterRoot:Buffer.from((snapshotFixture as any).bytes['package.json'],'base64'),versionedManifests,
    readGit:(name:string)=>name==='bun.lock'
      ? {mode:'100644',bytes:require('node:fs').readFileSync('bun.lock')}
      : {mode:'100644',bytes:Buffer.from((snapshotFixture as any).bytes[name],'base64')},
    selected:[],check(){}} as any);
  expect(()=>call([forged])).toThrow('unauthorized version-stamped manifest path/namespace');
  expect(()=>call([{...good,name:'@undefineds.co/xpod'}])).toThrow('unauthorized version-stamped manifest path/namespace');
});
