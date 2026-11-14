#!/usr/bin/env node
/**
 * Guard for releasing the macOS desktop on its own (release-desktop.yml).
 *
 * The desktop ships only for a stable tag whose exact commit
 *  - was accepted for the service by a staging Release Candidate run
 *    (`release-acceptance-<sha>`),
 *  - was accepted for the desktop by that same run (`desktop-acceptance-<sha>`),
 *  - is already deployed to production by the Release workflow,
 * so the desktop never reaches users ahead of the service it talks to.
 *
 * Prints GitHub step outputs (tag, version, image_digest, candidate_version,
 * candidate_run_id) on success.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PRODUCTION_DEPLOY_JOB = 'Deploy production .co';

function validateDesktopRelease({ tag, sha, tagSha, candidateRunId, run, manifest, desktopCheck, releaseJobs }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('release tag must be stable vX.Y.Z');
  if (!/^[0-9a-f]{40}$/.test(sha) || tagSha !== sha) throw new Error('tag commit does not match the workflow source SHA');
  if (!/^\d+$/.test(String(candidateRunId)) || String(run?.id) !== String(candidateRunId)) {
    throw new Error('candidate run identity mismatch');
  }
  if (run.path !== '.github/workflows/candidate.yml' || run.head_branch !== 'staging'
    || run.head_sha !== sha || run.status !== 'completed') {
    throw new Error('candidate run is not a completed staging Release Candidate for the tag commit');
  }
  const version = tag.slice(1);
  if (manifest?.targetVersion !== version || manifest.sourceSha !== sha) {
    throw new Error('service acceptance does not match the tag version and commit');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(manifest.imageDigest))) throw new Error('service acceptance has no image digest');
  if (desktopCheck?.desktop !== 'passed') throw new Error('the candidate did not accept the desktop');
  if (!releaseJobs.some(job => job.name === PRODUCTION_DEPLOY_JOB && job.conclusion === 'success')) {
    throw new Error('the service is not deployed to production for this tag yet');
  }
  return { tag, version, image_digest: manifest.imageDigest, candidate_version: manifest.candidateVersion,
    candidate_run_id: String(candidateRunId) };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error('Invalid arguments');
    args[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ['repository', 'tag', 'sha', 'candidate-run-id', 'work-dir']) {
    if (!args[key]) throw new Error(`Missing --${key}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const gh = (...parts) => execFileSync('gh', parts, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const download = (name) => {
    const directory = path.join(args['work-dir'], name);
    gh('run', 'download', args['candidate-run-id'], '--repo', args.repository, '-n', name, '-D', directory);
    return directory;
  };
  const tagSha = execFileSync('git', ['rev-parse', `${args.tag}^{commit}`], { encoding: 'utf8' }).trim();
  const run = JSON.parse(gh('api', `repos/${args.repository}/actions/runs/${args['candidate-run-id']}`));
  const manifest = JSON.parse(fs.readFileSync(path.join(download(`release-acceptance-${args.sha}`), 'release-acceptance.json'), 'utf8'));
  const desktopCheck = JSON.parse(fs.readFileSync(path.join(download(`desktop-acceptance-${args.sha}`), 'desktop-check.json'), 'utf8'));
  const releaseRuns = JSON.parse(gh('api', `repos/${args.repository}/actions/workflows/release.yml/runs?head_sha=${args.sha}&per_page=20`));
  const releaseJobs = (releaseRuns.workflow_runs ?? []).flatMap(item =>
    JSON.parse(gh('api', `repos/${args.repository}/actions/runs/${item.id}/jobs?filter=latest&per_page=100`)).jobs ?? []);
  const outputs = validateDesktopRelease({ tag: args.tag, sha: args.sha, tagSha, candidateRunId: args['candidate-run-id'],
    run, manifest, desktopCheck, releaseJobs });
  process.stdout.write(Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
}

module.exports = { validateDesktopRelease, PRODUCTION_DEPLOY_JOB };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
