#!/usr/bin/env bash
set -euo pipefail
upstream=$1
pin=0a014ebd4918615baff589ed17486e557e7c6a23
script_dir=$(cd "$(dirname "$0")" && pwd)
if [ ! -d "$upstream/.git" ]; then
  git clone --filter=blob:none https://github.com/tursodatabase/agentfs "$upstream"
fi
git -C "$upstream" checkout --detach "$pin"
for patch in fuse-revalidation.patch nfs-directory-cookie.patch; do
  if git -C "$upstream" apply --check --unidiff-zero "$script_dir/patches/$patch" 2>/dev/null; then
    git -C "$upstream" apply --unidiff-zero "$script_dir/patches/$patch"
  else
    git -C "$upstream" apply --reverse --check --unidiff-zero "$script_dir/patches/$patch"
  fi
done
