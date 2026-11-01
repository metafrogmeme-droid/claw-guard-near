#!/usr/bin/env bash
# Builds the Claw Guard NEAR contracts to wasm and prints where they are.
# Prototype. Testnet/sandbox only. Not audited.
#
# Usage:
#   scripts/build_contracts.sh                # both contracts
#   scripts/build_contracts.sh claw-guard     # one contract (claw-guard | mock-mpc)
#
# stdout gets exactly one line per contract, `<crate>=<absolute wasm path>`:
#   claw-guard=/…/target/near/claw_guard/claw_guard.wasm
#   mock-mpc=/…/target/near/mock_mpc/mock_mpc.wasm
# Build logs go to stderr. The near-workspaces tests (tests/common/mod.rs) and the TypeScript
# demo load the wasm from these paths.
#
# Default builder: `cargo near build non-reproducible-wasm` (cargo-near 0.22.0). It embeds the
# ABI and runs `wasm-opt -O`, which makes the wasm about 20% smaller. On protocol 88 that pass was
# not needed: the local sandbox (neard 2.14.0) and NEAR testnet (31 Oct 2026 rerun) both deployed
# and ran the unoptimised plain-cargo wasm (see the fallback below). Older nearcore VMs may reject
# wasm from rustc >= 1.82 without it; later protocol versions were not checked.
#
# Re-runs are fast (well under a second when nothing changed), so callers may run this before
# every test session: a contract is rebuilt only if its wasm is missing, was made by the other
# builder, or is older than a file under contracts/<crate>/, Cargo.toml, Cargo.lock or
# rust-toolchain.toml. (cargo-near on its own would recompile near-sdk on every alternating
# build, because the two contracts embed ABIs from different paths.) CLAWGUARD_FORCE_BUILD=1
# always builds.
#
# Fallback (CLAWGUARD_BUILDER=cargo, or cargo-near not installed): plain `cargo build` for
# wasm32-unknown-unknown with the flags cargo-near uses (`-C link-arg=-s --cfg near`), then
# `wasm-opt -O` if binaryen's wasm-opt is on PATH. The result is copied to the same path. It has
# no embedded ABI. Without wasm-opt it is about 20% bigger; the sandbox node (neard 2.14.0,
# protocol 88) runs it (checked 30 Oct 2026), and NEAR testnet (protocol 88) deployed it and ran
# the whole testnet demo in the 31 Oct 2026 rerun (docs/VERIFY.md section (i)). Older nearcore VMs
# may reject it. This is what was observed, not a promise for later protocol versions.
#
# Environment: CARGO_TARGET_DIR is honoured (default: <repo>/target). CLAWGUARD_LOCKED=1 passes
# `--locked` to cargo (CI).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALL_CRATES=(claw-guard mock-mpc)

die() {
  echo "build_contracts: $*" >&2
  exit 1
}

target_dir() {
  local dir="${CARGO_TARGET_DIR:-$ROOT/target}"
  case "$dir" in
    /*) printf '%s\n' "$dir" ;;
    *) printf '%s\n' "$ROOT/$dir" ;;
  esac
}

# Crate name -> library name (cargo replaces '-' with '_').
lib_name() {
  printf '%s\n' "${1//-/_}"
}

wasm_path() {
  local lib
  lib="$(lib_name "$1")"
  printf '%s\n' "$(target_dir)/near/$lib/$lib.wasm"
}

# Stamp next to the wasm: holds the builder name; its mtime is when that build started.
builder_stamp() {
  printf '%s.builder\n' "$(wasm_path "$1")"
}

# True if the wasm exists, came from the same builder, and no input changed since the start of
# the build that made it.
is_fresh() {
  local crate="$1" builder="$2" stamp newer
  stamp="$(builder_stamp "$crate")"
  [[ "${CLAWGUARD_FORCE_BUILD:-0}" != "1" ]] || return 1
  [[ -s "$(wasm_path "$crate")" ]] || return 1
  [[ "$(cat "$stamp" 2>/dev/null)" == "$builder" ]] || return 1
  newer="$(find "contracts/$crate" Cargo.toml Cargo.lock rust-toolchain.toml \
    -type f -newer "$stamp" -print -quit)"
  [[ -z "$newer" ]]
}

# Builds one contract and writes its stamp with the build's start time, so a file edited while
# the build ran still counts as newer next time.
build_one() {
  local crate="$1" builder="$2" stamp
  stamp="$(builder_stamp "$crate")"
  mkdir -p "$(dirname "$stamp")"
  rm -f "$stamp"
  touch "$stamp.start"
  "build_with_${builder//-/_}" "$crate"
  printf '%s\n' "$builder" >"$stamp"
  touch -r "$stamp.start" "$stamp"
  rm -f "$stamp.start"
}

locked_flag=()
if [[ "${CLAWGUARD_LOCKED:-0}" == "1" ]]; then
  locked_flag=(--locked)
fi

build_with_cargo_near() {
  local crate="$1"
  cargo near build non-reproducible-wasm \
    --manifest-path "contracts/$crate/Cargo.toml" "${locked_flag[@]}" >&2
}

build_with_cargo() {
  local crate="$1" lib out_dir raw
  lib="$(lib_name "$crate")"
  out_dir="$(target_dir)/near/$lib"
  raw="$(target_dir)/wasm32-unknown-unknown/release/$lib.wasm"
  # 0x1f-separated, exactly what cargo-near passes by default.
  CARGO_ENCODED_RUSTFLAGS=$'-C\x1flink-arg=-s\x1f--cfg\x1fnear' \
    cargo build -p "$crate" --target wasm32-unknown-unknown --release "${locked_flag[@]}" >&2
  mkdir -p "$out_dir"
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -O --enable-bulk-memory --enable-nontrapping-float-to-int \
      "$raw" -o "$out_dir/$lib.wasm" >&2
  else
    echo "build_contracts: wasm-opt not found; copying $lib.wasm without the wasm-opt pass" >&2
    cp "$raw" "$out_dir/$lib.wasm"
  fi
}

main() {
  local crates=("$@") builder crate wasm
  if [[ ${#crates[@]} -eq 0 ]]; then
    crates=("${ALL_CRATES[@]}")
  fi
  for crate in "${crates[@]}"; do
    case "$crate" in
      claw-guard | mock-mpc) ;;
      *) die "unknown contract '$crate' (expected: ${ALL_CRATES[*]})" ;;
    esac
  done

  builder="${CLAWGUARD_BUILDER:-cargo-near}"
  if [[ "$builder" == "cargo-near" ]] && ! cargo near --version >/dev/null 2>&1; then
    echo "build_contracts: cargo-near not found; using the plain cargo fallback" >&2
    echo "build_contracts: (install it: cargo install cargo-near --version 0.22.0 --locked)" >&2
    builder=cargo
  fi
  case "$builder" in
    cargo-near | cargo) ;;
    *) die "CLAWGUARD_BUILDER must be cargo-near or cargo, not '$builder'" ;;
  esac

  for crate in "${crates[@]}"; do
    if is_fresh "$crate" "$builder"; then
      echo "build_contracts: $crate is up to date" >&2
      continue
    fi
    echo "build_contracts: building $crate with $builder" >&2
    build_one "$crate" "$builder"
  done

  for crate in "${crates[@]}"; do
    wasm="$(wasm_path "$crate")"
    [[ -s "$wasm" ]] || die "expected $wasm after building $crate"
    printf '%s=%s\n' "$crate" "$wasm"
  done
}

main "$@"
