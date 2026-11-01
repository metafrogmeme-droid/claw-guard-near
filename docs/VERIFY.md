# Verification log

Prototype. Testnet only. Not audited.
The server never holds mainnet keys or signs for users.

What was checked, how, and what still needs NEAR testnet or Hyperliquid testnet. Status on
31 Oct 2026. "Source" means read in the upstream source code; "sandbox" means observed on a local
NEAR sandbox node (neard 2.14.0) with this repository's contract wasm; "testnet" means observed on
NEAR testnet, Hyperliquid testnet or Base Sepolia. **NEAR testnet: `make demo-testnet` was run twice
on 31 Oct 2026**, with the owner's go, on Linux boxes that can reach NEAR testnet. The first run
(10:22 to 10:26 CET; 10:19 was the testnet faucet creating the owner account and a second funding
account, before the demo) passed, with real signatures from `v1.signer-prod.testnet` (section (h)).
The second, on merged `main` (`5beee31`) with a fresh owner account and the recipe's commands run
by hand, passed with the same decisions (section (i)). The
original build container could not reach NEAR testnet, Hyperliquid, docs.near.org or GitHub.
Hyperliquid testnet and Base Sepolia have still not been touched.

Commit ids (for example `5beee31`, `67c479f`, `4312aab`) and pull request numbers in this page refer to the
private development repository; this public repository starts from one snapshot commit of its `main`.

## (a) Design assumptions and what is verified

| Fact | What we checked | Status | Still needs |
|---|---|---|---|
| Function-call keys can only call the named receiver/methods and cannot attach deposits | Sandbox: `tests/negative_keys.rs` gets the exact protocol errors `RequiresFullAccess`, `DepositWithFunctionCall`, `ReceiverMismatch`, `MethodNameMismatch` | Verified (sandbox) | — |
| An account with only function-call keys cannot transfer, add keys or remove itself | Sandbox: transfer, AddKey, DeleteKey, DeployContract, DeleteAccount, CreateAccount are refused with `RequiresFullAccess`; balance and keys unchanged | Verified (sandbox) | — |
| 1 yoctoNEAR proves a full-access key signed | Sandbox: owner methods without the deposit, with 2 yocto, or from a function-call key are refused | Verified (sandbox) | — |
| Testnet MPC contract is `v1.signer-prod.testnet` and live | Testnet: `public_key({domain_id:0})` and `derived_public_key` answered; 7 real `sign` calls from the deployed guard returned signatures (section (h)) | Verified (testnet) | — |
| `sign` request JSON `{request:{path, payload_v2:{Ecdsa:"<64 hex>"}, domain_id:0}}` | Source: `near/mpc` `main` (`crates/contract/src/api/sign.rs`, `near-mpc-crypto-types`). chainsig.js 1.1.16 sends the same shape. mock-mpc implements it | Verified (source + testnet) | — |
| `sign` response `{scheme:"Secp256k1", big_r:{affine_point}, s:{scalar}, recovery_id}` | Source: `SignatureResponse` is `#[serde(tag="scheme")]`. The contract parses it leniently (missing `scheme`, `0x`, upper case) and fails closed otherwise | Verified (source + testnet: the contract parsed all 7 live responses; `verify-sig` recovers the derived address for each) | — |
| Sign deposit | Source: `SIGN_DEPOSIT_YOCTONEAR = 1`; chainsig.js 1.1.16 attaches 1 yocto. The contract keeps it as config `sign_deposit_yocto` (setup default 1, `--sign-deposit-yocto`) | Testnet: the guard attached 1 yoctoNEAR to `sign` and `v1.signer-prod.testnet` accepted it (tx `E24LZa6F…`, section (h)) | Verified (testnet) | — |
| Sign gas and the yield | Mock `sign` burns 15.68 Tgas and returns at once; the guard reserves `sign_gas_tgas` 100 + 20 + 10 Tgas | Testnet: an allowed `propose_order` burns about 14.4 Tgas in total (about 0.00135 testnet NEAR); the MPC's two receipts burn 4.28 + 3.47 Tgas. The `sign` call was attached 276 Tgas (the 100 Tgas static part plus the unused gas), the callback 20 Tgas. Each call returned its decision within the RPC wait (`EXECUTED_OPTIMISTIC`; orders were 11 to 17 s apart); the agent never had to poll `get_receipt` | Verified (testnet) | — |
| Testnet MPC root public key | Taken from chainsig.js 1.1.16 `constants.ROOT_PUBLIC_KEYS.TESTNET`; our derivation matches chainsig.js for 5 vectors | Testnet: the live `public_key` equals the pinned constant; `derive` against the live `derived_public_key` agrees with the local math for both paths (no disagreement note) | Verified (testnet) | — |
| Distinct derivation path per chain | `hl-testnet-1`, `base-sepolia-1` (compile-time constants, `get_paths`) | Done | — |
| Shade Agents deprecated | Not used | n/a | — |
| `view_access_key_list` RPC | near-api-js 7.4.0 `viewAccessKeyList` against a real sandbox node: Claw Watch saw exactly `Public signal: new full-access key on agent-1.test.near` after a patched key | Verified (sandbox) | — |
| Hyperliquid L1 action signing (msgpack, connectionId, phantom agent `"b"`, EIP-712 domain) | 10 order and 4 updateLeverage vectors from hyperliquid-python-sdk 0.24.0 match in Rust and TypeScript (action JSON, msgpack bytes, connectionId, digest); each reference signature recovers | Verified (source + vectors) | — |
| Hyperliquid action shapes and key order | `{"type","orders":[{a,b,p,s,r,t:{limit:{tif}}}],"grouping":"na"}` and `{"type","asset","isCross","leverage"}` match SDK 0.24.0 | Verified (vectors) | — |
| `approveAgent` typed data | 2 SDK vectors match (domain `HyperliquidSignTransaction`, chainId `0x66eee`, `hyperliquidChain:"Testnet"`) | Verified (vectors) | — |
| Hyperliquid testnet accepts an MPC-derived address as API wallet | Not run | **UNVERIFIED** | Hyperliquid spike, section (f) |
| Hyperliquid testnet asset indices (BTC 3, ETH 4) and `szDecimals` (BTC 5, ETH 4) in `demo/rules.json` | From fixtures and the brief | **UNVERIFIED** | Testnet: `/info` `meta` |
| Hyperliquid price rule "at most 5 significant figures" | Enforced as specified in the brief; Hyperliquid docs not reachable from the container | **UNVERIFIED** against venue docs | Testnet: venue response to an edge price |
| Hyperliquid `/info` `extraAgents` shape | From the SDK 0.24.0 `Info.extra_agents` docstring: list of `{name, address, validUntil}` | Source | Testnet response |
| Hyperliquid `/info` `approvedBuilders` shape | No SDK wrapper; the parser accepts a list of addresses or objects with `builder`/`address` and treats anything else as a source error | **UNVERIFIED** | Testnet response |
| Hyperliquid testnet funds via the Circle faucet route | Not tried | **UNVERIFIED** | Owner, testnet |
| Base Sepolia chain id 84532 and EIP-1559 encoding | Hand-rolled RLP equals viem 2.57.7 for 5 vectors; signed-tx fields decode back; chain id is a constant | Verified (vectors) | Testnet: one broadcast |
| Base Sepolia Circle USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Not checked against Circle docs (not reachable) | **UNVERIFIED** | Circle docs / Base Sepolia explorer |
| Testnet explorer link format `https://testnet.nearblocks.io/address/<account>` (key alerts) | Opened for the contract account on 31 Oct 2026: it lists the account's 15 transactions | Verified (testnet) | — |

## (b) Versions pinned

| Layer | Pinned | First planned | Why it differs |
|---|---|---|---|
| Rust | 1.97 (`rust-toolchain.toml`; rustc 1.97.1) | 1.95 | Owner decision D-02 (near-sdk 5.30.0 needs 1.95 or newer). |
| near-sdk | 5.29.1 (`=5.29.1`, with near-sdk-env `=0.1.6`, near-sys 0.2.14) | 5.30.0 | Owner decision D-21: 5.30.0 imports a protocol-88 host function that NEAR mainnet (protocol 86) refuses. |
| cargo-near | 0.22.0 (optional) | 0.22.0 | Plain cargo fallback added in `scripts/build_contracts.sh`. |
| near-workspaces | 0.23.0 (uses `near-sandbox` crate 0.3.16; the tests pin the sandbox node neard 2.14.0) | 0.24.0 | D-21: 0.24.0 needs near-crypto 0.38, which cannot share a lock file with near-sdk 5.29.1. |
| Other Rust | `k256` 0.14.0, `tokio` 1.53.3, `sha3` 0.11.0, `serde_json` 1.0.154, `anyhow` 1.0.104 (Cargo.lock) | — | tokio 1.53.3 is the newest release at least 14 days old (1.54.0 is yanked). |
| EVM tx in the contract | hand-rolled RLP (`evm.rs`) | `omni-transaction` 0.5.0 | The planned fallback; checked byte for byte against viem. `omni-transaction` is not used. |
| HL msgpack in the contract | hand-rolled (`msgpack.rs`) | hand-rolled | — |
| Node | 22.22.2 or newer 22.x (`.nvmrc`, `engines`, Makefile check) | 22 LTS | Owner decision D-06: near-api-js 7.4.0 and near-sandbox 0.3.4 declare `>=22.22.2`. |
| near-api-js | 7.4.0 | 7.4.0 | — |
| chainsig.js | not a dependency | 1.1.16 | Derivation and response parsing are implemented with `@noble/curves` / `@noble/hashes` 2.4.0; chainsig.js was used once, outside the repo, to generate the cross-check vectors in `offchain/test/vectors/derive_mpc.json`. |
| viem | 2.57.7 | 2.57.x | Same version that generated the EVM vectors. |
| @msgpack/msgpack | 3.1.3 | 3.1.3 | — |
| vitest | 5.0.5 (+ `vite` 8.3.4 pinned as its peer) | 5.0.x | — |
| TypeScript | 6.0.3 | 7.0.x | `typescript-eslint` 8.71.2 supports TypeScript below 6.1 only; 6.0.3 is also what near-api-js 7.4.0 builds with. |
| tsx | 4.23.15 | 4.23.x | — |
| eslint | 10.12.0, `typescript-eslint` 8.71.2, `@eslint/js` 10.0.1 | — | — |
| near-sandbox (npm) | 0.3.4, pinned to start neard 2.14.0 (`SANDBOX_NODE_VERSION` in `offchain/src/cli/setup.ts`) | — | Its own default is 2.13.4; one node version for the demo and the Rust tests. |
| @anthropic-ai/sdk | 0.135.0 (optional LLM mode, model `claude-opus-5-5`) | — | Added for the optional LLM agent mode (off by default). |
| near-cli-rs | not used | 0.30.1 | Setup is scripted in TypeScript (near-api-js). |
| hyperliquid-python-sdk | 0.24.0, dev only (`scripts/hl_vectors.py`) | 0.24.0 | — |
| gitleaks | v8.30.1 with `.gitleaks.toml` (run locally; the CI workflow builds the same version with `go install`) | `gitleaks-action` v3.0.0 in CI | The CI workflow uses the gitleaks binary instead of the action, so no organisation licence key is involved. |

npm dependencies were resolved with `npm install --before=<date>` so no transitive package was
newer than the pinned direct ones. `npm audit` on 31 Oct 2026: runtime dependencies
(`--omit=dev`) 2 advisories, 1 critical in `tar` and 1 moderate in `near-sandbox` because of it
(near-sandbox uses `tar` to unpack the sandbox node download); with dev dependencies 13 (12
moderate, 1 critical), the other 11 in the eslint / typescript-eslint tool chain via `minimatch`.

Fixed on 1 Nov 2026 (Q-32): `offchain/package.json` overrides `tar` to exactly 7.5.22 (released
24 Jul 2026) for `near-sandbox` only, instead of npm's offered breaking downgrade of near-sandbox.
All six `tar` advisories cover 7.5.20 or older. With the override, near-sandbox downloaded and
unpacked the sandbox node 2.14.0 into an empty folder, and the unpacked binary has the same sha256
as the one pinned in `scripts/sandbox_env.sh` (`797b9d7a…f13`). `npm audit --omit=dev` now reports
0 vulnerabilities, and the CI `offchain` job fails if a runtime advisory appears
(`npm audit --omit=dev`). `offchain/test/supply_chain.test.ts` fails if the override or the
locked `tar` version goes away.

Recorded, not fixed: 11 moderate advisories remain in dev dependencies only, all from one
`minimatch` advisory (GHSA-g3hv-75wg-m249, a slow match on crafted glob patterns) used by eslint
10.12.0 and typescript-eslint 8.71.2. Its only fix is minimatch 11.0.1, a new major version released
27 Oct 2026, which neither tool accepts yet (eslint 10.14.0 still asks for `^10.2.6`). The glob
patterns come from this repository's own lint config, so nothing outside can supply one, and none
of these packages ships in the contract or runs in `make demo`.

## (c) Test vectors: where they come from

| File | Generator | Contents |
|---|---|---|
| `offchain/test/vectors/hl_orders.json` (10), `hl_update_leverage.json` (4) | [scripts/hl_vectors.py](../scripts/hl_vectors.py) with hyperliquid-python-sdk 0.24.0, `is_mainnet=False` | action, action JSON, msgpack hex, nonce, connectionId, EIP-712 digest, reference signature |
| `hl_approve_agent.json` (2) | throwaway script calling the SDK's `sign_agent` (`is_mainnet=False`) | approveAgent typed data, digest, signature |
| `evm_transfers.json` (5) | [offchain/scripts/evm_vectors.mjs](../offchain/scripts/evm_vectors.mjs) with viem 2.57.7 | calldata, unsigned tx, payload hash, signed tx (chain 84532) |
| `derive_mpc.json` (5) | throwaway script with chainsig.js 1.1.16 `deriveChildPublicKey` | testnet MPC derivation cross-check (public keys only) |
| `derive_sandbox.json` (4) | throwaway script with viem 2.57.7 | mock-mpc derived addresses, e.g. clawguard / `hl-testnet-1` → `0xb966992b0783f42b2f78a7a94c8f190f03758a96` |

Every signing key used for vectors is derived at run time from a public label
(`clawguard-test-vectors-only`): a worthless test key, never funded, never stored in the repo.
Some SDK reference signatures have 63-hex-digit `r`/`s` (the SDK drops a leading zero); tests and
`sig.ts` left-pad them to 32 bytes.

## (d) Sandbox facts observed

- Node: neard 2.14.0, protocol 88 (min 84), from the near-sandbox S3 artifacts dated 26 Oct 2026.
  Pinned sha256 of the binary: x86_64 `797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13`,
  aarch64 `cdc95d49e46e1127274a02067bb39265b935b912f53b82caaabe601be9817bcc`. The Rust crate's
  download, the npm package's download and the fallback's download were byte-identical (x86_64).
- cargo-near 0.22.0 with rustc 1.97.1 builds wasm that neard 2.14.0 runs (`wasm-opt` with bulk
  memory). The plain-cargo fallback wasm also deploys and passes the sandbox tests.
- Protocol refusals for the agent's function-call key (exact errors, from
  `InvalidTransaction { InvalidAccessKeyError(..) }`): `RequiresFullAccess` (Transfer, AddKey,
  DeleteKey, DeployContract, DeleteAccount, CreateAccount + Transfer, FunctionCall + Transfer
  batches); `DepositWithFunctionCall` (any deposit); `ReceiverMismatch` (call to `mock-mpc.test.near`);
  `MethodNameMismatch` (every method but `propose_order`). Refused transactions are not included in
  a block: the agent's balance is unchanged. Balance checks come first (a deposit larger than the
  balance is `NotEnoughBalance`), then the deposit check, then receiver and method.
- Contract panics read `Smart contract panicked: <msg>`; the one-yocto text is
  `Requires attached deposit of exactly 1 yoctoNEAR`.
- `INSUFFICIENT_CONTRACT_BALANCE` is exact: one yoctoNEAR below
  `(storage_usage + 4096) × 10^19 + sign_deposit` is blocked with no promise; exactly at it is signed.
- A failed MPC call reaches `on_signed` as a promise error; the transaction still succeeds with the
  `SignFailed` decision and the 1 yocto deposit is refunded to the contract.
- Sandbox gas price: 1e9 yoctoNEAR per gas (a 300 Tgas call reserves 0.3 NEAR). Gas figures:
  [ARCHITECTURE.md §7](ARCHITECTURE.md#7-gas-sandbox-measurements).
- `sandbox_patch_state` with an `AccessKey` record adds a full-access key that
  `view_access_key_list` shows at once (used by the demo's simulated attacker; loopback only).
- **Open-files limit (owner decision D-13).** neard 2.14.0 sets its open-files limit to 65535 and
  exits with `couldn't set the file descriptor limit to (65535, 65535), current limit = (20000, 20000)`
  when the hard limit is lower and it may not raise it (the build container: 20000, no
  `CAP_SYS_RESOURCE`). `scripts/sandbox_env.sh` detects this and runs only the sandbox node through
  an LD_PRELOAD shim built from `scripts/fdlimit/fdshim.c` with `cc`. The shim interposes
  `setrlimit`, `setrlimit64`, `prlimit` and `prlimit64` for `RLIMIT_NOFILE` on the calling process
  only: it tries the request first and, if the kernel answers `EPERM` and the request is above the
  hard limit, retries with the hard limit. It never raises a limit. Both launchers honour
  `NEAR_SANDBOX_BIN_PATH` (npm near-sandbox 0.3.4 `binPath()`; Rust near-sandbox 0.3.16
  `ensure_sandbox_bin_with_version`; near-workspaces 0.23.0 skips its own download when the
  variable is set). With a hard limit of 65535, 1048576 or `unlimited` nothing is printed or set.
  `make demo` and `make test` print exactly one line on such a host:
  `make: open-files hard limit is 20000 (< 65535): running the sandbox through scripts/fdlimit (sandbox only)`.
  Tested by `tests/fdlimit/test.sh` (24 passed in the build container).

## (e) What was not run

- **NEAR testnet, partly:** deploy, `register_agent`, real MPC `sign`, `make demo-testnet`,
  `receipts`, `verify-sig` and `derive` were run (section (h)), and again on merged `main` with a
  fresh owner account (setup refuses to reuse existing accounts), together with one
  `watch -- --once` (its first poll, the baseline) and the owner-key guards (section (i)). Not run
  on testnet: `watch` alerts after a change / autopause, a guardian `pause`, `set_rules` / loosening.
- **Hyperliquid testnet:** `make spike-hl`, `approve-hl-agent -- --yes`, `relay`, the `/info`
  queries. Covered only by vectors and mocked HTTP.
- **Base Sepolia:** no broadcast, no `eth_chainId` call. Covered by vectors and mocked HTTP.
- **Telegram:** no real message sent (mocked API only).
- **LLM agent mode:** not run against the real Claude API (mocked HTTP only).
- **Docker in the build container:** the build container still has no Docker daemon, so the
  [Dockerfile](../Dockerfile) has been built and run only on GitHub Actions (section (g)).
  `make test` inside the image has not been run anywhere (CI runs only `make demo` there).
- **CI after `67c479f`:** later commits run the workflow again; section (g) records only the
  result on `67c479f`.
- **Platforms:** only Linux x86_64. macOS and aarch64 are not tested; the fd-limit fallback's
  macOS path (skipped there) was checked only with a fake `uname`.
- **Reproducible wasm build** (NEP-0330 image): not run; the image named in
  `contracts/claw-guard/Cargo.toml` targets Rust 1.96 and was not checked against Docker Hub (Q-30).
- **Truly cold machine:** fresh-copy timings (`make demo` 85 to 98 s, `make test` 184 s) used warm
  cargo and npm download caches.
- **Full-history secret scan at freeze:** gitleaks v8.30.1 found the tree and full history clean
  when `.gitleaks.toml` was written (30 Oct 2026), and the CI gitleaks job passed on `67c479f`
  (section (g)); it must run again at code freeze.

Commands run for this page and the README on 31 Oct 2026 (build container, Node 22.22.2):
`make demo` (exit 0, 14 s), `make test` (exit 0, 80 s), `make lint` (exit 0, 14 s), a manual
`setup:sandbox` session with `agent`, `receipts`, `verify-sig`, `derive` and `watch -- --once`,
and the three `ERR_MAINNET_REFUSED` refusals shown in the README. After the `verify-sig` change in
section (i): one more `setup:sandbox` session with `agent -- --scenario normal`, `agent -- --scenario
injection` and `verify-sig -- --receipt` 1, 4, 6, 9, 12 and 99 (`MATCH` with exit 0 for 1 and 4,
`no signature (blocked)` with exit 0 for 6, 9 and 12, `receipt #99 not found on clawguard.test.near`
with exit 1).

README check on 1 Nov 2026, in a fresh local clone of `4312aab` (build container, Node 22.22.2, open-files limit 20000, `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0` for disk space): `make help`, `make demo` (exit 0; 142 s first, 14 s built), `make test` (exit 0; Rust 194, vitest 23 files / 505, fdlimit 24; 170 s first, 79 s built), `make lint` (exit 0, `copy_lint: OK (52 files checked)`; 42 s first, 13 s), the README's `setup:sandbox` session (same receipts and outputs as the README table), the three `ERR_MAINNET_REFUSED` refusals, the `make demo-testnet` / `make spike-hl` refusals without `offchain/.env` or `OWNER_GO=yes`, and `gitleaks dir --config .gitleaks-dir.toml .` (no leaks); no NEAR testnet contact.

## (f) Hyperliquid spike

**HL=GO/NO-GO: not run yet (owner go)**

What the spike does (`make spike-hl OWNER_GO=yes`, after `make demo-testnet OWNER_GO=yes`):

1. Derive the EVM address for (`clawguard.<owner>.testnet`, `hl-testnet-1`) from the testnet MPC.
2. The owner approves it as an API wallet on Hyperliquid testnet with the throwaway testnet master
   key (`approve-hl-agent -- --yes`, agent name `clawguard valid_until <ms>`).
3. The deployed guard signs one far-below-market BTC limit order through `v1.signer-prod.testnet`
   (`agent -- --scenario spike`).
4. The relayer POSTs it to `https://api.hyperliquid-testnet.xyz/exchange` and prints the answer.

Pass: Hyperliquid answers `ok` (order resting or rejected for its price) or with a margin/balance
error; anything other than a signature or agent error (for example "User or API Wallet … does not
exist") means the signature was accepted. Fail → Base Sepolia becomes the primary target.
Record here: date, the derived address, the venue's answer, and the
decision line `HL=GO` or `HL=NO-GO`.

## (g) CI on GitHub Actions

The workflow [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on every push and pull
request. It ran on GitHub Actions for pull request #3. On commit `67c479f` it ran twice, once for
the push and once for the pull request, and all 14 jobs passed (the same 7 jobs in each run):

| Job | What it ran on `67c479f` | Result |
|---|---|---|
| rust | `cargo fmt --check`, clippy `-D warnings`, claw-guard and mock-mpc unit tests, wasm build of both contracts with cargo-near 0.22.0 | Passed (both runs) |
| sandbox | near-workspaces integration tests (`cargo test -p claw-guard-tests` through `scripts/sandbox_env.sh`), then `tests/fdlimit/test.sh` | Passed (both runs) |
| offchain | eslint, `tsc --noEmit`, vitest | Passed (both runs) |
| copy-lint | `scripts/copy_lint.sh` | Passed (both runs) |
| gitleaks | gitleaks v8.30.1 `gitleaks git` over the history reachable from the commit | Passed (both runs) |
| demo-smoke | `make demo` on `ubuntu-24.04`, last line must be `DEMO OK (…)` | Passed (both runs). The runner's open-files hard limit was 65536, and the D-13 shim line did not appear; since this commit the job fails if it does. |
| docker | `docker build` on the runner, then `make demo` inside the image twice | Passed (both runs). With `--ulimit nofile=65535:65535` no shim line was printed; with `--ulimit nofile=20000:20000` it was printed exactly once (the job checks both). |

What this result does not cover:

- Commits after `67c479f`. They run CI again; their results are not recorded here. Among their
  changes: the gitleaks rules self-test step (`scripts/gitleaks_selftest.sh`), the stricter
  `.gitleaks.toml` (no path allowlist, the 32-byte secp256k1 key form) and `libssl-dev` in the
  Dockerfile, none of which was part of the `67c479f` run.
- `make test` inside the Docker image (CI runs only `make demo` there).
- The build container itself, which still has no Docker daemon: nothing Docker-related has been
  run there.
- NEAR testnet, Hyperliquid testnet and Base Sepolia: CI uses only the local sandbox (the two
  NEAR testnet runs are in sections (h) and (i)).

## (h) NEAR testnet run, 31 Oct 2026

`make demo-testnet OWNER_GO=yes`, first run, on 31 Oct 2026 from 10:22 to 10:26 CET on a Linux
x86_64 box (Node 22.23.4, rustc 1.97.1, plain-cargo wasm build), with `NEAR_NETWORK=testnet`,
`NEAR_RPC_URL=https://rpc.testnet.near.org` and `MPC_CONTRACT_ID=v1.signer-prod.testnet`. Exit 0.
Testnet only: every key was made for this run with `gen-testnet-near-key` (`--role owner`, `agent`,
`guardian`) and lives only in that box's `offchain/.env` (mode 600, git-ignored).

Reachability before the run: `rpc.testnet.near.org` `status` answered `chain_id` `testnet`,
protocol 88; the testnet account helper (`helper.testnet.near.org/account`) created accounts with no
captcha.

**Accounts** (explorer: `https://testnet.nearblocks.io/address/<account>`)

| Role | Account | Keys after the run | Balance after the run |
|---|---|---|---|
| Owner | [claw-guard-580c4c.testnet](https://testnet.nearblocks.io/address/claw-guard-580c4c.testnet) | 1 full-access, `ed25519:7BrmDTLu6YyaKFLPT85tGFJGxJZzz3AYofNijNALwpeb` | 13.98 NEAR |
| Contract | [clawguard.claw-guard-580c4c.testnet](https://testnet.nearblocks.io/address/clawguard.claw-guard-580c4c.testnet) | 1 full-access (the owner's key) | 4.997 NEAR |
| Agent | [agent-1.claw-guard-580c4c.testnet](https://testnet.nearblocks.io/address/agent-1.claw-guard-580c4c.testnet) | 1 function-call, `propose_order` on the contract, `ed25519:9aMsHxSocYw33S2LeCkFmbF5DYsHUiQNbxY9kayQWfoP` | 0.489 NEAR |
| Guardian | [guardian.claw-guard-580c4c.testnet](https://testnet.nearblocks.io/address/guardian.claw-guard-580c4c.testnet) | 1 function-call, `pause` on the contract, `ed25519:8Rm1BsuhXDNEQ3ApBs78AmA4ZgrW5ZA2gd9466j2Dx9p` | 0.5 NEAR |

Funding: the helper gave the owner 10 testnet NEAR. A second helper account,
`claw-guard-580c4c-f2.testnet`, was created and deleted with the owner as beneficiary, adding its
10 NEAR (about 20 NEAR before setup; setup used about 6 NEAR plus gas).

**Transactions** (CET; explorer: `https://testnet.nearblocks.io/txns/<hash>`)

If nearblocks does not show these transactions yet (its indexer can lag: right after the rerun in
section (i) its API returned empty transaction lists), look them up through FastNEAR's testnet
transaction API at `tx.test.fastnear.com`; the owner used it on 31 Oct 2026 when nearblocks showed
nothing yet. No FastNEAR endpoint path is recorded here (none was checked from this repository).

| Time | Step | Signer → receiver | Tx |
|---|---|---|---|
| 10:19:24 | Owner account created by the helper (10 NEAR) | testnet → owner | [FMNxYwKN…](https://testnet.nearblocks.io/txns/FMNxYwKNyiT2JzsZvx3KjCqoiCvcPUie6qGVydGNvZ57) |
| 10:19:46 | Second helper account created | testnet → `-f2` | [BUUVVzZE…](https://testnet.nearblocks.io/txns/BUUVVzZEpLu9XnDBf8WuXT38K64AH32Je3UE6YcvSbFv) |
| 10:19:58 | Second account deleted, beneficiary the owner | `-f2` → `-f2` | [8cAoCUB4…](https://testnet.nearblocks.io/txns/8cAoCUB46XRXRYmp1nWg8y4Ug2Bm9MFKomLCHMcsekWe) |
| 10:22:01 | Contract account created (5 NEAR, owner's key) | owner → contract | [9phQr8cx…](https://testnet.nearblocks.io/txns/9phQr8cx3y2ZhJEePcwPeJZuMNt9kyopmejadzMiStgP) |
| 10:22:12 | Deploy `claw-guard` + `new` | contract → contract | [Hn3NjsW8…](https://testnet.nearblocks.io/txns/Hn3NjsW8KobQp4F34WGCo9ttkkV22KcnGit8cSCt4Xz7) |
| 10:22:20 | Agent account created (0.5 NEAR, function-call key) | owner → agent | [96L4QNGL…](https://testnet.nearblocks.io/txns/96L4QNGL1oewB1dY3Uw17pcdYVywJVPhbQimGNnacG4b) |
| 10:22:32 | Guardian account created (0.5 NEAR, function-call key) | owner → guardian | [EVBjGnYo…](https://testnet.nearblocks.io/txns/EVBjGnYotzkn3U6dxpJXjfhyCGtwKbTyzURACrkncAZ1) |
| 10:22:47 | `register_agent` with `demo/rules.json` (7-day expiry) | owner → contract | [5NGz26Kg…](https://testnet.nearblocks.io/txns/5NGz26KgXw7866sU35ETE1kLr8sqR3QTah9MvchSs4RL) |

**Agent run** (`agent -- --scenario all`; every row is one `propose_order` from agent-1; all 12
transactions succeeded, a blocked order is a successful call with a `Blocked` receipt)

| Receipt | Step | Decision | Tx | Signature check |
|---|---|---|---|---|
| #1 | normal: buy 0.001 BTC at 50000 | Allowed, signed by MPC (`sig=0xd43c236f…7f9a`) | [E24LZa6F…](https://testnet.nearblocks.io/txns/E24LZa6F8W4zQaP7VcLaBiLeJeqF3NmnikpiWUuBTiWr) | MATCH `0x1aa5…70e3` |
| #2 | normal: BTC leverage 3x | Allowed, signed | [Da2QrWKo…](https://testnet.nearblocks.io/txns/Da2QrWKocKXBcpsF1pegNUV4UGpkb8V49xrqE9uBAoRD) | MATCH `0x1aa5…70e3` |
| #3 | normal: sell 0.01 ETH at 2000 | Allowed, signed | [3WXBN6uH…](https://testnet.nearblocks.io/txns/3WXBN6uHYGjmf5mygKX2ERPf1fmoN8EeuPLUijN5KCHS) | MATCH `0x1aa5…70e3` |
| #4 | normal: 1 USDC to `0x1111…1111` on Base Sepolia | Allowed, signed | [4TwPd3M7…](https://testnet.nearblocks.io/txns/4TwPd3M7GEZjDXb6kDZcUiReAFUwHFbRBbsKeB2GBxY4) | MATCH `0x6de0…8501` |
| #5 | injection: buy 0.001 BTC at 50000 (before the message) | Allowed, signed | [AfMBgyEw…](https://testnet.nearblocks.io/txns/AfMBgyEwchsFwsh7B4gQ4wEzzBD3sh5qsxrQ4QRXTQpZ) | MATCH `0x1aa5…70e3` |
| #6 | injected: buy 1000 DOGE | Blocked: market DOGE is not on your list | [B2H74sPp…](https://testnet.nearblocks.io/txns/B2H74sPpzLZ4adqumGbiWzmVQGvpjZhNKgmVvQESgTKu) | no signature |
| #7 | injected: buy 5 BTC | Blocked: above your per-order cap | [F4PUawbh…](https://testnet.nearblocks.io/txns/F4PUawbhvXVepFb1MfvKuNP8GA3Bpe4QibJjoHABuDs7) | no signature |
| #8 | injected: BTC leverage 50x | Blocked: leverage 50x is above your limit of 3x | [9pR3LXz1…](https://testnet.nearblocks.io/txns/9pR3LXz1XpendZ6QZqN1Pu2YjWvQfNZb5Xny9bghxFq9) | no signature |
| #9 | injected: 5 USDC to `0xbad…0bad` | Blocked: receiver is not on your list | [FHXQoVY8…](https://testnet.nearblocks.io/txns/FHXQoVY8w45Kcjj7f2wiTWQ6sAsq6bZwUC8EVmhCbrCi) | no signature |
| #10 | injected: buy 0.01 BTC (1 of 3) | Allowed, signed | [7RqwErJm…](https://testnet.nearblocks.io/txns/7RqwErJmikCn8fPVuZDQeMKZywbZCkLfzjRrJda9WXsW) | MATCH `0x1aa5…70e3` |
| #11 | injected: buy 0.01 BTC (2 of 3) | Allowed, signed | [6stCr4gD…](https://testnet.nearblocks.io/txns/6stCr4gD95c6LqTqfMxtzLVp2fV9ToMBjAw49nFvmKQf) | MATCH `0x1aa5…70e3` |
| #12 | injected: buy 0.01 BTC (3 of 3) | Blocked: over your daily cap | [HEuA6zWi…](https://testnet.nearblocks.io/txns/HEuA6zWitBpmwx2wbPqD46JibxJ2RnXwmgug4fo2ufea) | no signature |

Result line: `Agent done: 7 allowed, 5 blocked`, the same decisions as `make demo` on the sandbox.

Checks after the run:

- `receipts` read the same 12 receipts back from the contract view.
- `verify-sig -- --receipt <n>`: for each of the 7 signed receipts the signer recovered from
  payload hash + MPC signature equals the derived address (`MATCH`); #6 has no derivation path
  (blocked), as expected. The code of this run printed that as
  `MISMATCH (receipt #6 has no derivation path; status Blocked)` with exit 1; since section (i) a
  receipt with no signature by design prints `no signature (blocked)` (or
  `no signature (signature request failed)`, `no signature yet (pending)`) with exit 0.
- `derive` against the live MPC (`derived_public_key`, predecessor
  `clawguard.claw-guard-580c4c.testnet`): `hl-testnet-1` →
  `0x1aa57aefbc961faa0e4059cbd9c9c351566e70e3`, `base-sepolia-1` →
  `0x6de02f1ae0d01856b3b48fb3d9886e2f23578501`. The local math agreed for both.
- `view_access_key_list`: agent and guardian each have exactly one function-call key (table above).

Not covered by this run: the signed payloads were not sent to Hyperliquid testnet or Base Sepolia
(`make spike-hl`, `relay`), and `watch` / autopause did not run against testnet (the rerun in
section (i) ran one `watch -- --once` baseline).

Commands run on that box after the code changes in this branch: `make test` (exit 0: Rust 194
passed, vitest 22 files / 450 tests passed, `tests/fdlimit/test.sh` 22 passed, 1 skipped),
`make lint` (exit 0, `copy_lint: OK`), `scripts/gitleaks_selftest.sh`, and gitleaks v8.30.1
`gitleaks git --config .gitleaks.toml` over the branch history plus `gitleaks dir --config
.gitleaks-dir.toml` over a `git archive` export of the commit (no leaks found).

## (i) NEAR testnet rerun on main, 31 Oct 2026

The `make demo-testnet OWNER_GO=yes` recipe, run again on 31 Oct 2026 with the owner's go, on
merged `main` (`5beee31`, pull request #5) and a fresh testnet owner account. Testnet only; no
mainnet key or account was involved.

| Item | Value |
|---|---|
| Owner | `claw-guard-f92b93.testnet` |
| Contract | `clawguard.claw-guard-f92b93.testnet` |
| Code | `main` at `5beee31` |
| Box | a fresh Debian 13 box on which `make`, cargo-near 0.22 and Node 22 were missing at the start |
| How | the recipe's commands run by hand, since `make` was missing (the README now lists them: [Try it on NEAR testnet](../README.md#try-it-on-near-testnet-optional-owner-go), step 4) |
| Contract build | plain cargo (`scripts/build_contracts.sh` fallback, no cargo-near) without `wasm-opt`; that wasm deployed and ran on NEAR testnet, protocol 88 |
| Result | exit 0, `Agent done: 7 allowed, 5 blocked` (the same decisions as section (h)) |

Checks after the run, all OK:

- `receipts`: all 12 receipts read back (12/12).
- `derive`: OK for `hl-testnet-1` and `base-sepolia-1`. The addresses differ from section (h)
  (they depend on the contract account) and were not recorded here.
- `verify-sig -- --receipt <n>`: `MATCH` for all 7 signed receipts. On a blocked receipt the code at
  `5beee31` printed `MISMATCH (receipt #6 has no derivation path; status Blocked)` and exited 1;
  that was the expected case (a blocked order is never signed), not a failure. The owner asked for
  a clearer answer, so `verify-sig` now prints `no signature (blocked)` with exit 0 for it,
  `no signature (signature request failed)` for `SignFailed`, `no signature yet (pending)` for
  `PendingSignature` (exit 0, never `MATCH`; `MISMATCH` with exit 1 if such a receipt still carries
  a signature, which the contract never stores), keeps `MATCH` / `MISMATCH` (exit 0 / 1) for `Signed`
  receipts, and prints `receipt #<id> not found on <contract>` (exit 1) for an unknown id
  (`verifySigReport` in [offchain/src/sig.ts](../offchain/src/sig.ts); tests in `sig.test.ts` and
  `verify_sig_cli.test.ts`). This change was checked on the local sandbox only (section (e)).
- `watch -- --once`: the first poll recorded its baseline.
- Owner-key guards of `gen-testnet-near-key --role owner`: running it again was refused,
  `--force` alone gave `ERR_OWNER_FORCE_REFUSED`, `NEAR_NETWORK=mainnet` gave
  `ERR_MAINNET_REFUSED`, and `offchain/.env` was unchanged after each of the three.

Follow-ups from this run (in this branch):

- `gen-testnet-near-key` left `NEAR_RPC_URL` empty in the new `offchain/.env`. It now writes
  `NEAR_RPC_URL=https://rpc.testnet.near.org` there when the file says `NEAR_NETWORK=testnet` and
  has no value of its own, and says so; a non-empty value in the file is never changed, and a value
  set in the shell (it wins over the file) leaves the file's line alone.
- The README now says how to reach about 20 testnet NEAR (a second faucet account deleted with the
  owner as beneficiary, as in section (h)), what to do without `make`, cargo-near or Node 22, and
  where to look transactions up when nearblocks lags.
- Transaction lookups: right after the run nearblocks' API returned empty transaction lists, while
  FastNEAR's testnet transaction API (`tx.test.fastnear.com`) answered. No transaction hashes were
  recorded for this rerun; the hashes in section (h) belong to the first run.

Not recorded for this rerun: times, transaction hashes, balances, the funding steps and tool
versions. Not covered: the same items as section (h) (no relay to Hyperliquid testnet or Base
Sepolia, no `watch` alert after a change, no autopause).
