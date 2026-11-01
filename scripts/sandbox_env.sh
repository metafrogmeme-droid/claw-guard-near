#!/usr/bin/env bash
# Sandbox only. Prototype. Not audited.
#
# Usage: scripts/sandbox_env.sh <command> [args...]
#
# Runs <command> (something that starts a local NEAR sandbox node) with the environment this host
# needs for it. `make demo` and `make test` run their sandbox commands through this script
# (owner decision D-13, docs/DECISIONS.md).
#
# The sandbox node (near-sandbox / neard 2.14.0) sets its open-files limit to 65535 and exits if
# the host's hard limit is lower and it may not raise it. So:
#   - Hard limit (`ulimit -Hn`) 65535 or more, or "unlimited": nothing is set and nothing is
#     printed; <command> runs as is.
#   - NEAR_SANDBOX_BIN_PATH already set by you: it is respected; nothing is wrapped or printed.
#   - Lower limit on Linux (glibc, x86_64 or aarch64) with a C compiler: the fallback.
#       1. builds target/fdlimit/fdshim.so from scripts/fdlimit/fdshim.c (only when the .so is
#          missing or older than its source or this script),
#       2. makes sure the real sandbox binary near-sandbox 2.14.0 is at
#          target/fdlimit/near-sandbox-2.14.0/near-sandbox: taken from the near-sandbox crate's
#          download cache under target/*/build/ or the npm package's cache when present, else
#          downloaded from the URL both launchers use
#          (https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/<platform>/2.14.0/near-sandbox.tar.gz);
#          its sha256 must match the pinned value below,
#       3. prints exactly one line on stderr:
#            make: open-files hard limit is 20000 (< 65535): running the sandbox through scripts/fdlimit (sandbox only)
#       4. runs <command> with
#            NEAR_SANDBOX_BIN_PATH=<repo>/scripts/fdlimit/near-sandbox-wrapper.sh
#            CLAWGUARD_SANDBOX_REAL_BIN=<the real binary>   CLAWGUARD_FDSHIM=<repo>/target/fdlimit/fdshim.so
#          Both launchers (npm near-sandbox 0.3.4 for the demo, Rust near-sandbox 0.3.16 under
#          near-workspaces 0.23.0 for the tests) then start the node through the wrapper, which
#          preloads the shim into the node only. LD_PRELOAD is never set for <command> itself.
#   - Lower limit and the fallback cannot be used (not Linux/glibc, other CPU, no C compiler,
#     build or download failed): an error with the fix (raise the limit) on stderr, exit 1.
#
# Environment:
#   NEAR_SANDBOX_BIN_PATH       your own sandbox binary; wins over everything here.
#   CLAWGUARD_SANDBOX_REAL_BIN  optional: a real near-sandbox binary to wrap instead of the pinned
#                               2.14.0 (absolute path; not checksum-checked: your choice).
#   CC                          C compiler for the shim (default: cc).
#   CLAWGUARD_FD_HARD_LIMIT     tests only: use this instead of `ulimit -Hn` (a number or "unlimited").
# SANDBOX_ARTIFACT_URL (honoured by both launchers) is not used for the fallback download: the
# fallback always fetches the pinned, checksum-checked 2.14.0. Use CLAWGUARD_SANDBOX_REAL_BIN for
# a custom build.
#
# Exit: <command>'s own status (it is exec'd); 1 if the fallback is needed but cannot be used;
# 2 on usage errors.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$ROOT/scripts/sandbox_env.sh"

# The node's request (neard 2.14.0, checked 31 Oct 2026).
NEEDED_NOFILE=65535

# One sandbox version for the demo and the tests: the Rust tests pin it in tests/common/mod.rs
# (SANDBOX_NODE_VERSION, D-21) and offchain/src/cli/setup.ts pins the npm demo to the same version.
SANDBOX_VERSION=2.14.0
# sha256 of the near-sandbox binary inside near-sandbox.tar.gz for 2.14.0 (S3 artifacts dated
# 26 Oct 2026, checked 31 Oct 2026).
SHA256_LINUX_X86_64=797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13
SHA256_LINUX_AARCH64=cdc95d49e46e1127274a02067bb39265b935b912f53b82caaabe601be9817bcc

OUT="$ROOT/target/fdlimit"
SHIM_SRC="$ROOT/scripts/fdlimit/fdshim.c"
SHIM="$OUT/fdshim.so"
WRAPPER="$ROOT/scripts/fdlimit/near-sandbox-wrapper.sh"

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/sandbox_env.sh <command> [args...]" >&2
  exit 2
fi

# ---- 1. is the fallback needed? ----

if [[ -n "${NEAR_SANDBOX_BIN_PATH:-}" ]]; then
  exec "$@" # yours, as is
fi

hard="${CLAWGUARD_FD_HARD_LIMIT:-$(ulimit -Hn)}"
if [[ "$hard" == unlimited ]]; then
  exec "$@"
fi
if [[ ! "$hard" =~ ^[0-9]+$ ]]; then
  echo "make: cannot read the open-files hard limit (got '$hard'); starting the sandbox without the fallback" >&2
  exec "$@"
fi
if ((10#$hard >= NEEDED_NOFILE)); then
  exec "$@"
fi

# ---- 2. fallback: shim + real binary + wrapper ----

cannot() { # the fallback cannot be used here: say why and how to fix it, exit 1
  {
    echo "make: open-files hard limit is $hard (< $NEEDED_NOFILE) and the sandbox node needs $NEEDED_NOFILE."
    echo "make: the automatic fallback (scripts/fdlimit) cannot be used here: $*"
    echo "make: fix: raise the limit to $NEEDED_NOFILE or more, then run make again, e.g."
    echo "make:   as root:     ulimit -Hn $NEEDED_NOFILE && ulimit -Sn $NEEDED_NOFILE"
    echo "make:   in Docker:   docker run --ulimit nofile=$NEEDED_NOFILE:$NEEDED_NOFILE ..."
  } >&2
  exit 1
}

[[ "$(uname -s)" == Linux ]] || cannot "it supports Linux only (this is $(uname -s))"
# (grep without -q reads all input, so `ldd` never gets SIGPIPE under pipefail)
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || ldd --version 2>&1 | grep -iE 'glibc|gnu libc' >/dev/null \
  || cannot "it needs glibc (the sandbox binary is built for glibc)"
case "$(uname -m)" in
  x86_64) platform=Linux-x86_64 sha256="$SHA256_LINUX_X86_64" ;;
  aarch64 | arm64) platform=Linux-aarch64 sha256="$SHA256_LINUX_AARCH64" ;;
  *) cannot "the sandbox binary exists for x86_64 and aarch64 only (this is $(uname -m))" ;;
esac
command -v sha256sum >/dev/null 2>&1 || cannot "sha256sum (coreutils) not found"
[[ -x "$WRAPPER" ]] || cannot "scripts/fdlimit/near-sandbox-wrapper.sh is not executable (chmod +x it)"
[[ "$ROOT" != *[[:space:]:]* ]] || cannot "the repository path contains a space or colon, which LD_PRELOAD cannot load from: $ROOT"

read -r -a cc_cmd <<<"${CC:-cc}"
if [[ ${#cc_cmd[@]} -eq 0 ]] || ! command -v "${cc_cmd[0]}" >/dev/null 2>&1; then
  cannot "no C compiler found (${CC:-cc}); install one (e.g. gcc) or set CC"
fi

mkdir -p "$OUT"

# 2a. the shim, only when missing or outdated.
if [[ ! -f "$SHIM" || "$SHIM" -ot "$SHIM_SRC" || "$SHIM" -ot "$SELF" ]]; then
  tmp_so="$OUT/.fdshim.so.$$"
  if ! "${cc_cmd[@]}" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$tmp_so" "$SHIM_SRC" -ldl; then
    rm -f "$tmp_so"
    cannot "compiling scripts/fdlimit/fdshim.c with ${cc_cmd[*]} failed (see above)"
  fi
  mv -f "$tmp_so" "$SHIM"
fi

# 2b. the real sandbox binary.
sha_ok() { [[ -f "$1" ]] && [[ "$(sha256sum "$1" | cut -d ' ' -f 1)" == "$sha256" ]]; }

provide_pinned_binary() { # sets REAL to the pinned near-sandbox 2.14.0, verified when placed
  local dest_dir="$OUT/near-sandbox-$SANDBOX_VERSION"
  local dest="$dest_dir/near-sandbox"
  REAL="$dest"
  [[ -x "$dest" ]] && return 0 # only ever placed here after its checksum matched
  mkdir -p "$dest_dir"
  PROVIDE_TMP="$(mktemp -d "$dest_dir/.provide.XXXXXX")"
  trap 'rm -rf "$PROVIDE_TMP"' EXIT # also on `cannot` (exit 1)
  local tmp="$PROVIDE_TMP"

  # Already downloaded by one of the launchers? (Rust: near-sandbox crate's OUT_DIR; npm: package bin/)
  local target_dir="${CARGO_TARGET_DIR:-$ROOT/target}"
  [[ "$target_dir" == /* ]] || target_dir="$ROOT/$target_dir"
  local candidate
  for candidate in \
    "$target_dir"/*/build/near-sandbox-*/out/.near/near-sandbox-"$SANDBOX_VERSION"/near-sandbox \
    "$ROOT/offchain/node_modules/near-sandbox/bin/near-sandbox-$SANDBOX_VERSION/near-sandbox"; do
    if sha_ok "$candidate"; then
      ln -f "$candidate" "$tmp/near-sandbox" 2>/dev/null || cp -f "$candidate" "$tmp/near-sandbox"
      break
    fi
  done

  if [[ ! -f "$tmp/near-sandbox" ]]; then
    command -v curl >/dev/null 2>&1 || cannot "curl not found (needed once to download near-sandbox $SANDBOX_VERSION); install curl or set CLAWGUARD_SANDBOX_REAL_BIN"
    command -v tar >/dev/null 2>&1 || cannot "tar not found (needed once to unpack near-sandbox $SANDBOX_VERSION)"
    local url="https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$platform/$SANDBOX_VERSION/near-sandbox.tar.gz"
    curl -fsSL --retry 2 --connect-timeout 30 -o "$tmp/near-sandbox.tar.gz" "$url" \
      || cannot "downloading near-sandbox $SANDBOX_VERSION from $url failed"
    tar -xzf "$tmp/near-sandbox.tar.gz" -C "$tmp" --no-same-owner "$platform/near-sandbox" \
      || cannot "unpacking near-sandbox $SANDBOX_VERSION failed"
    mv -f "$tmp/$platform/near-sandbox" "$tmp/near-sandbox"
  fi

  sha_ok "$tmp/near-sandbox" || cannot "near-sandbox $SANDBOX_VERSION does not match its pinned sha256 ($sha256)"
  chmod 755 "$tmp/near-sandbox"
  mv -f "$tmp/near-sandbox" "$dest"
  rm -rf "$tmp"
  trap - EXIT
}

if [[ -n "${CLAWGUARD_SANDBOX_REAL_BIN:-}" ]]; then
  REAL="$CLAWGUARD_SANDBOX_REAL_BIN"
  [[ "$REAL" == /* && -f "$REAL" && -x "$REAL" ]] \
    || cannot "CLAWGUARD_SANDBOX_REAL_BIN must be the absolute path of an executable near-sandbox binary (got: $REAL)"
else
  provide_pinned_binary
fi

echo "make: open-files hard limit is $hard (< $NEEDED_NOFILE): running the sandbox through scripts/fdlimit (sandbox only)" >&2

export NEAR_SANDBOX_BIN_PATH="$WRAPPER"
export CLAWGUARD_SANDBOX_REAL_BIN="$REAL"
export CLAWGUARD_FDSHIM="$SHIM"
exec "$@"
