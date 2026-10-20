# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG XPOD_QLEVER_SDK_BASE_IMAGE=debian:trixie-20260803-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258
FROM ${XPOD_QLEVER_SDK_BASE_IMAGE} AS source-prepared

ARG XPOD_QLEVER_SDK_BASE_IMAGE
ARG XPOD_QLEVER_BUILD_JOBS=4
ENV DEBIAN_FRONTEND=noninteractive \
    XPOD_QLEVER_SDK_BASE_IMAGE=${XPOD_QLEVER_SDK_BASE_IMAGE} \
    XPOD_QLEVER_CMAKE_C_COMPILER=clang-19 \
    XPOD_QLEVER_CMAKE_CXX_COMPILER=clang++-19 \
    XPOD_QLEVER_SOURCE_DIR=/opt/qlever-sdk/source \
    XPOD_QLEVER_BUILD_DIR=/opt/qlever-sdk/build

RUN printf '%s' "${XPOD_QLEVER_SDK_BASE_IMAGE}" \
    | grep -Eq '^.+@sha256:[0-9a-f]{64}$' \
 || { echo "XPOD_QLEVER_SDK_BASE_IMAGE must be an immutable digest reference" >&2; exit 64; }

# Retain the same Trixie repositories and their source indexes for actual materials.
RUN sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources

RUN apt-get -o Acquire::Retries=5 -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false update \
 && apt-get -o APT::Get::AllowUnauthenticated=false install -y --no-install-recommends \
    ca-certificates \
    debian-archive-keyring \
    gpgv \
    binutils \
    clang-19 \
    cmake \
    git \
    libboost-container-dev \
    libboost-iostreams-dev \
    libboost-program-options-dev \
    libboost-url-dev \
    libbz2-dev \
    libicu-dev \
    liblzma-dev \
    libssl-dev \
    libzstd-dev \
    lld-19 \
    make \
    python3 \
    zlib1g-dev

COPY .dockerignore /opt/qlever-sdk/profile/.dockerignore
COPY scripts/lib/module-artifact-limits.json /components/scripts/lib/module-artifact-limits.json
COPY scripts/agentfs-native-ci/supervise.py /components/scripts/agentfs-native-ci/supervise.py
COPY qlever/qlever.lock.json /components/qlever/qlever.lock.json
COPY qlever/patches /components/qlever/patches
COPY qlever/cmake /components/qlever/cmake
COPY qlever/qlever_adapter /components/qlever/qlever_adapter
COPY qlever/include /components/qlever/include
COPY qlever/rdf_protocol /components/qlever/rdf_protocol
COPY qlever/backend_contract /components/qlever/backend_contract
COPY qlever/candidate_contract /components/qlever/candidate_contract
COPY qlever/scripts/*.py qlever/scripts/*.sh /components/qlever/scripts/
COPY qlever/qlever_local_runtime /components/qlever/qlever_local_runtime
COPY qlever/rdf_sqlite_backend /components/qlever/rdf_sqlite_backend
COPY docker/qlever-runtime-sdk/Dockerfile /opt/qlever-sdk/profile/Dockerfile
COPY docker/qlever-local-runtime/Dockerfile /opt/qlever-sdk/profile/runtime.Dockerfile

# This private build deadline is derived once by the owning SDK workflow.
ARG XPOD_QLEVER_SDK_DEADLINE_UNIX
ARG XPOD_QLEVER_SDK_IDENTITY
# Preparation owns clone/patch/normalization before any source becomes RO.
RUN XPOD_QLEVER_SDK_IDENTITY="${XPOD_QLEVER_SDK_IDENTITY}" XPOD_QLEVER_SDK_DEADLINE_UNIX="${XPOD_QLEVER_SDK_DEADLINE_UNIX}" exec python3 /components/qlever/scripts/sdk-owned-runs.py sourcePrepare

FROM source-prepared AS build
ARG XPOD_QLEVER_SDK_DEADLINE_UNIX
ARG XPOD_QLEVER_SDK_IDENTITY
# Prepared dependency sources are RO; dependency binary outputs stay in build.
# exec keeps the kernel-owned guard as the entire RUN's namespace PID1.
RUN --mount=type=bind,from=source-prepared,source=/opt/qlever-sdk/source,target=/opt/qlever-sdk/source,ro \
    --mount=type=bind,from=source-prepared,source=/opt/qlever-sdk/dependencies,target=/opt/qlever-sdk/dependencies,ro \
    --mount=type=bind,from=source-prepared,source=/components,target=/components,ro \
    --mount=type=bind,from=source-prepared,source=/usr,target=/usr,ro \
    --mount=type=bind,from=source-prepared,source=/etc/alternatives,target=/etc/alternatives,ro \
    --mount=type=bind,from=source-prepared,source=/etc/ld.so.cache,target=/etc/ld.so.cache,ro \
    --mount=type=bind,from=source-prepared,source=/etc/ld.so.conf,target=/etc/ld.so.conf,ro \
    --mount=type=bind,from=source-prepared,source=/etc/ld.so.conf.d,target=/etc/ld.so.conf.d,ro \
    --mount=type=bind,from=source-prepared,source=/var/lib/dpkg,target=/var/lib/dpkg,ro \
    XPOD_QLEVER_SDK_IDENTITY="${XPOD_QLEVER_SDK_IDENTITY}" XPOD_QLEVER_SDK_DEADLINE_UNIX="${XPOD_QLEVER_SDK_DEADLINE_UNIX}" exec python3 /components/qlever/scripts/sdk-owned-runs.py build

FROM build AS linked-verification
# Verification scripts enter only after the compiler cache boundary.
COPY qlever/scripts/check-qlever-real-adapter-build.cjs /components/qlever/scripts/check-qlever-real-adapter-build.cjs
COPY qlever/scripts/check-qlever-real-runtime.cjs /components/qlever/scripts/check-qlever-real-runtime.cjs
COPY qlever/scripts/check-qlever-upstream-patches.cjs /components/qlever/scripts/check-qlever-upstream-patches.cjs
ARG XPOD_QLEVER_SDK_DEADLINE_UNIX
ARG XPOD_QLEVER_SDK_IDENTITY
RUN XPOD_QLEVER_SDK_DEADLINE_UNIX="${XPOD_QLEVER_SDK_DEADLINE_UNIX}" exec python3 /components/qlever/scripts/sdk-owned-runs.py linked
# The owned linked RUN installs Node once; retain its actual version in BuildKit raw.
RUN node --version

FROM build AS runtime
# Retain actual test originals, not a synthetic .ok marker or another copy of
# all source shards. The tested SDK source/build tree is inherited from build.
COPY --from=linked-verification /opt/qlever-sdk/materials/linked-inner.json /opt/qlever-sdk/materials/owner-linked.guard.json /opt/qlever-sdk/materials/
COPY --from=linked-verification /opt/qlever-sdk/materials/stages/test-adapter /opt/qlever-sdk/materials/stages/test-adapter
COPY --from=linked-verification /opt/qlever-sdk/materials/stages/test-runtime /opt/qlever-sdk/materials/stages/test-runtime
COPY --from=linked-verification /opt/qlever-sdk/materials/stages/test-adapter.raw.log /opt/qlever-sdk/materials/stages/test-adapter.receipt.json /opt/qlever-sdk/materials/stages/test-runtime.raw.log /opt/qlever-sdk/materials/stages/test-runtime.receipt.json /opt/qlever-sdk/materials/stages/

RUN test -f /opt/qlever-sdk/source/src/libqlever/Qlever.h \
 && test -f /opt/qlever-sdk/build/.xpod-build-identity \
 && test -f /opt/qlever-sdk/build/.xpod-build-contract.json \
 && test -f /opt/qlever-sdk/build/CMakeFiles/qlever-server.dir/link.txt \
 && test -f /opt/qlever-sdk/materials/linked-inner.json \
 && test -d /components/qlever/cmake \
 && test -d /components/qlever/qlever_adapter \
 && test -d /components/qlever/rdf_protocol \
 && test -d /components/qlever/backend_contract \
 && test -d /components/qlever/candidate_contract \
 && test ! -e /components/qlever/qlever_pg_extension \
 && test ! -e /components/pg-rdf-extension \
 && ! command -v node >/dev/null 2>&1

LABEL org.opencontainers.image.title="Xpod QLever runtime SDK" \
      org.opencontainers.image.description="Locked QLever runtime libraries and public Xpod physical-backend headers"
