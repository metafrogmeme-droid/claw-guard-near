#!/usr/bin/env bash
# Claw Guard: deploy one guard on NEAR mainnet with a low-value demo account (docs/MAINNET.md).
# Prototype. Not audited. Signing targets stay Hyperliquid testnet and Base Sepolia.
#
# Without MAINNET_GO=yes this only builds the wasm, runs read-only checks and prints the plan:
# no transaction is sent. With MAINNET_GO=yes (only after the owner's go, only from the owner's own machine) it
#   1. deploys the `mainnet`-feature wasm and calls `new` in one transaction,
#   2. runs the demo checks: get_status, contract_source_metadata, and, if AGENT_ID is set,
#      register_agent with demo/rules.json (signed by OWNER_ID, 1 yoctoNEAR) plus two preview_payload views
#      (one order within the rules, one over the per-order size),
#   3. deletes every full-access key of CONTRACT_ID (Q-14), then checks none is left.
#
# Environment:
#   CONTRACT_ID   required. Mainnet: a named .near account, e.g. claw-guard.<name>.near.
#   OWNER_ID      required. Manages the rules; keeps its own key. Not the prize-payout account.
#   GUARDIAN_ID   optional. May pause.
#   AGENT_ID      optional. Registered with the demo rules (needs OWNER_ID's key).
#   MAINNET_GO    "yes" sends transactions. Anything else: plan only.
#   LOCK_KEYS     "yes" (default) deletes the contract's full-access keys at the end.
#   WASM          optional prebuilt wasm, e.g. the CI artifact claw-guard-wasm-<sha>/claw_guard.mainnet.wasm
#                 (docs/MAINNET.md). Default: built here with --features mainnet.
#   WASM_SHA256   optional: refuse unless the wasm's sha256 is exactly this (64 hex characters).
#   Every run also refuses a wasm that imports a host function outside
#   scripts/near-host-fns-protocol-86.txt (scripts/check_wasm_imports.py, D-21).
#   LOCK_ONLY     "yes": skip deploy and demo checks; only delete the full-access keys of an
#                 already deployed and initialised CONTRACT_ID (Q-14, e.g. the testnet guard).
#   CLAWGUARD_NETWORK   mainnet (default), testnet, or sandbox (local rehearsal only).
#   NEAR_RPC_URL  optional. Default https://rpc.mainnet.near.org / https://rpc.testnet.near.org
#                 (sandbox: required).
#   MPC_ID        sandbox only (the mock MPC account). Mainnet always uses v1.signer, testnet
#                 v1.signer-prod.testnet.
#   Keys: ~/.near-credentials/<network>/<account>.json, the file near-cli writes (directory
#   overridable with NEAR_CREDENTIALS_DIR), or CONTRACT_PRIVATE_KEY / OWNER_PRIVATE_KEY
#   (ed25519:…). Keys are copied into a private temporary directory that is deleted on exit and
#   are never printed.
#
# Needs: near (near-cli-rs 0.30), cargo (and cargo-near 0.22.0 for the default build), curl,
# jq, python3.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

readonly MAINNET_MPC_ID="v1.signer"
readonly TESTNET_MPC_ID="v1.signer-prod.testnet"
readonly BYTE_COST_YOCTO="10000000000000000000" # 10^19 yocto per byte (protocol config)
readonly RESERVE_BYTES=4096                     # rules.rs RECEIPT_STORAGE_RESERVE_BYTES
readonly RECEIPT_BYTES=702                      # worst-case blocked receipt (D-18)
readonly DEMO_RECEIPTS=200                      # receipts the funding should cover
readonly STATE_BYTES=8000                       # guard state, one agent, keys, margin
readonly INIT_GAS="100.0 Tgas"
readonly CALL_GAS="100.0 Tgas"

NETWORK="${CLAWGUARD_NETWORK:-mainnet}"
GO="${MAINNET_GO:-no}"
LOCK="${LOCK_KEYS:-yes}"
LOCK_ONLY="${LOCK_ONLY:-no}"
CREDS_SRC="${NEAR_CREDENTIALS_DIR:-$HOME/.near-credentials}"

say() { printf 'deploy-mainnet: %s\n' "$*" >&2; }
die() {
  say "Refused: $*"
  exit 1
}

# ---- inputs ----------------------------------------------------------------------------------

account_ok() {
  [[ "$1" =~ ^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$ ]] && ((${#1} >= 2 && ${#1} <= 64))
}

check_inputs() {
  [[ -n "${CONTRACT_ID:-}" ]] || die "set CONTRACT_ID (e.g. claw-guard.<name>.near)"
  [[ -n "${OWNER_ID:-}" ]] || die "set OWNER_ID"
  local a
  for a in "$CONTRACT_ID" "$OWNER_ID" ${GUARDIAN_ID:+"$GUARDIAN_ID"} ${AGENT_ID:+"$AGENT_ID"}; do
    account_ok "$a" || die "'$a' is not a valid NEAR account id"
  done
  [[ "$CONTRACT_ID" != "$OWNER_ID" ]] || die "CONTRACT_ID and OWNER_ID must differ (the contract key gets deleted)"
  case "$NETWORK" in
    mainnet)
      [[ "$CONTRACT_ID" == *.near && "$CONTRACT_ID" != *.test.near ]] ||
        die "on mainnet CONTRACT_ID must be a named .near account"
      [[ -z "${MPC_ID:-}" || "${MPC_ID}" == "$MAINNET_MPC_ID" ]] || die "mainnet MPC is always $MAINNET_MPC_ID"
      MPC="$MAINNET_MPC_ID"
      RPC="${NEAR_RPC_URL:-https://rpc.mainnet.near.org}"
      FEATURES=(--features mainnet)
      ;;
    testnet)
      [[ "$CONTRACT_ID" == *.testnet ]] || die "on testnet CONTRACT_ID must end in .testnet"
      [[ -z "${MPC_ID:-}" || "${MPC_ID}" == "$TESTNET_MPC_ID" ]] || die "testnet MPC is always $TESTNET_MPC_ID"
      MPC="$TESTNET_MPC_ID"
      RPC="${NEAR_RPC_URL:-https://rpc.testnet.near.org}"
      FEATURES=()
      ;;
    sandbox)
      [[ "$CONTRACT_ID" == *.test.near ]] || die "sandbox CONTRACT_ID must end in .test.near"
      [[ -n "${MPC_ID:-}" ]] || die "sandbox needs MPC_ID (the mock MPC account)"
      [[ -n "${NEAR_RPC_URL:-}" ]] || die "sandbox needs NEAR_RPC_URL"
      MPC="$MPC_ID"
      RPC="$NEAR_RPC_URL"
      FEATURES=()
      ;;
    *) die "CLAWGUARD_NETWORK must be mainnet, testnet or sandbox, not '$NETWORK'" ;;
  esac
  case "$LOCK" in yes | no) ;; *) die "LOCK_KEYS must be yes or no" ;; esac
  case "$LOCK_ONLY" in yes | no) ;; *) die "LOCK_ONLY must be yes or no" ;; esac
  [[ "$LOCK_ONLY" != yes || "$LOCK" == yes ]] || die "LOCK_ONLY=yes with LOCK_KEYS=no does nothing"
  for a in near curl jq python3; do
    command -v "$a" >/dev/null || die "'$a' not found on PATH"
  done
}

# ---- RPC (read-only) -------------------------------------------------------------------------

rpc() {
  local method="$1" params="$2" out
  out="$(curl -sS --fail -m 30 "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"cg\",\"method\":\"$method\",\"params\":$params}")" ||
    die "RPC $method failed at $RPC"
  printf '%s\n' "$out"
}

view_account() {
  rpc query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}"
}

# Prints the JSON a view method returns, or nothing if the call failed.
view_call() {
  local args_b64
  args_b64="$(printf '%s' "$3" | base64 -w0)"
  rpc query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args_b64\"}" |
    jq -r 'if .result.result then (.result.result | implode) else empty end'
}

full_access_keys() {
  rpc query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}" |
    jq -r '.result.keys[]? | select(.access_key.permission == "FullAccess") | .public_key'
}

yocto_to_near() {
  python3 -c 'import sys; from decimal import Decimal; print(f"{Decimal(sys.argv[1]) / Decimal(10)**24:.4f}")' "$1"
}

# ---- keys ------------------------------------------------------------------------------------

WORK=""
cleanup() {
  [[ -z "$WORK" ]] || rm -rf "$WORK"
}
trap cleanup EXIT

# near-cli-rs runs with HOME=$WORK: its config lists only this network and its legacy keychain
# holds only the keys this run needs.
make_cli_home() {
  WORK="$(mktemp -d)"
  chmod 700 "$WORK"
  mkdir -p "$WORK/.config/near-cli" "$WORK/.near-credentials/$NETWORK"
  local mpc_line=""
  [[ "$NETWORK" == mainnet ]] && mpc_line="mpc_contract_account_id = \"$MAINNET_MPC_ID\""
  cat >"$WORK/.config/near-cli/config.toml" <<TOML
version = "5"
credentials_home_dir = "$WORK/.near-credentials"

[network_connection.$NETWORK]
network_name = "$NETWORK"
rpc_url = "$RPC/"
wallet_url = "https://app.mynearwallet.com/"
explorer_transaction_url = "https://nearblocks.io/txns/"
linkdrop_account_id = "near"
$mpc_line
TOML
}

# Copies (or writes from an env key) the keychain file for $1. Returns 1 if there is no key.
stage_key() {
  local account="$1" env_name="$2" dst="$WORK/.near-credentials/$NETWORK/$1.json"
  local src="$CREDS_SRC/$NETWORK/$account.json"
  if [[ -n "${!env_name:-}" ]]; then
    KEY="${!env_name}" ACCOUNT="$account" python3 - >"$dst" <<'PY'
import json, os
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw
def b58e(b):
    n = int.from_bytes(b, "big"); out = ""
    while n:
        n, r = divmod(n, 58); out = B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out
key = os.environ["KEY"].strip()
if not key.startswith("ed25519:"):
    raise SystemExit("only ed25519 keys are supported")
raw = b58d(key[len("ed25519:"):])
if len(raw) != 64:
    raise SystemExit("an ed25519 secret key has 64 bytes")
print(json.dumps({"account_id": os.environ["ACCOUNT"],
                  "public_key": "ed25519:" + b58e(raw[32:]),
                  "private_key": key}))
PY
  elif [[ -f "$src" ]]; then
    cp "$src" "$dst"
  else
    return 1
  fi
  chmod 600 "$dst"
  jq -r '.public_key' "$dst"
}

ncli() {
  HOME="$WORK" near --quiet "$@" network-config "$NETWORK" sign-with-legacy-keychain send
}

# ---- build -----------------------------------------------------------------------------------

build_wasm() {
  if [[ -n "${WASM:-}" ]]; then
    [[ -s "$WASM" ]] || die "WASM=$WASM is missing or empty"
    return
  fi
  local out="$ROOT/target/near-$NETWORK"
  mkdir -p "$out"
  if cargo near --version >/dev/null 2>&1; then
    say "building claw-guard (${FEATURES[*]:-default features}) with cargo-near"
    cargo near build non-reproducible-wasm --manifest-path contracts/claw-guard/Cargo.toml \
      --locked "${FEATURES[@]}" --out-dir "$out" >&2
  else
    [[ "$NETWORK" == sandbox ]] || die "cargo-near 0.22.0 is needed for the mainnet build (cargo install cargo-near --version 0.22.0 --locked)"
    say "building claw-guard with plain cargo (sandbox rehearsal only)"
    CARGO_ENCODED_RUSTFLAGS=$'-C\x1flink-arg=-s\x1f--cfg\x1fnear' \
      cargo build -p claw-guard --target wasm32-unknown-unknown --release --locked "${FEATURES[@]}" >&2
    cp target/wasm32-unknown-unknown/release/claw_guard.wasm "$out/claw_guard.wasm"
  fi
  WASM="$out/claw_guard.wasm"
}

# D-21: mainnet ran protocol 86 on 1 Nov 2026 and refuses, at link time, a wasm that imports a
# newer host function (attempt 1, docs/PROOF_MAINNET.md). Checked before any transaction.
check_wasm() {
  if [[ -n "${WASM_SHA256:-}" ]]; then
    [[ "$WASM_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "WASM_SHA256 must be 64 lowercase hex characters"
    local got
    got="$(sha256sum "$WASM" | cut -d' ' -f1)"
    [[ "$got" == "$WASM_SHA256" ]] || die "wasm sha256 is $got, not WASM_SHA256 $WASM_SHA256"
  fi
  python3 "$ROOT/scripts/check_wasm_imports.py" "$WASM" >&2 ||
    die "$WASM imports a host function mainnet protocol 86 does not have"
}

# ---- plan ------------------------------------------------------------------------------------

preflight() {
  local chain
  chain="$(rpc status '[]' | jq -r '.result.chain_id')"
  case "$NETWORK" in
    mainnet | testnet) [[ "$chain" == "$NETWORK" ]] || die "RPC $RPC is on '$chain', not $NETWORK" ;;
    sandbox) [[ "$chain" != mainnet && "$chain" != testnet ]] || die "RPC $RPC is on '$chain', not a sandbox" ;;
  esac

  local acct
  acct="$(view_account "$CONTRACT_ID")"
  [[ "$(jq -r '.result.amount // empty' <<<"$acct")" != "" ]] ||
    die "$CONTRACT_ID does not exist yet: the owner creates and funds it (docs/MAINNET.md)"
  BALANCE="$(jq -r '.result.amount' <<<"$acct")"
  local code_hash
  code_hash="$(jq -r '.result.code_hash' <<<"$acct")"
  if [[ "$LOCK_ONLY" == yes ]]; then
    [[ "$code_hash" != 11111111111111111111111111111111 ]] || die "$CONTRACT_ID has no contract to lock"
    local st
    st="$(view_call "$CONTRACT_ID" get_status '{}')"
    jq -e --arg m "$MPC" '.mpc_contract_id == $m' <<<"${st:-null}" >/dev/null 2>&1 ||
      die "$CONTRACT_ID is not an initialised Claw Guard with MPC $MPC"
  else
    [[ "$code_hash" == 11111111111111111111111111111111 ]] ||
      die "$CONTRACT_ID already has a contract ($code_hash); use a fresh account"
  fi
  [[ "$(jq -r '.result.amount // empty' <<<"$(view_account "$OWNER_ID")")" != "" ]] ||
    die "$OWNER_ID does not exist"
  if [[ -n "${AGENT_ID:-}" ]]; then
    [[ "$(jq -r '.result.amount // empty' <<<"$(view_account "$AGENT_ID")")" != "" ]] ||
      die "$AGENT_ID does not exist"
  fi
  if [[ "$NETWORK" != sandbox && "$LOCK_ONLY" != yes ]]; then
    local state
    state="$(view_call "$MPC" state '{}' | jq -r 'keys[0] // empty' 2>/dev/null || true)"
    [[ "$state" == Running ]] || die "MPC $MPC is not Running (state: '${state:-unreadable}')"
  fi

  if [[ "$LOCK_ONLY" == yes ]]; then
    NEEDED=0 FUNDED=yes WASM_BYTES=0
  else
    WASM_BYTES="$(stat -c %s "$WASM")"
    # code + state + the storage reserve + DEMO_RECEIPTS worst-case receipts, in yocto.
    NEEDED="$(python3 -c 'import sys; w,s,r,n,b,c=map(int,sys.argv[1:]); print((w+s+r+n*b)*c)' \
      "$WASM_BYTES" "$STATE_BYTES" "$RESERVE_BYTES" "$DEMO_RECEIPTS" "$RECEIPT_BYTES" "$BYTE_COST_YOCTO")"
    if python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)' "$BALANCE" "$NEEDED"; then
      FUNDED=yes
    else
      FUNDED=no
    fi
  fi

  make_cli_home
  CONTRACT_PK="$(stage_key "$CONTRACT_ID" CONTRACT_PRIVATE_KEY)" ||
    die "no key for $CONTRACT_ID: put it in $CREDS_SRC/$NETWORK/$CONTRACT_ID.json or CONTRACT_PRIVATE_KEY"
  local on_chain
  on_chain="$(full_access_keys "$CONTRACT_ID")"
  grep -qxF "$CONTRACT_PK" <<<"$on_chain" || die "the key for $CONTRACT_ID is not one of its full-access keys"
  OWNER_KEY=no
  if stage_key "$OWNER_ID" OWNER_PRIVATE_KEY >/dev/null; then OWNER_KEY=yes; fi
  if [[ -n "${AGENT_ID:-}" && "$OWNER_KEY" != yes ]]; then
    die "AGENT_ID is set but there is no key for $OWNER_ID (it signs register_agent)"
  fi

  if [[ "$LOCK_ONLY" == yes ]]; then
    cat >&2 <<PLAN
deploy-mainnet: plan ($NETWORK, RPC $RPC): lock only
  contract     $CONTRACT_ID (deployed, MPC $MPC)
  lock keys    yes (full-access keys on the contract now: $(wc -l <<<"$on_chain" | tr -d ' '))
PLAN
    return
  fi
  cat >&2 <<PLAN
deploy-mainnet: plan ($NETWORK, RPC $RPC)
  contract     $CONTRACT_ID  balance $(yocto_to_near "$BALANCE") NEAR, needs at least $(yocto_to_near "$NEEDED") NEAR -> funded: $FUNDED
  wasm         $WASM ($WASM_BYTES bytes, sha256 $(sha256sum "$WASM" | cut -d' ' -f1))
  mpc          $MPC
  owner        $OWNER_ID (key on this machine: $OWNER_KEY)
  guardian     ${GUARDIAN_ID:-none}
  agent        ${AGENT_ID:-none (no register_agent, no preview)}
  lock keys    $LOCK (full-access keys on the contract now: $(wc -l <<<"$on_chain" | tr -d ' '))
PLAN
  [[ "$FUNDED" == yes ]] || die "fund $CONTRACT_ID first (docs/MAINNET.md, Funding)"
}

# ---- go --------------------------------------------------------------------------------------

deploy_and_init() {
  local init
  init="$(jq -cn --arg o "$OWNER_ID" --arg g "${GUARDIAN_ID:-}" --arg m "$MPC" \
    '{owner_id: $o, guardian_id: (if $g == "" then null else $g end), mpc_contract_id: $m,
      sign_deposit_yocto: "1", sign_gas_tgas: 100, loosen_delay_sec: 600}')"
  say "1/3 deploy + new on $CONTRACT_ID"
  HOME="$WORK" near --quiet contract deploy "$CONTRACT_ID" use-file "$WASM" \
    with-init-call new json-args "$init" prepaid-gas "$INIT_GAS" attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send >&2
}

demo_checks() {
  say "2/3 demo checks"
  local status
  status="$(view_call "$CONTRACT_ID" get_status '{}')"
  [[ -n "$status" ]] || die "get_status failed after deploy"
  jq -e --arg m "$MPC" --arg o "$OWNER_ID" \
    '.mpc_contract_id == $m and .owner == $o and .paused == false' <<<"$status" >/dev/null ||
    die "unexpected get_status: $status"
  say "   get_status: owner $OWNER_ID, mpc $MPC, not paused"
  local meta
  meta="$(view_call "$CONTRACT_ID" contract_source_metadata '{}')"
  say "   contract_source_metadata: $(jq -c '{version, link}' <<<"${meta:-null}" 2>/dev/null || echo none)"

  [[ -n "${AGENT_ID:-}" ]] || return 0
  local now_ns rules
  now_ns="$(rpc block '{"finality":"final"}' | jq -r '.result.header.timestamp_nanosec')"
  rules="$(jq -c --arg exp "$(python3 -c 'import sys; print(int(sys.argv[1]) + 7*86400*10**9)' "$now_ns")" \
    'del(._comment) | .expires_at_ns = $exp' demo/rules.json)"
  say "   register_agent $AGENT_ID (demo rules, expire in 7 days), signed by $OWNER_ID"
  ncli contract call-function as-transaction "$CONTRACT_ID" register_agent \
    json-args "$(jq -cn --arg a "$AGENT_ID" --argjson r "$rules" '{agent_id: $a, rules: $r}')" \
    prepaid-gas "$CALL_GAS" attached-deposit '1 yoctoNEAR' sign-as "$OWNER_ID" >&2

  local nonce_ms within over
  nonce_ms="$(python3 -c 'import sys; print(int(sys.argv[1]) // 10**6)' "$now_ns")"
  within="$(preview BTC 0.001 "$nonce_ms")"
  over="$(preview BTC 0.02 "$((nonce_ms + 1))")"
  jq -e 'has("Ok")' <<<"$within" >/dev/null || die "preview within the rules was not Ok: $within"
  jq -e 'has("Ok") | not' <<<"$over" >/dev/null || die "preview over the size cap was not blocked: $over"
  say "   preview BTC 0.001: Allowed: within your limits"
  say "   preview BTC 0.02:  $(jq -r '.Err // tostring' <<<"$over")"
}

preview() {
  view_call "$CONTRACT_ID" preview_payload "$(jq -cn --arg a "$AGENT_ID" --arg sz "$2" --arg n "$3" --arg m "$1" \
    '{agent_id: $a, proposal: {target: "HlTestnet", order: {HlOrder: {market: $m, is_buy: true,
      limit_px: "10000", sz: $sz, reduce_only: false, tif: "Gtc", nonce_ms: $n}}, memo: null}}')"
}

lock_keys() {
  if [[ "$LOCK" != yes ]]; then
    say "3/3 skipped: LOCK_KEYS=no, $CONTRACT_ID keeps its full-access key"
    return
  fi
  local keys
  keys="$(full_access_keys "$CONTRACT_ID" | paste -sd, -)"
  say "3/3 deleting the full-access keys of $CONTRACT_ID (Q-14): ${keys}"
  ncli account delete-keys "$CONTRACT_ID" public-keys "$keys" >&2
  local left
  left="$(full_access_keys "$CONTRACT_ID")"
  [[ -z "$left" ]] || die "full-access keys still on $CONTRACT_ID: $left"
  say "   locked: $CONTRACT_ID has no full-access key; its code can no longer change"
}

main() {
  check_inputs
  if [[ "$LOCK_ONLY" != yes ]]; then
    build_wasm
    check_wasm
  fi
  preflight
  if [[ "$GO" != yes ]]; then
    say "Plan only: no transaction sent. Re-run with MAINNET_GO=yes after the owner's go."
    exit 0
  fi
  if [[ "$LOCK_ONLY" != yes ]]; then
    deploy_and_init
    demo_checks
  fi
  lock_keys
  if [[ "$NETWORK" == mainnet ]]; then
    say "done: https://nearblocks.io/address/$CONTRACT_ID"
  else
    say "done ($NETWORK rehearsal)"
  fi
}

main "$@"
