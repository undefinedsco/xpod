#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  echo "run-focused-native-build: $*" >&2
  exit 64
}

require_absolute_directory() {
  local value=$1
  local label=$2
  [[ "$value" == /* && "$value" != "/" ]] \
    || fail "$label must be an absolute non-root path"
}

require_digest_ref() {
  local value=$1
  local label=$2
  [[ "$value" =~ ^.+@sha256:[0-9a-f]{64}$ ]] \
    || fail "$label must be an immutable @sha256 image ref"
}

[[ "$(uname -s)" == "Linux" ]] \
  || fail "native compilation is restricted to a remote Linux worker"

workspace_root=${XPOD_QLEVER_WORKSPACE_ROOT:?XPOD_QLEVER_WORKSPACE_ROOT is required}
qlever_source_dir=${XPOD_QLEVER_SOURCE_DIR:-/opt/qlever-sdk/source}
qlever_build_dir=${XPOD_QLEVER_BUILD_DIR:-/opt/qlever-sdk/build}
local_build_dir=${XPOD_QLEVER_LOCAL_BUILD_DIR:?XPOD_QLEVER_LOCAL_BUILD_DIR is required}
artifact_dir=${XPOD_QLEVER_LOCAL_ARTIFACT_DIR:?XPOD_QLEVER_LOCAL_ARTIFACT_DIR is required}
output_dir=${XPOD_QLEVER_BUILD_OUTPUT_DIR:?XPOD_QLEVER_BUILD_OUTPUT_DIR is required}
build_jobs=${XPOD_QLEVER_BUILD_JOBS:-8}
prior_sdk_image=${XPOD_QLEVER_PRIOR_SDK_IMAGE:?XPOD_QLEVER_PRIOR_SDK_IMAGE is required}
for path_and_label in \
  "$workspace_root:XPOD_QLEVER_WORKSPACE_ROOT" \
  "$qlever_source_dir:XPOD_QLEVER_SOURCE_DIR" \
  "$qlever_build_dir:XPOD_QLEVER_BUILD_DIR" \
  "$local_build_dir:XPOD_QLEVER_LOCAL_BUILD_DIR" \
  "$artifact_dir:XPOD_QLEVER_LOCAL_ARTIFACT_DIR" \
  "$output_dir:XPOD_QLEVER_BUILD_OUTPUT_DIR"
do
  require_absolute_directory "${path_and_label%%:*}" "${path_and_label#*:}"
done
[[ "$build_jobs" =~ ^[1-9][0-9]*$ ]] \
  || fail "XPOD_QLEVER_BUILD_JOBS must be a positive integer"
require_digest_ref "$prior_sdk_image" XPOD_QLEVER_PRIOR_SDK_IMAGE

case "$artifact_dir/" in
  "$output_dir/"*) ;;
  *) fail "XPOD_QLEVER_LOCAL_ARTIFACT_DIR must be inside XPOD_QLEVER_BUILD_OUTPUT_DIR" ;;
esac
[[ "$artifact_dir" != "$output_dir" ]] \
  || fail "XPOD_QLEVER_LOCAL_ARTIFACT_DIR must be below XPOD_QLEVER_BUILD_OUTPUT_DIR"

local_runtime_source="$workspace_root/qlever/qlever_local_runtime"
lock_file="$workspace_root/qlever/qlever.lock.json"
artifact_verifier="$workspace_root/qlever/scripts/verify-local-runtime-artifacts.py"
overlay_manifest_tool="$workspace_root/qlever/scripts/runtime-overlay-manifest.py"
build_log="$output_dir/build.log"

run_build() {
  trap 'echo "focused native build failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

  test -f "$local_runtime_source/CMakeLists.txt"
  test -f "$lock_file"
  test -f "$artifact_verifier"
  test -f "$overlay_manifest_tool"
  test -f "$qlever_build_dir/compile_commands.json"
  test -f "$qlever_build_dir/.xpod-build-identity"
  test -f "$qlever_build_dir/.xpod-overlay-identity"

  export DEBIAN_FRONTEND=noninteractive
  if ! test -f /usr/include/sqlite3.h; then
    command -v apt-get >/dev/null \
      || fail "libsqlite3-dev is missing and apt-get is unavailable"
    apt-get -o Acquire::Retries=5 update
    apt-get install -y --no-install-recommends libsqlite3-dev
    rm -rf /var/lib/apt/lists/*
  fi

  local expected_identity
  expected_identity=$(python3 -c \
    'import json,sys; lock=json.load(open(sys.argv[1], encoding="utf-8")); print("{}:{}".format(lock["commit"], lock["patchSeriesSha256"]), end="")' \
    "$lock_file")
  test "$(cat "$qlever_build_dir/.xpod-build-identity")" = "$expected_identity"

  local overlay_manifest_current
  overlay_manifest_current=$(mktemp)
  python3 "$overlay_manifest_tool" \
    --qlever-root "$workspace_root/qlever" >"$overlay_manifest_current"
  local current_overlay_identity
  current_overlay_identity=$(sha256sum "$overlay_manifest_current" | cut -d' ' -f1)
  rm -f "$overlay_manifest_current"
  local prior_overlay_identity
  prior_overlay_identity=$(tr -d '\r\n' <"$qlever_build_dir/.xpod-overlay-identity")
  if [[ "$prior_overlay_identity" != "$current_overlay_identity" ]]; then
    fail "prior SDK overlay identity mismatch; rebuild the runtime SDK incrementally before focused local runtime build"
  fi

  local dependency_includes
  dependency_includes=$(python3 -c \
    'import json,shlex,sys; commands=json.load(open(sys.argv[1], encoding="utf-8")); tokens=[token for entry in commands for token in (entry.get("arguments") or shlex.split(entry.get("command", "")))]; separated=[tokens[index + 1] for index, token in enumerate(tokens[:-1]) if token in {"-I", "-isystem", "-iquote", "-idirafter"}]; joined=[token[2:] for token in tokens if token.startswith("-I") and len(token) > 2] + [token[len("-isystem"):] for token in tokens if token.startswith("-isystem") and len(token) > len("-isystem")]; print(";".join(dict.fromkeys(path for path in separated + joined if path.startswith("/opt/qlever-sdk/"))))' \
    "$qlever_build_dir/compile_commands.json")

  rm -rf "$artifact_dir"
  mkdir -p "$local_build_dir" "$artifact_dir" "$output_dir/logs"
  local c_compiler cxx_compiler linker
  c_compiler=$(python3 "$workspace_root/qlever/scripts/qlever_compiler_profile.py" c)
  cxx_compiler=$(python3 "$workspace_root/qlever/scripts/qlever_compiler_profile.py" cxx)
  linker=$(python3 "$workspace_root/qlever/scripts/qlever_compiler_profile.py" linker)
  CC="$c_compiler" CXX="$cxx_compiler" cmake \
    -S "$local_runtime_source" \
    -B "$local_build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$artifact_dir" \
    -DXPOD_QLEVER_SOURCE_DIR="$qlever_source_dir" \
    -DXPOD_QLEVER_BUILD_DIR="$qlever_build_dir" \
    -DXPOD_QLEVER_DEPENDENCY_INCLUDE_DIRS="$dependency_includes" \
    -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=$linker" \
    -DCMAKE_SHARED_LINKER_FLAGS="-fuse-ld=$linker"
  cmake --build "$local_build_dir" \
    --target xpod_qlever_local_runtime \
    -- -j"$build_jobs"
  cmake --install "$local_build_dir"

  test -x "$artifact_dir/bin/xpod_qlever_local_runtime"
  # Notice selection/copy is part of the fixed build program so the image
  # build and the observed replay derive SAME members from SAME roots.
  python3 - "$workspace_root" "$qlever_source_dir" "$artifact_dir" "$output_dir" <<'NOTICE_COPY_PY'
import hashlib, json, os, re, stat, sys
workspace, sdk_source, artifact, output = sys.argv[1:5]
NOTICE = re.compile(r'^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$', re.I)
MAX_FILES = 20000
MAX_BYTES = 16 * 1024 * 1024
MAX_NOTICES = 1024
SDK_DEPENDENCIES = '/opt/qlever-sdk/dependencies'
SDK_COLLECTION = '/opt/qlever-sdk/materials/fetchcontent/materials.json'

def need(ok, why):
    if not ok:
        raise SystemExit('notice program: ' + why)

def bounded_file(path):
    st = os.lstat(path)
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, 'single-link regular notice required')
    need(0 < st.st_size <= MAX_BYTES, 'bounded notice file required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        held = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
        ident = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns)
        need(ident(os.fstat(fd)) == held, 'notice replaced before read')
        chunks, count = [], 0
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            count += len(block)
            need(count <= st.st_size, 'notice grew during read')
            chunks.append(block)
        need(count == st.st_size and ident(os.fstat(fd)) == held == ident(os.lstat(path)),
             'notice changed during read')
    finally:
        os.close(fd)
    data = b''.join(chunks)
    return data, hashlib.sha256(data).hexdigest(), stat.S_IMODE(st.st_mode)

MATERIALS_ROOT = '/opt/qlever-sdk/materials'
MAX_INVENTORY = 4 * 1024 * 1024
MAX_SHARDS = 4096
MAX_MEMBERS = 200000

def bounded_ref_bytes(materials_root, reference, label):
    """Open ONE declared original ref under the materials root: bounded, no
    symlink, single link, held-FD identity, exact bytes+SHA from the ref."""
    need(isinstance(reference, dict) and set(reference) == {'path', 'bytes', 'sha256'},
         label + ' ref shape')
    rel = reference['path']
    need(isinstance(rel, str) and rel and not rel.startswith('/') and '..' not in rel.split('/')
         and not rel.split('/').__contains__('') and '\\' not in rel, label + ' canonical relative path')
    need(type(reference['bytes']) is int and 0 < reference['bytes'] <= MAX_INVENTORY,
         label + ' bounded declared bytes')
    need(isinstance(reference['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', reference['sha256']),
         label + ' declared SHA-256')
    path = os.path.join(materials_root, rel)
    need(os.path.isfile(path) and not os.path.islink(path),
         label + ' declared original is absent or a link')
    st = os.lstat(path)
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size == reference['bytes'],
         label + ' held original size/link')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        held = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
        ident = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns)
        need(ident(os.fstat(fd)) == held, label + ' descriptor identity')
        chunks, count = [], 0
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            count += len(block)
            need(count <= st.st_size, label + ' grew during read')
            chunks.append(block)
        need(count == st.st_size and ident(os.fstat(fd)) == held == ident(os.lstat(path)),
             label + ' changed during read')
    finally:
        os.close(fd)
    data = b''.join(chunks)
    need(hashlib.sha256(data).hexdigest() == reference['sha256'],
         label + ' declared SHA differs from the actual opened bytes')
    return data

def declared_inventory(materials_root, reference, label):
    """Open the DECLARED sourceInventory ref and build the actual physical
    member map from its authenticated shards. Ref shape/metadata alone is never
    accepted: the raw bytes are opened and hashed, and each shard too."""
    raw = bounded_ref_bytes(materials_root, reference, label + ' inventory')
    index = json.loads(raw)
    need(index.get('schemaVersion') == 1 and isinstance(index.get('shards'), list)
         and 0 < len(index['shards']) <= MAX_SHARDS, label + ' sharded inventory')
    members = {}
    total = 0
    for shard in index['shards']:
        shard_raw = bounded_ref_bytes(materials_root, shard, label + ' inventory shard')
        value = json.loads(shard_raw)
        need(value.get('schemaVersion') == 1 and isinstance(value.get('files'), list),
             label + ' inventory shard files')
        for row in value['files']:
            need(isinstance(row, dict) and isinstance(row.get('path'), str) and row['path']
                 and not row['path'].startswith('/') and '..' not in row['path'].split('/')
                 and row.get('kind') in ('file', 'symlink')
                 and type(row.get('bytes')) is int and row['bytes'] >= 0
                 and isinstance(row.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
                 and type(row.get('mode')) is int,
                 label + ' canonical inventory member')
            need(row['path'] not in members, label + ' duplicate inventory member')
            members[row['path']] = row
            total += row['bytes']
            need(len(members) <= MAX_MEMBERS and total <= 512 * 1024 * 1024,
                 label + ' inventory bound')
    need(len(members) == index.get('files'), label + ' inventory member count')
    return members

def add(root, path, universe, relative_prefix, rows, seen, contributor, source_original,
        pending, inventory_members=None):
    """One authenticated notice, bound to its actual contributing root.

    When the contributor declares a physical inventory, the notice's own
    relative path MUST be an actual member of that authenticated inventory with
    the same bytes/SHA/mode. A contributor label plus a copied ref is never
    evidence on its own.
    """
    rel = os.path.relpath(path, root)
    relative = 'notices/' + relative_prefix + '/' + rel
    need(relative not in seen, 'duplicate notice destination')
    seen.add(relative)
    data, digest, mode = bounded_file(path)
    need(len(data) <= MAX_BYTES and len(rows) < MAX_NOTICES, 'bounded applicable notice')
    if inventory_members is not None:
        member = inventory_members.get(rel)
        need(member is not None, 'notice is not a declared inventory member: ' + rel)
        need(member.get('kind') == 'file' and member['bytes'] == len(data)
             and member['sha256'] == digest and (member['mode'] & 0o7777) == mode,
             'notice differs from its declared inventory member: ' + rel)
    rows.append(dict(sourcePath=path, sourcePathKey=universe + ':' + rel, relative=relative,
                     bytes=len(data), sha256=digest, mode=mode,
                     contributor=contributor, sourceOriginal=source_original,
                     inventoryPath=(rel if inventory_members is not None else None)))
    return None

def top_level_notices(root, universe, relative_prefix, rows, seen, contributor, source_original,
                      recurse=False, inventory_members=None):
    need(os.path.isdir(root), universe + ' root required')
    files = 0
    if recurse:
        for directory, subdirs, names in os.walk(root, followlinks=False):
            subdirs[:] = sorted(name for name in subdirs if name not in ('.git', 'node_modules'))
            for name in sorted(names):
                files += 1
                need(files <= MAX_FILES, 'bounded notice inventory walk')
                if not NOTICE.fullmatch(name):
                    continue
                path = os.path.join(directory, name)
                if not os.path.isfile(path) or os.path.islink(path):
                    continue
                add(root, path, universe, relative_prefix, rows, seen, contributor, source_original, None,
                    inventory_members)
        return
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isfile(path) or os.path.islink(path):
            continue
        files += 1
        need(files <= MAX_FILES, 'bounded notice inventory walk')
        if NOTICE.fullmatch(name):
            add(root, path, universe, relative_prefix, rows, seen, contributor, source_original, None,
                inventory_members)

rows, pending, seen = [], [], set()
# 1. Project notices: ONLY the exact Docker COPY roots below. These exist
#    identically inside the image build context and the replay checkout, so the
#    derived notice member set cannot diverge and unused repo paths (including
#    node_modules) are never walked.
COPY_ROOTS = ('cmake', 'include', 'patches', 'qlever_adapter',
              'qlever_local_runtime', 'rdf_protocol', 'rdf_sqlite_backend', 'scripts')
# V13: the real checkout has NO qlever/LICENSE|NOTICE|COPYING|COPYRIGHT (verified
# with `git ls-tree`). Claiming them manufactured an empty/creative universe and
# only "passed" because the old fixture invented the file. The authoritative
# ancestor licence text that actually ships with the workspace is the REPOSITORY
# ROOT LICENSE, which the runtime Dockerfile now COPYs explicitly alongside the
# qlever/ COPY roots. `qlever.lock.json` is a real tracked file in the qlever
# COPY scope and stays.
WORKSPACE_ROOT_FILES = (os.path.join(workspace, 'LICENSE'),)
QLVER_TOP_FILES = ('qlever.lock.json',)
qlever_root = os.path.join(workspace, 'qlever')
need(os.path.isdir(qlever_root), 'qlever workspace subset required')
for path in WORKSPACE_ROOT_FILES:
    if not os.path.isfile(path) or os.path.islink(path):
        # Absent authoritative ancestor licence is an honest pending, never an
        # invented member.
        pending.append('workspace-ancestor-notice-absent:' + os.path.basename(path))
        continue
    add(workspace, path, 'workspace', 'workspace', rows, seen,
        dict(kind='workspace-ancestor-file', path=os.path.basename(path)),
        dict(kind='workspace-copy-inventory', path=os.path.basename(path)), None)
for file_name in QLVER_TOP_FILES:
    path = os.path.join(qlever_root, file_name)
    if os.path.isfile(path) and not os.path.islink(path):
        add(qlever_root, path, 'workspace', 'workspace', rows, seen,
            dict(kind='workspace-copy-file', path='qlever/' + file_name),
            dict(kind='workspace-copy-inventory', path='qlever/' + file_name), None)
for root_name in COPY_ROOTS:
    root_path = os.path.join(qlever_root, root_name)
    if not os.path.isdir(root_path):
        pending.append('workspace-copy-root-absent:' + root_name)
        continue
    top_level_notices(root_path, 'workspace/' + root_name, 'workspace/' + root_name,
                      rows, seen, dict(kind='workspace-copy-root', path='qlever/' + root_name),
                      dict(kind='workspace-copy-inventory', path='qlever/' + root_name), recurse=True)
# 2. Upstream QLever source notices from the pinned SDK source root.
if os.path.isdir(sdk_source):
    top_level_notices(sdk_source, 'upstream', 'upstream', rows, seen,
                      dict(kind='sdk-source-root', path=sdk_source),
                      dict(kind='sdk-source-manifest', path='/opt/qlever-sdk/build/.xpod-source-manifest'))
else:
    pending.append('authenticated-upstream-source-root-absent')
# 3. FetchContent dependencies: the real prepared collection is the unique
#    authenticated declared set. Only declared (used) contributors contribute.
declared = []
if os.path.isfile(SDK_COLLECTION):
    raw = open(SDK_COLLECTION, 'rb').read()
    need(0 < len(raw) <= 4 * 1024 * 1024, 'bounded fetchcontent collection')
    collection = json.loads(raw)
    need(collection.get('schemaVersion') == 1
         and collection.get('kind') == 'qlever-sdk-fetchcontent-prepared-originals'
         and collection.get('dependenciesRoot') == SDK_DEPENDENCIES, 'actual prepared collection')
    declared_rows = collection.get('dependencies')
    need(isinstance(declared_rows, list) and declared_rows, 'declared fetchcontent dependencies required')
    names = set()
    for row in declared_rows:
        need(isinstance(row, dict) and isinstance(row.get('name'), str) and row['name']
             and isinstance(row.get('sourceRoot'), str)
             and row['sourceRoot'] == os.path.join(SDK_DEPENDENCIES, row['name'])
             and isinstance(row.get('sourceInventory'), dict)
             and set(row['sourceInventory']) == {'path', 'bytes', 'sha256'},
             'actual declared contributor identity required')
        need(row['name'] not in names, 'unique declared contributor')
        names.add(row['name'])
        inventory = row['sourceInventory']
        declared.append((row['name'], row['sourceRoot'], inventory))
else:
    pending.append('pinned-SDK-FetchContent-prepared-collection-absent')
if os.path.isdir(SDK_DEPENDENCIES):
    present = {name for name in os.listdir(SDK_DEPENDENCIES)
               if os.path.isdir(os.path.join(SDK_DEPENDENCIES, name))}
    if declared:
        used = {name for name, _root, _inventory in declared}
        unused = sorted(present - used)
        if unused:
            pending.append('declared-dependency-unused-roots:' + ','.join(unused))
        missing = sorted(used - present)
        if missing:
            pending.append('declared-dependency-root-absent:' + ','.join(missing))
        for name, root, inventory in declared:
            if not os.path.isdir(root):
                continue
            # C4: OPEN and HASH the declared inventory (and each of its shards)
            # through the bounded nofollow reader, then require every copied
            # notice to be an actual member of it. The ref is not a label.
            members = declared_inventory(MATERIALS_ROOT, inventory, 'dependency/' + name)
            top_level_notices(root, 'dependency/' + name, 'dependency/' + name, rows, seen,
                              dict(kind='fetchcontent-declared', name=name, sourceRoot=root),
                              dict(kind='fetchcontent-source-inventory', name=name,
                                   path=inventory['path'], bytes=inventory['bytes'],
                                   sha256=inventory['sha256']), recurse=True,
                              inventory_members=members)
    else:
        pending.append('pinned-SDK-FetchContent-declared-inventory-absent')
else:
    pending.append('pinned-SDK-FetchContent-prepared-collection-absent')
# 4. Copy the exact bounded notices into the artifact (the same artifact tree the
#    runtime image carries) and write the one fixed receipt under /opt/xpod.
for row in rows:
    destination = os.path.join(artifact, row['relative'])
    os.makedirs(os.path.dirname(destination), mode=0o755, exist_ok=True)
    need(not os.path.lexists(destination), 'stale notice destination in artifact')
    data, digest, _mode = bounded_file(row['sourcePath'])
    need(hashlib.sha256(data).hexdigest() == row['sha256'], 'notice changed before copy')
    with open(destination, 'xb') as stream:
        stream.write(data)
    os.chmod(destination, 0o644)
receipt = dict(schemaVersion=1, kind='fixed-native-build-notice-copy', outputRoot=output,
               artifactRoot=artifact, rows=rows, pending=sorted(set(pending)))
raw = json.dumps(receipt, sort_keys=True).encode()
need(0 < len(raw) <= 4 * 1024 * 1024, 'bounded notice receipt')
receipt_path = os.path.join(output, 'notices.receipt.json')
with open(receipt_path, 'wb') as stream:
    stream.write(raw)
    stream.flush()
    os.fsync(stream.fileno())
NOTICE_COPY_PY
  test ! -e "$artifact_dir/lib/libxpod_qlever_adapter.so"
  test ! -e "$artifact_dir/lib/libxpod_rdf_sqlite_backend.so"
  find "$artifact_dir" -type f \( -perm -111 -o -name '*.so' \) -print0 \
    | xargs -0 -r ldd | tee "$output_dir/logs/ldd.log"
  if grep -q 'not found' "$output_dir/logs/ldd.log"; then
    fail "ldd found missing runtime dependencies"
  fi

  python3 "$artifact_verifier" \
    --prefix "$artifact_dir" \
    --lock "$lock_file" \
    --prior-sdk-image "$prior_sdk_image" \
    --smoke-database "$output_dir/runtime-smoke.sqlite"
  test -f "$artifact_dir/manifest.json"
  echo XPOD_FOCUSED_NATIVE_BUILD_DONE
}

mkdir -p "$output_dir"
set +e
(
  set -Eeuo pipefail
  run_build
) >"$build_log" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  tail -n 200 "$build_log"
else
  tail -n 200 "$build_log" >&2
  exit "$status"
fi
