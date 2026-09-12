/**
 * npm dist-tag and publishability rules shared by the release and single-package
 * publish scripts.
 *
 * Release candidates exist to run acceptance (a GHCR digest deployed to the
 * *-rc.undefineds.co hosts); RELEASE.md is explicit that they publish no npm
 * package at all, and that npm is published only from the stable workflow —
 * first to the invisible `stable-staging` tag, then to `latest` once reinstalling
 * the packed artifact verifies it. Publishing a prerelease therefore fails here
 * instead of silently becoming the version outsiders install.
 */
function assertPublishable(version, packageName = 'this package') {
  const prerelease = inferPublishTag(version);
  if (prerelease) {
    throw new Error(
      `[publish] refusing to publish ${packageName}@${version}: release candidates are acceptance builds and ` +
      'publish no npm package (see docs/RELEASE.md). Publish from the stable tag workflow instead.',
    );
  }
}

function inferPublishTag(version) {
  const prerelease = version.match(/-(.+)$/)?.[1];
  if (!prerelease) {
    return undefined;
  }

  const tag = prerelease.split('.')[0]?.trim();
  return tag ? tag : undefined;
}

function isSemverLike(value) {
  return /^(?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function validatePublishTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('XPOD_PUBLISH_TAG must be non-empty when set');
  }
  if (tag.trim() !== tag || /\s/.test(tag)) {
    throw new Error('XPOD_PUBLISH_TAG must not contain whitespace');
  }
  if (tag.startsWith('-')) {
    throw new Error('XPOD_PUBLISH_TAG must not start with -');
  }
  if (tag.startsWith('.') || tag.endsWith('.')) {
    throw new Error('XPOD_PUBLISH_TAG must not start or end with .');
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error('XPOD_PUBLISH_TAG contains unsupported characters');
  }
  if (isSemverLike(tag)) {
    throw new Error('XPOD_PUBLISH_TAG must not be a SemVer version');
  }
  return tag;
}

function resolvePublishTag(version, env = process.env) {
  if (Object.hasOwn(env, 'XPOD_PUBLISH_TAG')) {
    return validatePublishTag(env.XPOD_PUBLISH_TAG);
  }

  const inferred = inferPublishTag(version);
  return inferred ? validatePublishTag(inferred) : undefined;
}

module.exports = {
  assertPublishable,
  inferPublishTag,
  isSemverLike,
  resolvePublishTag,
  validatePublishTag,
};
