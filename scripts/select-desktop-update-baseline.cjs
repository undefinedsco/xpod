#!/usr/bin/env node
/**
 * Choose the released desktop bundle the self-update acceptance starts from.
 *
 * The candidate workflow used to take the newest stable release blindly. That
 * stopped being a baseline the moment a stable newer than the candidate was
 * published: the released app is then asked to "upgrade" to an older version,
 * which the updater refuses (see `desktop/scripts/packaged-update-acceptance.mjs`
 * and `scripts/desktop-self-update-acceptance.cjs`, whose verifier already
 * requires `oldVersion < newVersion`). No update is offered, the packaged app
 * never installs and never exits, and the acceptance waits forever.
 *
 * Resolving by version order instead keeps the documented contract: pick the
 * newest stable release strictly older than the candidate, or fail loudly when
 * no such release exists.
 *
 * Usage:
 *   gh release list --exclude-pre-releases --exclude-drafts --limit 100 \
 *     --json tagName,publishedAt,isDraft > releases.json
 *   node scripts/select-desktop-update-baseline.cjs \
 *     --candidate 0.4.26-rc.277 --releases releases.json
 */
const fs = require('node:fs');
const path = require('node:path');

const { compareVersions } = require('./desktop-self-update-acceptance.cjs');

/** A published *release* tag: stable only, because the baseline must be a release. */
const RELEASE_VERSION = /^\d+(?:\.\d+)*$/;
/** The candidate may carry a pre-release identifier (`0.4.26-rc.277`). */
const ANY_VERSION = /^\d+(?:\.\d+)*(?:[-+].*)?$/;

function normalizeVersion(value, pattern) {
  const text = String(value ?? '').trim().replace(/^v/, '');
  return pattern.test(text) ? text : undefined;
}

/**
 * Tag of the newest stable release strictly older than the candidate, or
 * `undefined` when the released train has no such baseline.
 */
function selectBaselineTag(releases, candidateVersion) {
  const candidate = normalizeVersion(candidateVersion, ANY_VERSION);
  if (!candidate) {
    throw new Error(`candidate version is not a semantic version: ${candidateVersion}`);
  }
  const eligible = (Array.isArray(releases) ? releases : [])
    // `gh release list --exclude-drafts` already filters these, but a draft row
    // in the input must never become the update baseline on its own either.
    .filter((row) => !(row && (row.isDraft === true || row.draft === true)))
    .map((row) => {
      const tag = String((row && (row.tagName ?? row.tag)) ?? '').trim();
      return { tag, version: normalizeVersion(tag, RELEASE_VERSION) };
    })
    .filter((row) => row.tag && row.version && compareVersions(row.version, candidate) < 0);
  if (eligible.length === 0) return undefined;
  eligible.sort((left, right) => compareVersions(right.version, left.version));
  return eligible[0].tag;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      parsed[key] = value;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.candidate || !args.releases) {
    console.error('usage: select-desktop-update-baseline.cjs --candidate <version> --releases <releases.json>');
    return 2;
  }
  let releases;
  try {
    releases = JSON.parse(fs.readFileSync(path.resolve(String(args.releases)), 'utf8'));
  } catch (error) {
    console.error(`::error::could not read the release list: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const tag = selectBaselineTag(releases, args.candidate);
  if (!tag) {
    console.error(`::error::no stable desktop release older than ${args.candidate} is published, so the released -> candidate self-update cannot be exercised`);
    return 1;
  }
  process.stdout.write(`${tag}\n`);
  return 0;
}

module.exports = { selectBaselineTag };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
