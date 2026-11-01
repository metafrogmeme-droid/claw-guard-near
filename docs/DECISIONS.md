# Design decisions

Prototype. Testnet only. Not audited.
The server never holds mainnet keys or signs for users.

This page records the design decisions behind Claw Guard and the trade-offs that were looked at
and deliberately not taken. Code comments and the other docs cite these ids (`D-..` for owner
decisions, `Q-..` for reviewed design questions). Some questions were later turned into
decisions: Q-29 became D-14, Q-44 became D-18 and Q-56 became D-20. Ids written `Q-001`,
`Q-002`, `Q-007` and `Q-010` (three digits) are entries in the official hackathon FAQ
([nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md)), not this page.

## Decisions

| # | Date | Topic | Decision |
|---|---|---|---|
| D-01 | 30 Oct 2026 | Build order | All sandbox and offline work first. Testnet steps (deploy, MPC call, Hyperliquid spike, Base Sepolia broadcast) each wait for a separate owner go. |
| D-02 | 30 Oct 2026 | Rust toolchain | Rust **1.97** (near-sdk 5.30.0 needs 1.95 or newer). `rust-toolchain.toml` pins `1.97`. |
| D-03 | 30 Oct 2026 | Start date | The build started on Fri 30 Oct 2026. The hackathon FAQ (Q-001) counts code from the 19 Oct announcement; the baseline is the repository's initial GitHub commit, which held no project code (see [BASELINE.md](BASELINE.md)). |
| D-04 | 30 Oct 2026 | Hyperliquid size/price precision | `MarketRule` has a required `sz_decimals` (0 to 6). For a listed market, a size with more decimals than `sz_decimals`, or a non-integer price with more than `6 - sz_decimals` decimals, is blocked as `MALFORMED`. Changing `sz_decimals` counts as loosening (timelocked). |
| D-05 | 30 Oct 2026 | EVM address format | Accept `0x` or `0X`. All-lowercase or all-uppercase hex is accepted as is; mixed case must be a valid EIP-55 checksum (else `MALFORMED(to)` for orders, `ERR_INVALID_RULES` for rules). Addresses are stored, compared and shown in lowercase. |
| D-06 | 30 Oct 2026 | Node version | Node **22.22.2** or a newer 22.x (near-api-js 7.4.0 and near-sandbox 0.3.4 declare it). `offchain/package.json` engines, `.nvmrc`, CI and the README agree. |
| D-07 | 30 Oct 2026 | Autopause on owner keys | The owner account is watched. A new key on it raises an alert and, with `CLAW_WATCH_AUTOPAUSE=1`, pauses the guard. After adding their own keys, the owner unpauses (`unpause`, 1 yocto). |
| D-08 | 30 Oct 2026 | Guardian key | The guardian is pause-only by design. Autopause refuses to start unless the guardian key is a function-call key for the contract with exactly the method `pause`. A full-access guardian key is refused on purpose. |
| D-09 | 30 Oct 2026 | Builder-fee approvals on Telegram | A new builder-fee approval on the Hyperliquid testnet account is sent to Telegram as an alert only, worded `Needs your OK: …`. Reviewing and approving stays in the console. The Telegram module has no commands and never reads replies. |
| D-10 | 30 Oct 2026 | Guardian account keys | The guardian account's keys are watched too, with the same alerts and autopause as the owner, agent and contract accounts. |
| D-11 | 30 Oct 2026 | Unparseable `sz_decimals` | Any `sz_decimals` that is not an integer from 0 to 6 (for example 300, -1, 1.5, "5" or missing) is refused with `ERR_INVALID_RULES`, not a JSON parse error. Tests cover 300 and -1. |
| D-12 | 30 Oct 2026 | Demo injected receiver | The demo sends the injected `0xBAD…` receiver all lowercase (`0xbad0000000000000000000000000000000000bad`), so it is blocked by `RECEIVER_NOT_ALLOWED` (`receiver … is not on your list`). |
| D-13 | 30 Oct 2026 | Low open-files limit (sandbox) | The sandbox node (neard 2.14.0) exits unless it can raise its open-files limit to 65,535. Only when the host's hard limit is below that, `make demo` and `make test` build a small LD_PRELOAD shim from its C source (`scripts/fdlimit/`, compiled with `cc` at run time; no prebuilt binary is committed), load it into the sandbox node only, and print one line saying the shim is active. Sandbox only. |
| D-14 | 31 Oct 2026 | Testnet agent and guardian keys | `npm --prefix offchain run gen-testnet-near-key -- --role agent` (or `--role guardian`) creates a fresh ed25519 key pair, writes the secret only into `offchain/.env` (`AGENT_PRIVATE_KEY` / `GUARDIAN_PRIVATE_KEY`, mode 0600, never printed) and prints the public key. `setup:testnet` adds it as the agent's only key (function-call, `propose_order`) or the guardian's (function-call, `pause`). See D-17 for the owner key. |
| D-15 | 31 Oct 2026 | Atomic `.env` writes | `gen-testnet-near-key` and `gen-testnet-evm-key` write `offchain/.env` atomically: a temp file at mode 0600 in the same folder, then renamed over `.env`, so a crash or a full disk never leaves a truncated `.env`. The temp file is removed on any error. A symlinked `.env` is refused and never followed. |
| D-16 | 31 Oct 2026 | `gen-testnet-near-key` network | Runs only when `NEAR_NETWORK=testnet` is set explicitly (shell or `offchain/.env`); `sandbox`, unset or anything else is refused (mainnet stays `ERR_MAINNET_REFUSED`). A repeated `--role` is refused instead of taking the last value. |
| D-17 | 31 Oct 2026 | Testnet owner key | `gen-testnet-near-key -- --role owner` makes a fresh testnet owner key (secret only in `offchain/.env` as `OWNER_PRIVATE_KEY`, atomic write, mode 0600, never printed) and prints the public key with the next step. Same guards as D-14 to D-16. `--force` alone is refused with `ERR_OWNER_FORCE_REFUSED` (the owner key can be the only full-access key of the owner and contract accounts, so replacing it could lock the owner out); replacing it needs `--force --replace-owner-key`. Testnet only. |
| D-18 | 1 Nov 2026 | Storage griefing (was Q-44) | Every agent-supplied bound counts UTF-8 bytes, not characters: memo and pause reason at most 140 bytes (`MALFORMED(memo)`, `ERR_REASON_TOO_LONG`); strings kept in a blocked receipt are cut to 48 bytes (memo 140) at a character boundary. A worst-case blocked receipt is pinned at most 700 bytes of Borsh (702 bytes of storage measured), so a full ring of 1000 is about 7 NEAR. A blocked receipt is stored only while `balance >= (storage_usage + 4096 bytes) × byte cost`, the same reserve allowed orders keep; below it the order is still blocked with the same decision and `order_blocked` event, but `receipt_id` is `"0"` and nothing is stored or signed. `pause` adds at most 144 bytes, so the guardian can always pause. Not chosen: a per-agent daily cap on blocked receipts, or not storing while paused (both hide attempts from `get_receipts`). |
| D-20 | 1 Nov 2026 | Storage reserve alert (was Q-56) | The `watch` CLI also reads the contract account (`view_account`) and compares its balance with the contract's own floor `(storage_usage + 4096 bytes) × 10^19 yocto`. Levels: ok, close (room for fewer than 100 worst-case blocked receipts) and reached. One alert per level change, also on the first poll when not ok. Close and reached go to Telegram; reached can trigger the opt-in autopause (`watch: storage reserve reached`). No contract change; reading `order_blocked` events from the chain was not chosen (needs an indexer). |
| D-21 | 1 Nov 2026 | Mainnet protocol 86 (link error) | Mainnet attempt 1 failed with `Link Error: unknown or invalid import`: mainnet ran protocol 86 and near-sdk 5.30.0 (near-sdk-env 0.1.8, near-sys 0.4.0) imports `promise_batch_action_universal_state_init`, a host function protocol 88 adds. Pinned near-sdk **5.29.1** with near-sdk-env **0.1.6** (near-sys 0.2.14), the newest release whose wasm imports only protocol-86 host functions, and near-workspaces **0.23.0** (the tests pin the sandbox node 2.14.0 with `sandbox_with_version`). CI refuses any contract wasm that imports a function outside `scripts/near-host-fns-protocol-86.txt` (`scripts/check_wasm_imports.py`, rust and reproducible jobs) and uploads the reproducible wasm as an artifact; the mainnet deploy used that exact file. Not chosen: waiting for mainnet to adopt protocol 88 (no date). Revisit when mainnet runs 88. |

(D-19 was an internal process decision about file labels and has no effect on the code.)

## Contract design questions

| # | Question | Choice |
|---|---|---|
| Q-01 | Block leverage updates once the daily cap is reached? A leverage update has zero spend, so `DAILY_CAP` (`spent + spend > cap`) still passes it. | Keep: it moves no funds; `max_leverage` and the daily order count still bound it. |
| Q-02 | Should `set_guardian` and `cancel_pending_rules` emit events? | Not yet; add `guardian_set` and `rules_pending_cancelled` after the hackathon so Claw Watch can alert on them. |
| Q-03 | Blocked receipts store agent strings cut to 48 bytes (memo 140, D-18). | Keep. Allowed receipts are stored in full (already bounded by the format checks). |
| Q-04 | Is `max_receipts = 1000` right for a contract funded with 5 NEAR? 1000 allowed receipts need about 7 to 10 NEAR of storage. | Keep 1000. `INSUFFICIENT_CONTRACT_BALANCE` protects allowed orders, blocked orders below the reserve are not stored (D-18), and Claw Watch alerts (D-20). |
| Q-05 | Market and token names must be 1 to 16 ASCII letters or digits (`MALFORMED(market)` / `MALFORMED(token)`). | Keep: stops agent text from being injected into decision messages. |
| Q-06 | Extra rules validation: unique market indices, token addresses and receivers, symbols A-Z0-9 (16 max), at most 64 entries per list, at most 2 targets. | Keep (`ERR_INVALID_RULES`). |
| Q-07 | `#[init] new` is `#[private]` (deploy + init in one batch). | Keep: blocks front-running of init. |
| Q-08 | `unpause` is idempotent and always emits `unpaused`. | Keep. |
| Q-09 | EVM gas bounds (`21_000 <= gas_limit <= 200_000`, `max_fee_per_gas <= 100 gwei`, priority fee <= max fee) are fixed constants. | Keep for now: they stop a hijacked agent from burning the derived address's gas money; owner-set bounds later if a venue needs them. |
| Q-10 | Token rules require `decimals == 6`, because the daily cap is one counter shared with Hyperliquid notional (1e-6 quote units). | Keep. |
| Q-11 | `HlUpdateLeverage` counts toward `orders_today`. | Keep. |
| Q-12 | A failed signature request reads `Not signed: the signature request failed` (`allowed: false`, no rule code); the reservation is released (same UTC day), the nonce stays consumed. | Keep. |
| Q-14 | Lock the contract account's full-access key after deploy? Holding it lets that key call the MPC `sign` directly as the contract. | Mainnet: `scripts/deploy-mainnet.sh` deletes every full-access key of the contract after the demo checks ([MAINNET.md](MAINNET.md)). Testnet: kept for redeploys; `LOCK_ONLY=yes CLAWGUARD_NETWORK=testnet` locks it on request. |
| Q-15 | Other numeric rule fields (`decimals` 300, `asset` -1, …) still fail with near-sdk's JSON parse panic, not `ERR_INVALID_RULES`. | Keep (fails closed, nothing stored); typed errors later. |
| Q-16 | Demo numbers: per-order cap 500, daily cap 1200 (1e-6 quote units), BTC limit 50000 as "far below market"; receiver `0x1111…1111` is a placeholder. | Keep; put your own testnet receiver in `demo/rules.json` for `demo-testnet`. |
| Q-42 | Sells: notional caps count at the limit price, which bounds buys but not sells that cross the book. | Accept and document ([THREAT_MODEL.md](THREAT_MODEL.md)); `max_order_sz`, `max_orders_per_day` and `reduce_only_required` still apply. A reduce-only-sells rule is the planned follow-up. |
| Q-43 | The loosening delay covers `set_rules` only; `register_agent` / `remove_agent` apply at once (owner key, 1 yocto). | Keep: the owner key is trusted ([THREAT_MODEL.md](THREAT_MODEL.md)); Claw Watch alerts on agent changes. |
| Q-45 | Signatures already issued are not revoked by `pause` or tightening (a signed Hyperliquid order has no `expiresAfter`). | Documented; add a short `expiresAfter` once Hyperliquid testnet accepts it. |
| Q-46 | A failed signature request consumes the agent's EVM nonce, so later Base Sepolia transfers cannot be mined until the agent is re-registered. | Keep; re-registering the agent is the reset. Nonces above 2^53 − 1 are blocked as `MALFORMED(nonce)`. |
| Q-47 | A proposal that does not fit the typed JSON fails at argument parsing before any rule runs: nothing is signed, but no receipt is stored. | Keep fail-closed without a receipt. |

## Off-chain tool questions

| # | Question | Choice |
|---|---|---|
| Q-20 | `approve-hl-agent` is a dry run unless `--yes`. | Keep `--yes`; also requires `NEAR_NETWORK=testnet`. |
| Q-21 | `relay` refuses `NEAR_NETWORK=sandbox`, so mock-mpc signatures never reach a venue. | Keep refused. |
| Q-22 | The decoder shows EVM amounts as raw token units. | Keep raw units. |
| Q-23 | Watch state lives in `offchain/.sandbox/watch-<network>.json` (git-ignored). | Keep. |
| Q-24 | Optional LLM agent mode through `@anthropic-ai/sdk` 0.135.0 (model `claude-opus-5-5`). | Keep, off by default (`AGENT_MODE=scripted`); covered by mocked tests only. |
| Q-25 | `setup:testnet` funding: contract 5 NEAR, agent 0.5, guardian 0.5, function-call allowance 1 NEAR; the contract gets the owner's public key (no new secret). | As listed. |
| Q-26 | After the demo unpauses, the simulated attacker key stays on `agent-1`. | Keep for the demo; a real owner removes or replaces the agent first. |
| Q-27 | The demo prints test values (`at limit 50000`, `send 5 USDC`). | Keep: testnet test values only. |
| Q-32 | `npm audit`: findings come in through the local sandbox package (`near-sandbox` → `tar`) and dev tools. | Accept and record ([VERIFY.md](VERIFY.md)): never part of the contract or a testnet path. |
| Q-40 | A builder-fee approval removed and re-approved in one `watch` session does not send a second "Needs your OK". | Keep (console line and autopause still fire). |
| Q-48 | The decoder names markets and tokens from the agent's current `get_rules`, never from the agent's own text. | Keep. |
| Q-49 | `relay` on Base Sepolia refuses a nonce that is not the signer's next one; the `approve-hl-agent` dry run signs nothing. | Keep. |
| Q-52 | `verify-sig` exits 0 for receipts that have no signature by design (blocked, failed, pending). | Keep. |
| Q-53 | `gen-testnet-near-key` fills `NEAR_RPC_URL` only when the file it writes says `NEAR_NETWORK=testnet`. | Keep: a sandbox config never points at testnet. |
| Q-54 | FastNEAR as an explorer fallback is docs only. | Keep docs only. |

## Build and release questions

| # | Question | Choice |
|---|---|---|
| Q-30 | Reproducible build image. | `sourcescan/cargo-near:0.22.0-rust-1.97.1`, digest `sha256:7467038bdddc86484b73b416eeadce926ff59013e128e53dec5a19e1cb4b2234`, plus a `mainnet` variant (`--features mainnet`). The CI job `reproducible` builds both and prints their sha256. |
| Q-33 | CI runs on push and pull_request without branch filters (PRs run twice). | Keep until submission, then limit `push` to `main`. |
| Q-34 | The docker job builds the image from scratch every run. | Keep until submission, then `main` and PRs only. |
| Q-35 | Extra docker run with `--ulimit nofile=20000:20000` checks the D-13 shim line appears once. | Keep: the only CI coverage of the fallback at run time. |
| Q-36 | CI gitleaks scans commits reachable from the tested commit, not `--all`. | Keep; a full `--all` scan is run by hand before a release. |
| Q-37 | Action versions are pinned to commit SHAs. | Checked against their tags on 1 Nov 2026 (checkout v7.0.1, cache v6.1.0, setup-go v7.0.0, setup-node v7.1.0). |
| Q-38 | Sandbox node 2.14.0; its sha256 is checked only on the fd-limit fallback path. | Keep 2.14.0. |
| Q-39 | The fd-limit shim tries the original request first and lowers to the hard limit only on EPERM. | Keep. |

## Still to verify on testnet

Recorded in [VERIFY.md](VERIFY.md) once checked:

- Whether `propose_order` with the MPC yield finishes within the RPC wait (`EXECUTED_OPTIMISTIC`), or the agent must poll `get_receipt`.
- Hyperliquid testnet `szDecimals` for BTC and ETH (demo uses 5 and 4) and asset indices from `/info` `meta`.
- Hyperliquid `/info` `approvedBuilders` response shape (the parser accepts a list of addresses or objects).
- The Base Sepolia Circle USDC address `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
