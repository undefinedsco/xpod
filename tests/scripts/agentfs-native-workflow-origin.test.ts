/** AgentFS native producer hosted-runner refresh (macos-14 -> macos-15, Bun installed).
 *
 * The CURRENT workflow bytes are the primary registered digest; the previously
 * reviewed bytes (run 42630283454 and earlier) stay admitted so historical
 * native artifacts keep verifying. Any other bytes remain unreviewed.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {describe,expect,it} from 'vitest';
import {AGENTFS_NATIVE_WORKFLOW_SHA256S} from '../../scripts/lib/independent-admission/github-origin';

const ROOT=path.resolve(import.meta.dirname,'../..');
const WORKFLOW='.github/workflows/agentfs-native-acceptance.yml';
const bytes=readFileSync(path.join(ROOT,WORKFLOW));
const PREVIOUS_REVIEWED='16b9b9e1fce46671f50080765c3c590daef0606a5cdf767c22fe4719ac72d310';

describe('AgentFS native producer workflow identity',()=>{
  it('registers the current bytes first and keeps the previous reviewed bytes',()=>{
    expect(AGENTFS_NATIVE_WORKFLOW_SHA256S[0]).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(AGENTFS_NATIVE_WORKFLOW_SHA256S).toContain(PREVIOUS_REVIEWED);
    expect(new Set(AGENTFS_NATIVE_WORKFLOW_SHA256S).size).toBe(AGENTFS_NATIVE_WORKFLOW_SHA256S.length);
  });

  it('runs macOS natives on supported images with Bun and the built client before the supervisor regression',()=>{
    const job=parse(bytes.toString('utf8')).jobs['native-macos'];
    expect(job.strategy.matrix.include.map((row:any)=>[row.target,row.runner]))
      .toEqual([['darwin-arm64','macos-15'],['darwin-x64','macos-15-intel']]);
    const names=job.steps.map((step:any)=>step.uses ?? step.name);
    const bun=names.findIndex((name:string)=>name.startsWith('oven-sh/setup-bun@'));
    expect(bun).toBeGreaterThan(-1);
    expect(bun).toBeLessThan(names.indexOf('Lightweight supervisor regression'));
    expect(job.steps[bun].with['bun-version']).toBe('1.4.2');
    const build=names.indexOf('Build the workspace client the regression imports');
    expect(build).toBeGreaterThan(bun);
    expect(build).toBeLessThan(names.indexOf('Lightweight supervisor regression'));
    expect(job.steps[build].run).toContain('bun run --filter @undefineds.co/xpod-client build');
  });
});
