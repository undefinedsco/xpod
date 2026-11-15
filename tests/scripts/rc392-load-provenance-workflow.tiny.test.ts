/** RC392: the candidate build_image step must export the SAME single-target image to
 *  both the local Docker engine and the registry, while keeping the provenance policy
 *  the pre-existing default produced, and while leaving the retention step's exact
 *  immutable-digest pull admission untouched.
 *
 *  These assertions are structural on the real workflow text, so they fail for the
 *  four ways this fix can regress: a missing local export, a dropped/relaxed
 *  provenance mode, a disabled registry push, or a removed/softened exact pull. */
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

const WORKFLOW = readFileSync('.github/workflows/candidate.yml', 'utf8');
const ORIGINALS = readFileSync('qlever/scripts/sdk-service-image-originals.py', 'utf8');

/** The exact `Build and push RC image` step body, from its `with:` to the next step. */
function buildStep(text: string): string {
  const start = text.indexOf('- name: Build and push RC image');
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n      - name:', start + 10);
  return text.slice(start, next === -1 ? undefined : next);
}

const STEP = buildStep(WORKFLOW);

describe('RC392 build_image exports', () => {
  test('the one existing target is exported BOTH locally and to the registry', () => {
    expect(/^\s+load: true$/m.test(STEP)).toBe(true);
    expect(/^\s+push: true$/m.test(STEP)).toBe(true);
    // one target only: no matrix/platform fan-out added to this step
    expect(/platforms:/.test(STEP)).toBe(false);
    // the immutable digest output stays the registry identity handed to retention
    expect(STEP).toContain('id: build');
  });

  test('the provenance policy is stated explicitly and stays mode=max', () => {
    // `load` makes the docker exporter present, which suppresses the ACTION's
    // implicit attestation; without this line provenance would silently disappear.
    expect(/^\s+provenance: mode=max$/m.test(STEP)).toBe(true);
    expect(/provenance:\s*(false|none|min)/.test(STEP)).toBe(false);
  });

  test('the registry push is not disabled to gain the local copy', () => {
    expect(/^\s+push: false$/m.test(STEP)).toBe(false);
    expect(STEP).toContain('ghcr.io/undefinedsco/xpod:sha-');
    expect(STEP).toContain('cache-to: type=gha,mode=max,scope=xpod-server');
  });
});

describe('RC392 retention admission is unchanged', () => {
  test('the retention step still pulls the exact immutable digest', () => {
    // the pull is the only empirical proof the pushed digest is readable/correct
    expect(ORIGINALS).toContain("if mode=='pull':command=['docker','pull','--platform','linux/amd64',image]");
    // ...and the container is still created without an implicit second pull
    expect(ORIGINALS).toContain('--pull=never');
    expect(WORKFLOW).toContain('--service-image "ghcr.io/undefinedsco/xpod@${BUILD_DIGEST}"');
    expect(WORKFLOW).toContain('BUILD_DIGEST: ${{ steps.build.outputs.digest }}');
  });

  test('the original retention deadline and cleanup reserves are untouched', () => {
    expect(WORKFLOW).toContain('--deadline "$(( $(date +%s) + 120 ))"');
    expect(ORIGINALS).toContain("stage('pull',cap=90)");
    expect(ORIGINALS).toContain('lambda:budget.check(10)');
    expect(ORIGINALS).toContain('lambda:budget.check(0 if cleanup else 10)');
  });
});
