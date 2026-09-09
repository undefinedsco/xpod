# RC R2 object-storage design

## Decision

The release-candidate environment uses the dedicated Cloudflare R2 bucket
`xpod-rc`. It does not deploy an in-cluster MinIO server, persistent volume, or
MinIO credential Secret. Production object storage remains unchanged.

## Configuration ownership

The GitHub `rc` Environment's `APP_ENV_FILE` is the sole source of the RC object
store endpoint, bucket, access key, and secret key. The deployment manifest must
not override those values. RC validation requires all four values and requires
the bucket to be exactly `xpod-rc`; it reports only missing key names and never
prints credential values.

The current public names, `CSS_MINIO_ENDPOINT`, `CSS_MINIO_BUCKET_NAME`,
`CSS_MINIO_ACCESS_KEY`, and `CSS_MINIO_SECRET_KEY`, are retained for this release
because they are already consumed by Xpod and configured in production. They
describe an S3-compatible store despite their historical MinIO naming.

## Naming migration

A subsequent compatibility migration will introduce canonical `CSS_S3_*`
names and retain `CSS_MINIO_*` as deprecated aliases. Resolution will prefer
`CSS_S3_*`, then fall back to `CSS_MINIO_*`. Only after deployed environments
have migrated may the aliases be removed. The accessor should eventually be
named `S3DataAccessor`; this RC storage correction does not mix that broader API
rename into the deployment change.

## Deployment and cleanup

The RC overlay removes `object-store.yaml` and all references to
`xpod-rc-minio`, `xpod-rc-object-store`, and `xpod-rc-minio-init`. The workflow
deploys only Xpod and its existing RC infrastructure. Existing cluster-local
MinIO resources created by earlier candidates are deleted explicitly after the
R2-backed Xpod rollout is healthy; PVC deletion is intentional because the
previous RC MinIO was temporary and has no authoritative data.

## Verification

The candidate workflow must prove:

1. the four object-store variables are present without displaying them;
2. `CSS_MINIO_BUCKET_NAME` equals `xpod-rc`;
3. the rendered overlay contains no MinIO Deployment, Service, Job, PVC, or
   credential Secret reference;
4. Xpod starts with the R2 endpoint from `APP_ENV_FILE`;
5. authenticated Alice Pod writes and reads succeed, while Bob cannot observe
   Alice's provider record;
6. production resources and configuration remain untouched.

## Failure handling

Missing or incorrectly scoped R2 configuration stops deployment before the
runtime Secret is applied. Failed authenticated acceptance emits only the
existing redacted report. No workflow step prints `APP_ENV_FILE` or decoded
credential values.
