#!/usr/bin/env node
const { execFileSync } = require('node:child_process');

const [testedImageId, publishedImage] = process.argv.slice(2);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const reference = /^[a-z0-9][a-z0-9./:_-]*@(sha256:[a-f0-9]{64})$/.exec(publishedImage || '');
if (process.argv.length !== 4 || !digestPattern.test(testedImageId || '') || !reference) {
  throw new Error('Expected a tested sha256 image ID and an immutable published image@sha256 reference');
}

function inspect(image) {
  return JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', image], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  }));
}

const indexTypes = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const imageTypes = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
let manifest = inspect(publishedImage);
if (manifest?.schemaVersion === 2 && indexTypes.has(manifest.mediaType)) {
  const images = manifest.manifests?.filter((entry) =>
    entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64' &&
    entry.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
  if (images?.length !== 1 || !imageTypes.has(images[0].mediaType) || !digestPattern.test(images[0].digest)) {
    throw new Error('Published index must contain exactly one linux/amd64 image manifest');
  }
  manifest = inspect(`${publishedImage.slice(0, publishedImage.lastIndexOf('@'))}@${images[0].digest}`);
}

// Buildx's imageid output is a config digest for --load, but may be the index
// digest for --push. Compare the registry image's config, not its attestation index.
if (manifest?.schemaVersion !== 2 || !imageTypes.has(manifest.mediaType) ||
    !digestPattern.test(manifest.config?.digest || '') || manifest.config.digest !== testedImageId) {
  throw new Error('Published image config does not match the tested image ID');
}
console.log(`Verified published image config: ${testedImageId}`);
