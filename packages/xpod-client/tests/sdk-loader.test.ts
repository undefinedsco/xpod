import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('an explicit failed host is cached and cannot fall back or be rebound', () => {
  const result = spawnSync('bun', ['-e', `
    import {registerSolidAuthnSdkLoader,loadSolidAuthnSdk} from './src/sdk.ts';
    let calls=0; const failure=new Error('owned-loader-failure');
    registerSolidAuthnSdkLoader(async()=>{calls++;throw failure});
    const first=loadSolidAuthnSdk(),second=loadSolidAuthnSdk();
    if(first!==second)throw Error('duplicate loading promise');
    for(const promise of [first,second]) { try {await promise;throw Error('accepted failed host')} catch(error) {if(error!==failure)throw error} }
    let refused=false;try{registerSolidAuthnSdkLoader(async()=>import('@inrupt/solid-client-authn-node'))}catch{refused=true}
    if(calls!==1||!refused)throw Error('loader authority changed');
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});

test('a host loads the real SDK once and preserves the peer class identity', () => {
  const result = spawnSync('bun', ['-e', `
    import {registerSolidAuthnSdkLoader,loadSolidAuthnSdk} from './src/sdk.ts';
    import * as peer from '@inrupt/solid-client-authn-node';
    let calls=0;const host=async()=>{calls++;return peer};
    registerSolidAuthnSdkLoader(host);registerSolidAuthnSdkLoader(host);
    const [first,second]=await Promise.all([loadSolidAuthnSdk(),loadSolidAuthnSdk()]);
    if(calls!==1||first!==second||first.Session!==peer.Session)throw Error('SDK identity changed');
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});


test('default lazy peer and explicit Session choose the same real require authority', () => {
  const result = spawnSync('bun', ['-e', `
    import {loadSolidAuthnSdk} from './src/sdk.ts';
    import {Session} from './src/session.ts';
    import {createRequire} from 'node:module';
    const actual=createRequire(import.meta.url)('@inrupt/solid-client-authn-node');
    const first=loadSolidAuthnSdk(),second=loadSolidAuthnSdk();
    if(first!==second)throw Error('duplicate default promise');
    const sdk=await first;
    if(sdk!==actual||sdk.Session!==Session||Session!==actual.Session)throw Error('dual peer authority');
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});
