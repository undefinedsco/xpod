'use strict';

// Project publication budgets, not a claim about the registry's server limits.
// npm publishes the tarball as base64 in a JSON attachment. Reserve metadata
// separately so a tar-only check cannot accept an oversized request.
const MAX_PLATFORM_TARBALL_BYTES = 180 * 1024 * 1024;
const MAX_PLATFORM_PUBLISH_BODY_BYTES = 240 * 1024 * 1024;
const PUBLISH_METADATA_RESERVE_BYTES = 64 * 1024;

function verifyPlatformPackageBudget(pack, target, version) {
  if (!pack || pack.name !== target.packageName || pack.version !== version
    || !Number.isSafeInteger(pack.size) || pack.size <= 0) {
    throw new Error('Invalid platform pack identity or measured size');
  }
  const required = [target.binaryName, 'qlever/bin/xpod_qlever_local_runtime', 'SOURCE/SOURCE-MANIFEST.json', 'LICENSE'];
  for (const name of required) {
    if (!pack.files?.some((file) => file.path === name && file.size > 0)) {
      throw new Error(`Required platform package file is missing: ${name}`);
    }
  }
  const base64AttachmentBytes = 4 * Math.ceil(pack.size / 3);
  const publishBodyUpperBoundBytes = base64AttachmentBytes + PUBLISH_METADATA_RESERVE_BYTES;
  if (pack.size > MAX_PLATFORM_TARBALL_BYTES || publishBodyUpperBoundBytes > MAX_PLATFORM_PUBLISH_BODY_BYTES) {
    throw new Error(`Platform package exceeds project publication budget: tarball=${pack.size}, publish-body-upper-bound=${publishBodyUpperBoundBytes}`);
  }
  return {
    schemaVersion: 1,
    kind: 'platform-package-publication-budget',
    budgetOrigin: 'project',
    ok: true,
    packageName: pack.name,
    version: pack.version,
    packedBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    integrity: pack.integrity,
    base64AttachmentBytes,
    publishMetadataReserveBytes: PUBLISH_METADATA_RESERVE_BYTES,
    publishBodyUpperBoundBytes,
    maxTarballBytes: MAX_PLATFORM_TARBALL_BYTES,
    maxPublishBodyBytes: MAX_PLATFORM_PUBLISH_BODY_BYTES,
  };
}

module.exports = { verifyPlatformPackageBudget, MAX_PLATFORM_TARBALL_BYTES, MAX_PLATFORM_PUBLISH_BODY_BYTES };
