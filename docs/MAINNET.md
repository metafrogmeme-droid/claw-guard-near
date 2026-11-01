# Claw Guard on NEAR mainnet (optional, owner go only)

Status (1 Nov 2026): **deployed and locked** at 17:05 CET (attempt 2, CI reproducible wasm).
Attempt 1 failed at link time (protocol 86, see below). Run log:
[PROOF_MAINNET.md](PROOF_MAINNET.md). Everything below runs only from the owner's own machine, only
after the owner says go, and only with `MAINNET_GO=yes`. The server never holds mainnet keys. The prize-payout account is never used
here.

The hackathon does not need a mainnet deploy: testnet-only projects are eligible in every track
(hackathon FAQ Q-010). This page is for a small, low-value mainnet demo next to the testnet one.

## What changes on mainnet, and what does not

- **Contract.** The default wasm stays testnet-only: `new` panics `ERR_MAINNET_REFUSED` unless the
  contract and MPC are both `.testnet` (or both `.test.near`, sandbox). A wasm built with
  `--features mainnet` also accepts exactly one more pair: a named `.near` contract account with
  the mainnet MPC `v1.signer` (`is_mainnet_pair` in `contracts/claw-guard/src/lib.rs`; unit tests
  run with and without the feature in CI). Nothing else in the contract differs.
- **Targets do not change.** The Hyperliquid source `"b"` (testnet) and the Base Sepolia chain id
  84532 are compile-time constants, so a mainnet guard still signs only Hyperliquid testnet orders
  and Base Sepolia transfers. No mainnet funds on any other chain can be moved by it.
- **Off-chain tools stay testnet/sandbox only** (`offchain/src/config.ts` refuses mainnet). The
  mainnet demo uses `scripts/deploy-mainnet.sh` (near-cli-rs) and read-only views.

## Accounts

| Role | Account | Funding | Key |
|---|---|---|---|
| Demo owner (funds the others, owns the rules) | implicit account `c1dca35dc47cf14ca6a9d55c341a462e3f40bc9147e65f5ca51fcbf1b2e90dff` (key made on the owner's machine on 1 Nov 2026; it exists on chain once NEAR arrives) | receives **5.6 NEAR** from the owner | `~/.near-credentials/mainnet/<id>.json` on the owner's machine only (mode 600, outside any repository) |
| Contract | `clawguard-demo.near` (free on 1 Nov 2026; any free named `.near` works) | 5.0 NEAR from the demo owner (stays in the contract; see Funding) | made on the owner's machine at creation; **deleted** in step 3 |
| Demo agent | `clawguard-demo-agent.near` | 0.1 NEAR from the demo owner | made on the owner's machine at creation; not used by the script (views only) |
| Prize payout | the owner's own NEAR wallet | none from here | never on the deploy machine |

The contract must be a named `.near` account (the mainnet build accepts nothing else), so the demo
owner creates it through the `near` account (`near.create_account`), the way near-cli does for
any top-level name. The owner's EVM (MetaMask) address is not used anywhere in this plan.

## Funding (1 Nov 2026)

Storage costs 10^19 yoctoNEAR per byte (mainnet protocol config, read on 1 Nov 2026).

| Item | Bytes | NEAR |
|---|---|---|
| Contract code (near-sdk 5.30.0 build of 1 Nov, before D-21; the near-sdk 5.29.1 wasm is about 3 KB smaller) | 289,204 | 2.892 |
| Guard state, one agent, keys, margin | 8,000 | 0.080 |
| Storage reserve kept free (D-18) | 4,096 | 0.041 |
| 200 worst-case receipts (702 bytes each) | 140,400 | 1.404 |
| **Minimum the script checks for on the contract** | 441,700 | **4.417** |
| Contract funding (the rest pays deploy and init gas, under 0.01 NEAR) | | **5.0** |
| Demo agent account | | 0.1 |
| Left on the demo owner: account creation and `register_agent` gas, buffer | | 0.5 |
| **Total to send to the demo owner account** | | **5.6 NEAR** |

After step 3 (key lock) the contract account has no key and no withdraw method, so the 5 NEAR on
it stay there for good. Treat them as spent. With `LOCK_KEYS=no` they stay recoverable with the
contract key, but that key could then also call MPC `sign` as the contract (Q-14). What is left on
the demo owner and agent accounts stays recoverable.

Each order the agent sends pays its own gas; an allowed order also pays the 1 yoctoNEAR sign
deposit out of the contract balance (the deposit verified on testnet; mainnet `v1.signer` is
`Running`, version 3.17.0, read on 1 Nov 2026).

## What the owner provides

1. **5.6 NEAR** sent to `c1dca35dc47cf14ca6a9d55c341a462e3f40bc9147e65f5ca51fcbf1b2e90dff` from a
   NEAR wallet or an exchange withdrawal (network: NEAR). Not from the prize-payout wallet.
2. A go for the mainnet run.

No key is shared in chat or stored in the repository.

## Steps (on the owner's machine, after the go)

```sh
# 0. Tools: near-cli-rs 0.30.1 and cargo-near 0.22.0 (both published binaries, sha256 checked)
near --version; cargo near --version
OWNER=c1dca35dc47cf14ca6a9d55c341a462e3f40bc9147e65f5ca51fcbf1b2e90dff

# 1. The contract and agent accounts, created and funded by the demo owner.
near account create-account fund-myself clawguard-demo.near '5 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as "$OWNER" network-config mainnet sign-with-legacy-keychain send
near account create-account fund-myself clawguard-demo-agent.near '0.1 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as "$OWNER" network-config mainnet sign-with-legacy-keychain send

# 2. The exact CI build: artifact claw-guard-wasm-<main sha> of the `reproducible` job
#    (claw_guard.mainnet.wasm and SHA256SUMS), downloaded to target/ci-wasm/.
WASM="$PWD/target/ci-wasm/claw_guard.mainnet.wasm"
WASM_SHA256="$(grep ' claw_guard.mainnet.wasm$' target/ci-wasm/SHA256SUMS | cut -d' ' -f1)"

# 3. Plan only (read-only: checks the wasm sha256 and host imports, chain id, accounts, balance,
#    keys, MPC state).
WASM="$WASM" WASM_SHA256="$WASM_SHA256" CONTRACT_ID=clawguard-demo.near OWNER_ID="$OWNER" \
  AGENT_ID=clawguard-demo-agent.near scripts/deploy-mainnet.sh

# 4. The run: deploy + new, demo checks, key lock.
MAINNET_GO=yes WASM="$WASM" WASM_SHA256="$WASM_SHA256" CONTRACT_ID=clawguard-demo.near \
  OWNER_ID="$OWNER" AGENT_ID=clawguard-demo-agent.near scripts/deploy-mainnet.sh
```

`scripts/deploy-mainnet.sh` with `MAINNET_GO=yes`:

1. deploys the `mainnet`-feature wasm and calls `new` in one transaction (`owner_id`, optional
   `guardian_id`, `mpc_contract_id` `v1.signer`, `sign_deposit_yocto` 1, `sign_gas_tgas` 100,
   `loosen_delay_sec` 600, the testnet defaults);
2. checks `get_status` (owner, MPC, not paused) and `contract_source_metadata`; with `AGENT_ID`,
   registers the agent with `demo/rules.json` (owner, 1 yoctoNEAR) and runs two
   `preview_payload` views: `BTC 0.001` gives `Allowed: within your limits`, `BTC 0.02` gives
   `Blocked by your rule: order is above your per-order cap`;
3. deletes every full-access key of the contract account and checks none is left (Q-14).

It refuses to run when: the RPC is not on mainnet; the contract account is missing, already has
code, or holds less than the minimum; the key on the owner's machine is not a full-access key of the
contract; `AGENT_ID` is set without the owner's key; or the MPC is not `Running`.

`LOCK_ONLY=yes` skips deploy and checks and only deletes the full-access keys of an already
deployed guard. With `CLAWGUARD_NETWORK=testnet` it does the same for the testnet guard (MPC
`v1.signer-prod.testnet`), when the owner wants Q-14 there too.

## Checked without mainnet transactions (1 Nov 2026)

- Unit tests: `cargo test -p claw-guard` and `cargo test -p claw-guard --features mainnet`
  (`is_mainnet_pair`, init accepted only in the mainnet build, mixed pairs refused in both).
- `scripts/rehearse-mainnet-sandbox.sh` on a local sandbox node (neard 2.14.0): plan-only run
  sends nothing; the full run deploys, initialises, registers the agent, gets one Allowed and one
  Blocked preview and deletes the contract's only full-access key; `LOCK_KEYS=no` keeps the key;
  `LOCK_ONLY=yes` deletes it later; a second deploy on the locked account is refused. A key from
  `CONTRACT_PRIVATE_KEY` works as well as a keychain file. `shellcheck` is clean on both scripts.
- Read-only against mainnet RPC: a missing contract account (`clawguard-demo.near`, with the
  demo owner above) and a non-`.near` id are refused after the build.
- Read-only against testnet RPC: `LOCK_ONLY` finds the deployed testnet guard
  (`get_status` MPC `v1.signer-prod.testnet`) and stops because no key is on the owner's machine.

## Host functions on mainnet protocol 86 (D-21)

Mainnet ran protocol 86 on 1 Nov 2026 (nodes 2.14.0, which support up to 88); testnet ran 88.
A wasm that imports a host function the chain's protocol does not have fails at link time:
attempt 1 (near-sdk 5.30.0) failed with `Link Error: unknown or invalid import` because near-sys
0.4.0 imports `promise_batch_action_universal_state_init` (`universal_accounts`, protocol 88).

- near-sdk is pinned to 5.29.1 with near-sdk-env 0.1.6 (near-sys 0.2.14), the newest release
  without protocol-87/88 imports. near-workspaces 0.23.0 goes with it.
- `scripts/near-host-fns-protocol-86.txt` lists the host functions protocol 86 links (nearcore
  2.14.0 `imports.rs` minus the functions gated by flags still off at 86).
  `scripts/check_wasm_imports.py` refuses any other import. CI runs it on every wasm (rust and
  reproducible jobs) and `scripts/deploy-mainnet.sh` runs it before any transaction.
- Rehearsal at protocol 86: `SANDBOX_PROTOCOL=86 WASM=<mainnet wasm>
  scripts/rehearse-mainnet-sandbox.sh` starts the sandbox node 2.14.0 at protocol 86 and checks
  it is still on 86 at the end. On 1 Nov 2026 the near-sdk 5.30.0 wasm failed there with the same
  link error as on mainnet, and the 5.29.1 wasm passed (deploy, one Allowed and one Blocked
  preview, key lock). The 18 near-workspaces tests, including the MPC sign path with the mock
  MPC, also passed with the node started at protocol 86.

When mainnet runs 88, newer near-sdk releases can come back; extend the allowlist only then.

## Not checked

- The mainnet `v1.signer` sign deposit and yield timing (verified on testnet only). The script
  sends no `propose_order`; an allowed order on mainnet calls the live MPC.
