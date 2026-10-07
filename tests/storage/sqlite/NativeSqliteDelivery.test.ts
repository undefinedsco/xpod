import { describe, expect, it } from 'vitest';
import { resolveRuntimeLaunchCommand } from '../../../desktop/src/runtime-manager';

describe('selected desktop native payload intent', () => {
  it('refuses missing selected binary instead of choosing another PATH runtime', () => {
    expect(resolveRuntimeLaunchCommand({env:{},resourcesPath:'/owned/app',pathExists:(p)=>p==='/owned/app/runtime/qlever'})).toBeUndefined();
  });
  it('refuses missing selected producer instead of choosing JS or PATH runtime', () => {
    expect(resolveRuntimeLaunchCommand({env:{},resourcesPath:'/owned/app',pathExists:(p)=>p==='/owned/app/runtime/xpod'||p==='/owned/app/runtime/bin/xpod.js'})).toBeUndefined();
  });
});
