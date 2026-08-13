# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG XPOD_QLEVER_SDK_BASE_IMAGE=debian:trixie-20260803-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258
FROM ${XPOD_QLEVER_SDK_BASE_IMAGE}

ARG XPOD_QLEVER_SDK_BASE_IMAGE
ARG XPOD_QLEVER_BUILD_JOBS=4
ENV DEBIAN_FRONTEND=noninteractive \
    XPOD_QLEVER_SOURCE_DIR=/opt/qlever-sdk/source \
    XPOD_QLEVER_BUILD_DIR=/opt/qlever-sdk/build

RUN printf '%s' "${XPOD_QLEVER_SDK_BASE_IMAGE}" \
    | grep -Eq '^.+@sha256:[0-9a-f]{64}$' \
 || { echo "XPOD_QLEVER_SDK_BASE_IMAGE must be an immutable digest reference" >&2; exit 64; }

RUN apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
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
    zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

COPY qlever/qlever.lock.json /components/qlever/qlever.lock.json
COPY qlever/patches /components/qlever/patches
COPY qlever/cmake /components/qlever/cmake
COPY qlever/qlever_adapter /components/qlever/qlever_adapter
COPY qlever/include /components/qlever/include
COPY qlever/rdf_protocol /components/qlever/rdf_protocol
COPY qlever/backend_contract /components/qlever/backend_contract
COPY qlever/candidate_contract /components/qlever/candidate_contract
COPY qlever/scripts/build-qlever-runtime-sdk.sh /components/qlever/scripts/build-qlever-runtime-sdk.sh
COPY qlever/scripts/check-qlever-real-runtime.cjs /components/qlever/scripts/check-qlever-real-runtime.cjs
COPY qlever/scripts/apply-patches.py /components/qlever/scripts/apply-patches.py
COPY qlever/scripts/runtime-overlay-manifest.py /components/qlever/scripts/runtime-overlay-manifest.py
COPY qlever/scripts/sync-patched-source.py /components/qlever/scripts/sync-patched-source.py
COPY qlever/scripts/validate-prior-sdk.py /components/qlever/scripts/validate-prior-sdk.py
COPY qlever/scripts/verify-lock.py /components/qlever/scripts/verify-lock.py

RUN bash /components/qlever/scripts/build-qlever-runtime-sdk.sh \
 && test -f /opt/qlever-sdk/source/src/libqlever/Qlever.h \
 && test -f /opt/qlever-sdk/build/.xpod-build-identity \
 && test -f /opt/qlever-sdk/build/.xpod-build-contract.json \
 && test -d /components/qlever/cmake \
 && test -d /components/qlever/qlever_adapter \
 && test -d /components/qlever/rdf_protocol \
 && test -d /components/qlever/backend_contract \
 && test -d /components/qlever/candidate_contract \
 && test -f /components/qlever/scripts/check-qlever-real-runtime.cjs \
 && test ! -e /components/qlever/qlever_pg_extension \
 && test ! -e /components/pg-rdf-extension

LABEL org.opencontainers.image.title="Xpod QLever runtime SDK" \
      org.opencontainers.image.description="Locked QLever runtime libraries and public Xpod physical-backend headers"
