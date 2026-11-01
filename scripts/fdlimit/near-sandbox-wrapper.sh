#!/usr/bin/env bash
# Sandbox only. Prototype. Not audited.
#
# Runs the REAL local NEAR sandbox binary (near-sandbox / neard) with fdshim.so preloaded, so the
# node starts on hosts whose hard open-files limit is below the 65535 it asks for (owner decision
# D-13; the why is in scripts/fdlimit/fdshim.c).
#
# Used only as NEAR_SANDBOX_BIN_PATH, set by scripts/sandbox_env.sh for `make demo` / `make test`
# when the fallback is needed. Both sandbox launchers honour that variable: the npm package
# near-sandbox 0.3.4 (offchain demo) and the Rust crate near-sandbox 0.4.0 (near-workspaces 0.24.0
# tests). They call it with the node's own arguments (`--version`, `--home <dir> init --fast`,
# `--home <dir> run ...`); this script passes them through and `exec`s, so the launcher's pid,
# signals and pipes reach the node directly.
#
# LD_PRELOAD is set for that one exec only, never in the caller's environment, so the shim reaches
# the sandbox node and nothing else. Never used for NEAR testnet.
#
# Required environment (absolute paths; scripts/sandbox_env.sh sets both):
#   CLAWGUARD_SANDBOX_REAL_BIN  the real near-sandbox binary
#   CLAWGUARD_FDSHIM            the compiled shim (target/fdlimit/fdshim.so)
# Exit 2 with a message on stderr if either is missing or wrong; nothing is started then.
set -euo pipefail

die() {
  printf 'near-sandbox-wrapper: %s\n' "$*" >&2
  exit 2
}

real="${CLAWGUARD_SANDBOX_REAL_BIN:-}"
shim="${CLAWGUARD_FDSHIM:-}"

[[ -n "$real" ]] || die "CLAWGUARD_SANDBOX_REAL_BIN is not set: give the path of the real near-sandbox binary (make demo / make test do this for you)"
[[ "$real" == /* ]] || die "CLAWGUARD_SANDBOX_REAL_BIN must be an absolute path (got: $real)"
[[ -f "$real" && -x "$real" ]] || die "CLAWGUARD_SANDBOX_REAL_BIN is not an executable file: $real"
# Pointing it at this wrapper would exec the wrapper forever.
[[ ! "$real" -ef "${BASH_SOURCE[0]}" ]] || die "CLAWGUARD_SANDBOX_REAL_BIN points to this wrapper, not to the real near-sandbox binary"

[[ -n "$shim" ]] || die "CLAWGUARD_FDSHIM is not set: give the path of fdshim.so (make demo / make test do this for you)"
[[ "$shim" == /* ]] || die "CLAWGUARD_FDSHIM must be an absolute path (got: $shim)"
[[ -f "$shim" ]] || die "CLAWGUARD_FDSHIM is not a file: $shim"
# LD_PRELOAD separates entries with spaces and colons.
[[ "$shim" != *[[:space:]:]* ]] || die "CLAWGUARD_FDSHIM must not contain spaces or colons (LD_PRELOAD cannot load it): $shim"

# The shim goes first; anything already preloaded stays after it. This process becomes the node
# right away, so the export reaches the node only.
export LD_PRELOAD="$shim${LD_PRELOAD:+:$LD_PRELOAD}"
exec "$real" "$@"
