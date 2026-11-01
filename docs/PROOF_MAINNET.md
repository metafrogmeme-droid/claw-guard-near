# Claw Guard on NEAR mainnet: run log

Status (1 Nov 2026, 17:06 CET): **deployed and locked.** Contract
[`clawguard-demo.near`](https://nearblocks.io/address/clawguard-demo.near) runs the CI
reproducible mainnet wasm of `main` bdf1df8 and has no full-access key, so its code can no longer
change. Attempt 1 (15:24 CET go) was refused at link time and rolled back; attempt 2 ran after the
protocol-86 fix ([D-21](DECISIONS.md)), on the same accounts with no new funding.

Commit ids (`bdf1df8`, `7c4fd11`) and CI runs refer to the private development repository; this
public repository is one snapshot of its `main`.

## Accounts

| Role | Account |
|---|---|
| Demo owner | [`c1dca35d…e90dff`](https://nearblocks.io/address/c1dca35dc47cf14ca6a9d55c341a462e3f40bc9147e65f5ca51fcbf1b2e90dff) |
| Contract | [`clawguard-demo.near`](https://nearblocks.io/address/clawguard-demo.near) |
| Demo agent | [`clawguard-demo-agent.near`](https://nearblocks.io/address/clawguard-demo-agent.near) |

## Attempt 2 (1 Nov 2026, 17:05 CET): deployed

Pre-checks:

- CI on the fix: all 8 jobs green. CI on `main` bdf1df8: reproducible job green, artifact `claw-guard-wasm-bdf1df8fcabf8bda3295928ebf4c796c25ddfb58`.
- The same artifact passed `SANDBOX_PROTOCOL=86 scripts/rehearse-mainnet-sandbox.sh`.
- Plan-only run: contract funded (4.9978 NEAR, needs 4.3978), MPC `v1.signer`, owner key on the
  box, 1 full-access key on the contract, no code on chain.

| Step | Tx | Result |
|---|---|---|
| Deploy + `new` (one batch) | [G1aeoHz8…LpNLVmN86](https://nearblocks.io/txns/G1aeoHz8sYZuYJJfxrTSUuqRLg65cJ9ARjrLpNLVmN86) | success |
| `register_agent clawguard-demo-agent.near` (demo rules, 7 days), signed by the owner | [5WZ9beux…2MmLkCk5](https://nearblocks.io/txns/5WZ9beuxkF4tZaKA8ifBKeDnENb4Vo34i1Pm2MmLkCk5) | success |
| Key lock: delete the contract's full-access key | [JDYJKpFY…XS53ztS4W](https://nearblocks.io/txns/JDYJKpFYeMteitbMG6ymD3zmXwpWSsoRZEiXS53ztS4W) | success, 0 access keys left |

Demo checks (`preview_payload` view calls on mainnet, no transaction), verbatim:

| Order | Verdict |
|---|---|
| BTC 0.001 | `Allowed: within your limits` |
| BTC 0.02 | `Blocked by your rule: order is above your per-order cap` |

`get_status`: owner `c1dca35d…e90dff`, mpc `v1.signer`, not paused. `contract_source_metadata`:
version 0.1.0, link `https://github.com/metafrogmeme-droid/claw-guard-near/tree/bdf1df8fcabf8bda3295928ebf4c796c25ddfb58`.
No `propose_order` was sent (no live MPC signature requested).

### Wasm and code hash

| | Value |
|---|---|
| CI artifact `claw_guard.mainnet.wasm` (reproducible job, cargo-near 0.22.0, near-sdk 5.29.1) | 287,284 bytes |
| sha256 (artifact SHA256SUMS, CI job log and box all agree) | `695e33290ee6ebe9e9e39da638dff2d89a78a42a30da395b46c5ffb4ecb0226a` |
| Code hash on chain (`view_account`) | `86K7uc2ky52RrJzxH3QhpfkZrgXHJQCoTY1UVHZzPVRB` |
| base58 of the artifact sha256 | `86K7uc2ky52RrJzxH3QhpfkZrgXHJQCoTY1UVHZzPVRB` (match) |

Host imports: 42, all on protocol 86 (`scripts/check_wasm_imports.py`).

## Attempt 1 (1 Nov 2026, 16:00 CET): refused at link time

Pre-checks: CI on `main` 7c4fd11, all 8 jobs green; plan-only run: contract funded (5.0000 NEAR, needs 4.4170).

| Step | Tx | Result |
|---|---|---|
| Create + fund `clawguard-demo.near` (5 NEAR) | [F5V78KiB…vjCkEa](https://nearblocks.io/txns/F5V78KiBznCRb6diT4Tj5cpV5tAgusGcFj21etvjCkEa) | success |
| Create + fund `clawguard-demo-agent.near` (0.1 NEAR) | [8YdLPV5D…oVGh1V](https://nearblocks.io/txns/8YdLPV5Da4vh9nsiDS1zb1Ph3qj2Hz6D4WzLNhoVGh1V) | success |
| Deploy + `new` (one batch) | [Eeg1Vnht…Uwm58](https://nearblocks.io/txns/Eeg1VnhtUiiheXiarzcctzKQx46zxAGAymmeKxTUwm58) | **failed**: `FunctionCallError: Link Error: unknown or invalid import` (action 1, `new`); deploy rolled back, ~0.0022 NEAR gas |

Not run then: demo checks and the key lock. Wasm: `cargo near build non-reproducible-wasm --locked
--features mainnet` (near-sdk 5.30.0), 289,204 bytes, sha256
`d89a444cfab7ee167eccf7e30a36ca863e1f302c6851bbfe491edfd807ae6931`.

Cause: mainnet ran protocol 86 (nodes 2.14.0, latest supported 88); testnet and the first sandbox
rehearsal ran 88. near-sdk 5.30.0 (near-sys 0.4.0) imports
`promise_batch_action_universal_state_init`, which nearcore enables only at protocol 88. Fix
(owner's go 16:05 CET, D-21): near-sdk 5.29.1 (near-sys 0.2.14), a CI check of every wasm import
against the protocol-86 list, and a sandbox rehearsal at protocol 86, where the 5.30.0 wasm fails
with the same link error.

## Balances (final finality, 1 Nov 2026)

| Account | Before attempt 1 | After attempt 1 | After attempt 2 |
|---|---|---|---|
| Demo owner | n/a | 0.8711 | 0.8709 |
| `clawguard-demo.near` | 5.0000 | 4.9978 (no code) | 4.9955 (code, no access keys) |
| `clawguard-demo-agent.near` | 0.1000 | 0.1000 | 0.1000 (key on the owner's machine) |
