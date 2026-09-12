/**
 * npm dist-tag rules shared by the release and single-package publish scripts.
 *
 * A prerelease never belongs on `latest`: npm assigns that tag by default, which
 * is how `0.1.1-rc.0` ended up as the latest published version of a workspace
 * package. Callers publish prereleases under their own tag (rc, preview, …) and
 * let only stable versions reach `latest`.
 */
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
  inferPublishTag,
  isSemverLike,
  resolvePublishTag,
  validatePublishTag,
};
