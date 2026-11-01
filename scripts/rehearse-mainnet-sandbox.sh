#!/usr/bin/env bash
# Claw Guard: rehearse scripts/deploy-mainnet.sh end to end on a local NEAR sandbox node.
# Sandbox only: every key here is a throwaway sandbox key. No testnet or mainnet access.
#
# Starts near-sandbox (the binary npm installed for offchain/), creates owner, agent, guardian
# and contract accounts plus the mock MPC from the sandbox's test.near, then runs
# deploy-mainnet.sh with CLAWGUARD_NETWORK=sandbox twice: once without MAINNET_GO (plan only,
# must send nothing) and once with MAINNET_GO=yes (deploy, demo checks, key lock).
#
# Optional:
#   SANDBOX_PROTOCOL  start the node at this protocol version instead of its newest (e.g. 86, the
#                     NEAR mainnet version on 1 Nov 2026; D-21). The run checks that the node is
#                     still on it at the end, so the deploy really ran with that version's host
#                     functions.
#   WASM              passed on to deploy-mainnet.sh (e.g. the mainnet-feature or CI wasm).
#
# Needs: near (near-cli-rs 0.30), jq, python3, curl, `make deps` done (offchain/node_modules).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${SANDBOX_PORT:-3931}"
RPC="http://127.0.0.1:$PORT"
SB_BIN="$(find offchain/node_modules/near-sandbox/bin -name near-sandbox -type f | head -1)"
[[ -x "$SB_BIN" ]] || {
  echo "rehearse: near-sandbox not found; run make deps first" >&2
  exit 1
}

WORK="$(mktemp -d)"
SB_PID=""
cleanup() {
  [[ -z "$SB_PID" ]] || kill "$SB_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf 'rehearse: %s\n' "$*" >&2; }

"$SB_BIN" --home "$WORK/node" init >/dev/null 2>&1
if [[ -n "${SANDBOX_PROTOCOL:-}" ]]; then
  [[ "$SANDBOX_PROTOCOL" =~ ^[0-9]+$ ]] || {
    echo "rehearse: SANDBOX_PROTOCOL must be a number" >&2
    exit 1
  }
  jq --argjson v "$SANDBOX_PROTOCOL" '.protocol_version = $v' "$WORK/node/genesis.json" >"$WORK/genesis.json"
  mv "$WORK/genesis.json" "$WORK/node/genesis.json"
fi
bash scripts/sandbox_env.sh "$SB_BIN" --home "$WORK/node" run \
  --rpc-addr "127.0.0.1:$PORT" --network-addr "127.0.0.1:$((PORT + 21000))" >"$WORK/node.log" 2>&1 &
SB_PID=$!
for _ in $(seq 1 60); do
  curl -sf "$RPC/status" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$RPC/status" >/dev/null || {
  echo "rehearse: sandbox did not start" >&2
  exit 1
}
protocol_now() { curl -sf "$RPC/status" | jq -r '.protocol_version'; }
say "sandbox up at $RPC (protocol $(protocol_now))"
if [[ -n "${SANDBOX_PROTOCOL:-}" && "$(protocol_now)" != "$SANDBOX_PROTOCOL" ]]; then
  echo "rehearse: FAIL, the node is on protocol $(protocol_now), not $SANDBOX_PROTOCOL" >&2
  exit 1
fi

CREDS="$WORK/creds"
mkdir -p "$CREDS/sandbox" "$WORK/home/.config/near-cli"
jq '{account_id, public_key, private_key: .secret_key}' "$WORK/node/validator_key.json" \
  >"$CREDS/sandbox/test.near.json"
cat >"$WORK/home/.config/near-cli/config.toml" <<TOML
version = "5"
credentials_home_dir = "$CREDS"

[network_connection.sandbox]
network_name = "sandbox"
rpc_url = "$RPC/"
wallet_url = "https://app.mynearwallet.com/"
explorer_transaction_url = "https://nearblocks.io/txns/"
linkdrop_account_id = "test.near"
TOML

ncli() { HOME="$WORK/home" near --quiet "$@"; }

full_keys() {
  curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    jq -r '.result.keys[] | select(.access_key.permission == "FullAccess") | .public_key'
}

create() {
  ncli account create-account fund-myself "$1" "$2" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as test.near network-config sandbox \
    sign-with-legacy-keychain send >/dev/null
  say "created $1 ($2)"
}

create owner.test.near '5 NEAR'
create agent.test.near '1 NEAR'
create guardian.test.near '1 NEAR'
create clawguard.test.near '10 NEAR'
create mock-mpc.test.near '5 NEAR'

MOCK_WASM="$(bash scripts/build_contracts.sh mock-mpc | sed -n 's/^mock-mpc=//p')"
ncli contract deploy mock-mpc.test.near use-file "$MOCK_WASM" with-init-call new json-args '{}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config sandbox \
  sign-with-legacy-keychain send >/dev/null
say "mock MPC deployed"

export CLAWGUARD_NETWORK=sandbox NEAR_RPC_URL="$RPC" MPC_ID=mock-mpc.test.near \
  NEAR_CREDENTIALS_DIR="$CREDS" CONTRACT_ID=clawguard.test.near OWNER_ID=owner.test.near \
  GUARDIAN_ID=guardian.test.near AGENT_ID=agent.test.near

say "run 1: plan only (no MAINNET_GO)"
before="$(curl -s "$RPC" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"clawguard.test.near"}}' | jq -r '.result.code_hash')"
MAINNET_GO=no bash scripts/deploy-mainnet.sh
after="$(curl -s "$RPC" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"clawguard.test.near"}}' | jq -r '.result.code_hash')"
[[ "$before" == "$after" ]] || {
  echo "rehearse: FAIL, the plan-only run changed the contract account" >&2
  exit 1
}
say "run 1 sent nothing (code hash unchanged)"

say "run 2: MAINNET_GO=yes (sandbox), contract key from CONTRACT_PRIVATE_KEY instead of a file"
CONTRACT_PRIVATE_KEY="$(jq -r .private_key "$CREDS/sandbox/clawguard.test.near.json")"
export CONTRACT_PRIVATE_KEY
rm "$CREDS/sandbox/clawguard.test.near.json"
MAINNET_GO=yes bash scripts/deploy-mainnet.sh

say "run 2b: LOCK_ONLY on a second guard deployed with LOCK_KEYS=no"
unset CONTRACT_PRIVATE_KEY
create clawguard2.test.near '10 NEAR'
CONTRACT_ID=clawguard2.test.near AGENT_ID='' LOCK_KEYS=no MAINNET_GO=yes bash scripts/deploy-mainnet.sh
[[ -n "$(full_keys clawguard2.test.near)" ]] || {
  echo "rehearse: FAIL, LOCK_KEYS=no deleted the key" >&2
  exit 1
}
CONTRACT_ID=clawguard2.test.near LOCK_ONLY=yes MAINNET_GO=no bash scripts/deploy-mainnet.sh
[[ -n "$(full_keys clawguard2.test.near)" ]] || {
  echo "rehearse: FAIL, a plan-only LOCK_ONLY run deleted the key" >&2
  exit 1
}
CONTRACT_ID=clawguard2.test.near LOCK_ONLY=yes MAINNET_GO=yes bash scripts/deploy-mainnet.sh
[[ -z "$(full_keys clawguard2.test.near)" ]] || {
  echo "rehearse: FAIL, LOCK_ONLY left a full-access key" >&2
  exit 1
}

say "run 3: a second deploy is refused (account has code, no key)"
if MAINNET_GO=yes bash scripts/deploy-mainnet.sh 2>"$WORK/run3.log"; then
  echo "rehearse: FAIL, a second deploy was not refused" >&2
  exit 1
fi
grep -q 'already has a contract' "$WORK/run3.log"
if [[ -n "${SANDBOX_PROTOCOL:-}" && "$(protocol_now)" != "$SANDBOX_PROTOCOL" ]]; then
  echo "rehearse: FAIL, the node moved to protocol $(protocol_now) during the run" >&2
  exit 1
fi
say "PASS (protocol $(protocol_now))"
