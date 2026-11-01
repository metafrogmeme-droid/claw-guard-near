# Claw Guard: Signing Gate for AI Agents. Prototype. Testnet only. Not audited.
# The server never holds mainnet keys or signs for users.
#
# An image that runs the sandbox demo from a clean checkout, with no .env, no keys and no network
# accounts (the demo runs on a local NEAR sandbox node):
#
#   docker build -t claw-guard .
#   docker run --rm --init --ulimit nofile=65535:65535 claw-guard            # runs `make demo`
#   docker run --rm --init --ulimit nofile=65535:65535 claw-guard make test  # all tests
#
# The sandbox node (neard 2.14.0) needs an open-files hard limit of 65535, hence the --ulimit.
# With a lower limit, `make demo` uses the scripts/fdlimit fallback (owner decision D-13; it needs
# the C compiler installed below) and prints one line saying so.
#
# What is pinned:
#   - Ubuntu 24.04 base image by dated tag and index digest (Docker Hub, pushed 4 Oct 2026).
#   - Node.js 22.22.2 from nodejs.org, SHA-256 checked (values from SHASUMS256.txt, whose
#     signature by a Node.js release key was verified on 31 Oct 2026).
#   - rustup-init 1.29.1 from static.rust-lang.org, SHA-256 checked; Rust 1.97 (owner decision
#     D-02) with the components and target from rust-toolchain.toml.
#   - cargo-near 0.22.0, built with --locked.
#   - The project's own dependencies come from Cargo.lock and offchain/package-lock.json
#     (`make deps` builds with --locked and runs `npm ci`).
# The demo itself downloads the sandbox node (near-sandbox 2.14.0) on first start, as it does
# outside Docker.

FROM ubuntu:noble-20260917@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

LABEL org.opencontainers.image.title="Claw Guard: Signing Gate for AI Agents (sandbox demo)" \
      org.opencontainers.image.description="Prototype. Testnet only. Not audited. Runs make demo on a local NEAR sandbox." \
      org.opencontainers.image.licenses="MIT"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# build-essential: cc/c++ and make (contracts, cargo-near's native parts, the D-13 shim);
# pkg-config + libudev-dev: cargo-near (Ledger support); perl: cargo-near's vendored OpenSSL build;
# libssl-dev (+ pkg-config): openssl-sys for the sandbox test crate (near-workspaces -> reqwest ->
# native-tls), which `make test` and `make lint` build;
# curl + ca-certificates: the downloads below and the sandbox node; xz-utils: the Node tarball.
# Package versions are not pinned: the Ubuntu archive drops superseded versions, so exact pins
# break the build; the base image digest fixes everything else.
# hadolint ignore=DL3008
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        libssl-dev \
        libudev-dev \
        perl \
        pkg-config \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js (owner decision D-06). Change NODE_VERSION together with both checksums.
ARG NODE_VERSION=22.22.2
ARG NODE_SHA256_X64=88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a
ARG NODE_SHA256_ARM64=e9e1930fd321a470e29bb68f30318bf58e3ecb4acb4f1533fb19c58328a091fe
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) node_arch=x64; node_sha256="$NODE_SHA256_X64" ;; \
        arm64) node_arch=arm64; node_sha256="$NODE_SHA256_ARM64" ;; \
        *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; \
    curl -fsSL --retry 3 -o "$tmp/node.tar.xz" \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    echo "${node_sha256}  $tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1 --no-same-owner; \
    rm -rf "$tmp"; \
    /opt/node/bin/node --version

# Everything from here on runs as an unprivileged user (claw, uid/gid 10001).
RUN groupadd --gid 10001 claw \
    && useradd --create-home --uid 10001 --gid 10001 --shell /bin/bash claw
USER 10001:10001
ENV HOME=/home/claw \
    RUSTUP_HOME=/home/claw/.rustup \
    CARGO_HOME=/home/claw/.cargo \
    PATH=/home/claw/.cargo/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /home/claw

# Rust via rustup (owner decision D-02). RUST_TOOLCHAIN must stay the channel in
# rust-toolchain.toml ("1.97"), so the checkout uses this toolchain instead of installing another.
# Change RUSTUP_VERSION together with both checksums.
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_SHA256_X86_64=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ARG RUSTUP_SHA256_AARCH64=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433
ARG RUST_TOOLCHAIN=1.97
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
        amd64) rust_arch=x86_64; rustup_sha256="$RUSTUP_SHA256_X86_64" ;; \
        arm64) rust_arch=aarch64; rustup_sha256="$RUSTUP_SHA256_AARCH64" ;; \
        *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; \
    curl -fsSL --retry 3 -o "$tmp/rustup-init" \
        "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rust_arch}-unknown-linux-gnu/rustup-init"; \
    echo "${rustup_sha256}  $tmp/rustup-init" | sha256sum -c -; \
    chmod +x "$tmp/rustup-init"; \
    "$tmp/rustup-init" -y --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN" \
        --component rustfmt,clippy --target wasm32-unknown-unknown; \
    rm -rf "$tmp"; \
    rustc --version; \
    cargo --version

# cargo-near builds the contract wasm (scripts/build_contracts.sh). Its crate downloads are
# removed afterwards; the binary stays.
ARG CARGO_NEAR_VERSION=0.22.0
RUN cargo install cargo-near --version "$CARGO_NEAR_VERSION" --locked \
    && rm -rf "$CARGO_HOME/registry" "$CARGO_HOME/git" \
    && cargo near --version

# The checkout (.dockerignore leaves out .git, target/, node_modules/, .env files, local sandbox
# state and docs/SUBMISSION_DRAFT.json), then both contracts and the npm packages, so that
# `docker run` only runs the demo.
RUN mkdir -p /home/claw/claw-guard
WORKDIR /home/claw/claw-guard
COPY --chown=10001:10001 . .
RUN CLAWGUARD_LOCKED=1 make deps

CMD ["make", "demo"]
