import {test,expect}from'bun:test';import{spawnSync}from'node:child_process';import path from'node:path';
test('root mutation repeated guards preserve finite native read allowance with privately cached verified root bytes and live zero-range checks',()=>{
 const worker=path.join(import.meta.dir,'candidate-service-root-mutation-cache-worker.ts');const result=spawnSync(process.execPath,[worker],{encoding:'utf8',timeout:10000,maxBuffer:65536});expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(result.stdout.includes('one initial universe scan')).toBe(true);
});
