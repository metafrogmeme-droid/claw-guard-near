#!/usr/bin/env bash
# Tests for the low open-files-limit fallback of the local NEAR sandbox (owner decision
# D-13): scripts/sandbox_env.sh, scripts/fdlimit/near-sandbox-wrapper.sh, scripts/fdlimit/fdshim.c.
# Sandbox tooling only. Not audited.
#
# Usage: bash tests/fdlimit/test.sh        (`make test` runs it)
# No network and no download: the fallback cases use a stand-in "sandbox binary" script, except
# the last case, which runs the real near-sandbox 2.14.0 through the wrapper when it is already at
# target/fdlimit/near-sandbox-2.14.0/near-sandbox. Build outputs go to target/fdlimit/ (git-ignored).
# Exit 0 if every case passes (some are skipped off Linux or without a C compiler), 1 otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_SH="$ROOT/scripts/sandbox_env.sh"
WRAPPER="$ROOT/scripts/fdlimit/near-sandbox-wrapper.sh"
SHIM="$ROOT/target/fdlimit/fdshim.so"
TEST_OUT="$ROOT/target/fdlimit/test"
LINE_RE='^make: open-files hard limit is [0-9]+ \(< 65535\): running the sandbox through scripts/fdlimit \(sandbox only\)$'

mkdir -p "$TEST_OUT"
WORK="$(mktemp -d "$TEST_OUT/run.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
skip=0
ok() { pass=$((pass + 1)); printf 'ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; [[ $# -lt 2 ]] || printf '      %s\n' "${@:2}"; }
skipped() { skip=$((skip + 1)); printf 'skip  %s (%s)\n' "$1" "$2"; }

is_linux=0
[[ "$(uname -s)" == Linux ]] && is_linux=1
have_cc=0
command -v "${CC:-cc}" >/dev/null 2>&1 && have_cc=1

# Runs scripts/sandbox_env.sh with a clean environment for the variables under test, plus "$@"
# (VAR=value ... -- command ...). Captures stdout, stderr and the exit status.
run_env() {
  local -a vars=()
  while [[ $# -gt 0 && "$1" != -- ]]; do vars+=("$1"); shift; done
  shift
  set +e
  env -u NEAR_SANDBOX_BIN_PATH -u CLAWGUARD_SANDBOX_REAL_BIN -u CLAWGUARD_FDSHIM -u LD_PRELOAD \
    -u CLAWGUARD_FD_HARD_LIMIT ${vars[@]+"${vars[@]}"} bash "$ENV_SH" "$@" >"$WORK/out" 2>"$WORK/err"
  status=$?
  set -e
  out="$(cat "$WORK/out")"
  err="$(cat "$WORK/err")"
}

# The variables a command run through sandbox_env.sh sees (one per line, "unset" if not set).
# shellcheck disable=SC2016 # expanded by the inner bash, on purpose
SHOW='for v in NEAR_SANDBOX_BIN_PATH CLAWGUARD_SANDBOX_REAL_BIN CLAWGUARD_FDSHIM LD_PRELOAD; do printf "%s=%s\n" "$v" "${!v-unset}"; done'
NOTHING_SET=$'NEAR_SANDBOX_BIN_PATH=unset\nCLAWGUARD_SANDBOX_REAL_BIN=unset\nCLAWGUARD_FDSHIM=unset\nLD_PRELOAD=unset'

# A stand-in for the real binary: reports what it was started with.
FAKE="$WORK/fake-near-sandbox"
cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
printf 'fake-near-sandbox args=%s LD_PRELOAD=%s\n' "$*" "${LD_PRELOAD-unset}"
EOF
chmod 755 "$FAKE"

# ---- high limit: nothing happens ----

for limit in 65535 1048576 unlimited; do
  name="hard limit $limit: prints nothing, sets nothing"
  run_env CLAWGUARD_FD_HARD_LIMIT="$limit" -- bash -c "$SHOW"
  if [[ $status -eq 0 && -z "$err" && "$out" == "$NOTHING_SET" ]]; then ok "$name"; else bad "$name" "status=$status" "stderr=$err" "$out"; fi
done

name="user's NEAR_SANDBOX_BIN_PATH wins (low limit): not wrapped, nothing printed"
run_env CLAWGUARD_FD_HARD_LIMIT=1024 NEAR_SANDBOX_BIN_PATH=/opt/my-near-sandbox -- bash -c "$SHOW"
expect=$'NEAR_SANDBOX_BIN_PATH=/opt/my-near-sandbox\nCLAWGUARD_SANDBOX_REAL_BIN=unset\nCLAWGUARD_FDSHIM=unset\nLD_PRELOAD=unset'
if [[ $status -eq 0 && -z "$err" && "$out" == "$expect" ]]; then ok "$name"; else bad "$name" "status=$status" "stderr=$err" "$out"; fi

name="no command: usage error (exit 2)"
run_env --
if [[ $status -eq 2 && "$err" == usage:* ]]; then ok "$name"; else bad "$name" "status=$status" "stderr=$err"; fi

# ---- low limit: the fallback ----

if [[ $is_linux -eq 1 && $have_cc -eq 1 ]]; then
  name="hard limit 20000: one line, NEAR_SANDBOX_BIN_PATH = wrapper, no LD_PRELOAD for the command"
  run_env CLAWGUARD_FD_HARD_LIMIT=20000 CLAWGUARD_SANDBOX_REAL_BIN="$FAKE" -- bash -c "$SHOW"
  expect="NEAR_SANDBOX_BIN_PATH=$WRAPPER"$'\n'"CLAWGUARD_SANDBOX_REAL_BIN=$FAKE"$'\n'"CLAWGUARD_FDSHIM=$SHIM"$'\nLD_PRELOAD=unset'
  if [[ $status -eq 0 && "$err" =~ $LINE_RE && "$err" == *"is 20000 (<"* && "$out" == "$expect" && -f "$SHIM" ]]; then
    ok "$name"
  else
    bad "$name" "status=$status" "stderr=$err" "$out"
  fi

  name="through the wrapper the node gets its arguments and LD_PRELOAD = shim first, then the existing value"
  # shellcheck disable=SC2016 # expanded by the inner bash, on purpose
  run_env CLAWGUARD_FD_HARD_LIMIT=20000 CLAWGUARD_SANDBOX_REAL_BIN="$FAKE" -- \
    bash -c 'LD_PRELOAD=/nonexistent/other.so "$NEAR_SANDBOX_BIN_PATH" --home /tmp/x init --fast 2>/dev/null'
  if [[ $status -eq 0 && "$out" == "fake-near-sandbox args=--home /tmp/x init --fast LD_PRELOAD=$SHIM:/nonexistent/other.so" ]]; then
    ok "$name"
  else
    bad "$name" "status=$status" "$out"
  fi

  name="the command's exit status is passed through"
  run_env CLAWGUARD_FD_HARD_LIMIT=20000 CLAWGUARD_SANDBOX_REAL_BIN="$FAKE" -- bash -c 'exit 7'
  if [[ $status -eq 7 ]]; then ok "$name"; else bad "$name" "status=$status"; fi

  name="no C compiler: error with the fix, exit 1, command not run"
  run_env CLAWGUARD_FD_HARD_LIMIT=20000 CLAWGUARD_SANDBOX_REAL_BIN="$FAKE" CC=/nonexistent/cc -- bash -c 'echo RAN'
  if [[ $status -eq 1 && -z "$out" && "$err" == *"no C compiler found"* && "$err" == *"ulimit -Hn 65535"* \
    && "$err" == *"docker run --ulimit nofile=65535:65535"* ]]; then
    ok "$name"
  else
    bad "$name" "status=$status" "stdout=$out" "stderr=$err"
  fi

  name="CLAWGUARD_SANDBOX_REAL_BIN must be an absolute executable path"
  run_env CLAWGUARD_FD_HARD_LIMIT=20000 CLAWGUARD_SANDBOX_REAL_BIN=relative/near-sandbox -- bash -c 'echo RAN'
  if [[ $status -eq 1 && -z "$out" && "$err" == *"CLAWGUARD_SANDBOX_REAL_BIN must be"* ]]; then ok "$name"; else bad "$name" "status=$status" "stderr=$err"; fi
elif [[ $is_linux -eq 0 ]]; then
  name="hard limit 20000 off Linux: error with the fix, exit 1"
  run_env CLAWGUARD_FD_HARD_LIMIT=20000 -- bash -c 'echo RAN'
  if [[ $status -eq 1 && -z "$out" && "$err" == *"Linux only"* && "$err" == *"ulimit -Hn 65535"* ]]; then ok "$name"; else bad "$name" "status=$status" "stderr=$err"; fi
else
  skipped "fallback cases" "no C compiler (${CC:-cc})"
fi

# ---- the wrapper refuses to run without a real binary path ----

wrap() { # runs the wrapper with only the given variables set; captures status and stderr
  set +e
  env -u CLAWGUARD_SANDBOX_REAL_BIN -u CLAWGUARD_FDSHIM -u LD_PRELOAD "$@" "$WRAPPER" --version >"$WORK/out" 2>"$WORK/err"
  status=$?
  set -e
  out="$(cat "$WORK/out")"
  err="$(cat "$WORK/err")"
}
touch "$WORK/not-executable" "$WORK/a:b.so"
for c in \
  "unset real binary|CLAWGUARD_SANDBOX_REAL_BIN is not set|" \
  "relative real binary|must be an absolute path|CLAWGUARD_SANDBOX_REAL_BIN=near-sandbox" \
  "missing real binary|is not an executable file|CLAWGUARD_SANDBOX_REAL_BIN=$WORK/missing" \
  "non-executable real binary|is not an executable file|CLAWGUARD_SANDBOX_REAL_BIN=$WORK/not-executable" \
  "real binary = the wrapper itself|points to this wrapper|CLAWGUARD_SANDBOX_REAL_BIN=$WRAPPER" \
  "unset shim|CLAWGUARD_FDSHIM is not set|CLAWGUARD_SANDBOX_REAL_BIN=$FAKE" \
  "missing shim|CLAWGUARD_FDSHIM is not a file|CLAWGUARD_SANDBOX_REAL_BIN=$FAKE CLAWGUARD_FDSHIM=$WORK/missing.so" \
  "shim path with a colon|must not contain spaces or colons|CLAWGUARD_SANDBOX_REAL_BIN=$FAKE CLAWGUARD_FDSHIM=$WORK/a:b.so"; do
  IFS='|' read -r label message vars <<<"$c"
  name="wrapper refuses: $label (exit 2, nothing started)"
  # shellcheck disable=SC2086 # word splitting of "VAR=value VAR=value" is intended
  wrap $vars
  if [[ $status -eq 2 && -z "$out" && "$err" == *"$message"* ]]; then ok "$name"; else bad "$name" "status=$status" "stdout=$out" "stderr=$err"; fi
done

# ---- the shim itself ----

if [[ $is_linux -eq 1 && $have_cc -eq 1 ]]; then
  read -r -a cc_cmd <<<"${CC:-cc}"
  "${cc_cmd[@]}" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$TEST_OUT/fdshim.so" "$ROOT/scripts/fdlimit/fdshim.c" -ldl
  "${cc_cmd[@]}" -O2 -Wall -Wextra -Werror -o "$TEST_OUT/fdshim_test" "$ROOT/tests/fdlimit/fdshim_test.c" -ldl
  ok "fdshim.c and fdshim_test.c compile with -Wall -Wextra -Werror"
  for mode in plain shim; do
    name="fdshim_test $mode"
    set +e
    if [[ $mode == shim ]]; then
      LD_PRELOAD="$TEST_OUT/fdshim.so" "$TEST_OUT/fdshim_test" shim 2>"$WORK/err"
    else
      env -u LD_PRELOAD "$TEST_OUT/fdshim_test" plain 2>"$WORK/err"
    fi
    status=$?
    set -e
    if [[ $status -eq 0 ]]; then
      ok "$name"
    elif [[ $status -eq 77 ]]; then
      skipped "$name" "this process may raise its open-files hard limit, nothing to clamp"
    else
      bad "$name" "status=$status" "$(cat "$WORK/err")"
    fi
  done
else
  skipped "fdshim_test" "needs Linux and a C compiler"
fi

# ---- the real node through the wrapper (only if the pinned binary is already there) ----

REAL="$ROOT/target/fdlimit/near-sandbox-2.14.0/near-sandbox"
if [[ $is_linux -eq 1 && -x "$REAL" && -f "$TEST_OUT/fdshim.so" ]]; then
  name="real near-sandbox 2.14.0 runs through the wrapper"
  set +e
  out="$(CLAWGUARD_SANDBOX_REAL_BIN="$REAL" CLAWGUARD_FDSHIM="$TEST_OUT/fdshim.so" "$WRAPPER" --version 2>&1)"
  status=$?
  set -e
  if [[ $status -eq 0 && "$out" == "neard (release 2.14.0)"* ]]; then ok "$name"; else bad "$name" "status=$status" "$out"; fi
  if [[ "$(ulimit -Hn)" != unlimited && "$(ulimit -Hn)" -lt 65535 ]]; then
    name="without the wrapper the same binary exits on this host (hard limit $(ulimit -Hn))"
    set +e
    out="$(env -u LD_PRELOAD "$REAL" --version 2>&1)"
    status=$?
    set -e
    if [[ $status -ne 0 && "$out" == *"couldn't set the file descriptor limit to (65535, 65535)"* ]]; then ok "$name"; else bad "$name" "status=$status" "$out"; fi
  fi
else
  skipped "real near-sandbox through the wrapper" "target/fdlimit/near-sandbox-2.14.0/near-sandbox not present (make demo / make test place it on low-limit Linux hosts)"
fi

# ---- one sandbox version everywhere ----

name="the demo (setup.ts), the fallback (sandbox_env.sh) and the Rust tests (tests/common/mod.rs) use one version"
env_version="$(sed -n 's/^SANDBOX_VERSION=\([0-9.]*\)$/\1/p' "$ENV_SH")"
ts_version="$(sed -n 's/^export const SANDBOX_NODE_VERSION = "\([0-9.]*\)";$/\1/p' "$ROOT/offchain/src/cli/setup.ts")"
# near-workspaces 0.23.0 (D-21) defaults to neard 2.13.4; the tests pin the node with
# `sandbox_with_version(SANDBOX_NODE_VERSION)`.
rust_version="$(sed -n 's/^pub const SANDBOX_NODE_VERSION: &str = "\([0-9.]*\)";$/\1/p' "$ROOT/tests/common/mod.rs")"
if [[ -n "$env_version" && "$env_version" == "$ts_version" && "$rust_version" == "$env_version" ]] &&
  grep -q 'near_workspaces::sandbox_with_version(SANDBOX_NODE_VERSION)' "$ROOT/tests/common/mod.rs"; then
  ok "$name ($env_version)"
else
  bad "$name" "sandbox_env.sh=$env_version setup.ts=$ts_version tests/common/mod.rs=$rust_version"
fi

printf '\nfdlimit tests: %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[[ $fail -eq 0 ]]
