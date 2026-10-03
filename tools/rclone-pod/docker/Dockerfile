# Study-only image for the Linux FUSE mount experiment.
# Build context: tools/rclone-pod/bin/linux-arm64 (contains xpod-rclone).
FROM alpine:3.22
RUN apk add --no-cache fuse3 ca-certificates
COPY xpod-rclone /usr/local/bin/xpod-rclone
ENTRYPOINT ["/usr/local/bin/xpod-rclone"]
