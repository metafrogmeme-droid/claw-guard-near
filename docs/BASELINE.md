# Baseline vs built in the hackathon window

Prototype. Testnet only. Not audited.
The server never holds mainnet keys or signs for users.

## Dates and tags

- The build started on **Fri 30 Oct 2026** (owner decision D-03). The official hackathon brief
  ([nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md), read on 30 Oct 2026)
  says code from the 19 Oct announcement counts (FAQ Q-001: "Earlier commits are baseline") and
  that only the NEAR integration built in the window is judged (FAQ Q-002).
- **Baseline:** the repository's initial commit `223f5bf` (Fri 30 Oct 2026), created by GitHub
  with three files: `.gitignore`, `LICENSE` (MIT) and a one-line `README.md`. No project code.
  That commit lives in the private development repository; this public repository starts from
  one snapshot commit of the finished `main`, so it has no `pre-hackathon` tag.
- **Built in the window:** everything after `223f5bf`. At commit `ebd82f1` (31 Oct 2026, before
  these docs) `git diff --shortstat 223f5bf` counted 118 files and 37,617 added lines: the
  `claw-guard` contract, `mock-mpc`, the near-workspaces sandbox
  tests, the TypeScript agent / relayer / Claw Watch / Telegram / CLIs, the demo, the build, lint
  and fd-limit scripts, and these docs. All NEAR-specific code is in this part.
- Tag **`hackathon-submission`**: the submitted state, on the public snapshot commit.
- **Diff:** since the baseline held no project code, every file in this repository was built in
  the window.

## Ideas reused from our own earlier prototypes (ideas only, no code)

These ideas come from our own throwaway local prototypes (25 Oct 2026, local/testnet only).
Nothing was copied: each idea was reimplemented from a written description, in a different
language and shape. No code from any earlier repository was used or fetched.

| Prototype file (idea source) | Idea | Reimplemented as |
|---|---|---|
| `l2_firewall/src/DrainPolicy.sol` (Solidity policy engine) | Per-token caps (per payment, per day), allowlisted recipients, sessions with expiry, owner/guardian split, **tightening is instant, loosening waits** (propose → wait → confirm), guardian can freeze and cancel but not loosen | [rules.rs](../contracts/claw-guard/src/rules.rs) (rule model, `first_loosening`), [admin.rs](../contracts/claw-guard/src/admin.rs) (owner-only + 1 yocto, `set_rules` / `confirm_rules` / `cancel_pending_rules`, guardian `pause`) |
| `l2_firewall/test/AgentFence.t.sol` (13 tests incl. a fuzz test) | The test list: within cap accepted, over cap refused, unknown payee refused, expired authorisation refused, daily budget enforced, stranger refused, frozen refuses all, "no value to any non-allowlisted address ever passes" | [rules/tests.rs](../contracts/claw-guard/src/rules/tests.rs) boundary tests per rule code and the property tests `property_violating_orders_never_reach_the_mpc` / `property_valid_orders_always_reach_the_mpc` in [tests.rs](../contracts/claw-guard/src/tests.rs) |
| `l1_sigdecoder/sigdecoder/hl.py`, `util.py` (Python decoder) | Turn a Hyperliquid action into a plain-English line of what is being signed; a minimal EIP-712 encoder as a reference | [offchain/src/decode.ts](../offchain/src/decode.ts) (the "what #1 signed" line), [eip712.rs](../contracts/claw-guard/src/eip712.rs) / [offchain/src/hl.ts](../offchain/src/hl.ts) (checked against hyperliquid-python-sdk 0.24.0 vectors, not against the prototype) |
| `l4_hl_watch/hlwatch.py` (Hyperliquid watcher) | Poll `/info` for API wallets and builder approvals, keep a snapshot with a sha256, diff it, first poll is the baseline, alert wording without verdict words | [offchain/src/watch/hl.ts](../offchain/src/watch/hl.ts), [snapshot.ts](../offchain/src/watch/snapshot.ts), [alerts.ts](../offchain/src/watch/alerts.ts) (testnet URL only; `extraAgents` and `approvedBuilders` only) |

Not reused: the prototypes' incident pack, classifier and Solana/Seaport/Permit2 decoders.

## What is new in the window (the NEAR part)

- A NEAR policy contract that checks every order and is the only account that can obtain MPC
  chain signatures for its derived addresses; it builds the payload itself (Hyperliquid EIP-712
  digest, Base Sepolia EIP-1559 transaction).
- The agent's NEAR function-call key (one method, no deposits) as the only key the agent holds,
  proven against a real sandbox node.
- On-chain receipts and NEP-297 events for every decision.
- Claw Watch on NEAR access keys (`view_access_key_list`) with a pause-only guardian key.

## The official track briefs

Quoted from the official hackathon brief
([nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md)) as read on 30 Oct 2026.
Track choice: `security` primary, then `agents`, `defi`.

- `security` (AI Security & Defense):
  > "Build spending limits, policy engines, sandboxed wallets, reputation and scam detection. Give AI money without giving it the keys to everything."

  Hints: AGENT SECURITY, FUNCTION CALL KEYS, TEE ATTESTATION. Claw Guard is a per-order policy
  engine with spending limits, where the agent holds a function-call key instead of the signing
  key. TEE attestation is not used (stretch only, not built).
- `agents` (Agent Economy):
  > "Build agents that earn, spend, negotiate, hire other agents and pay for APIs, compute or data…"

  Hints: AGENT COMMERCE, NEAR INTENTS, CHAIN SIGNATURES. Claw Guard uses chain signatures; it
  does not use NEAR Intents (no testnet, hackathon FAQ Q-007).
- `defi` (Unstoppable DeFi):
  > "Build exchanges, perps, lending, vaults and trading agents that settle across chains through NEAR Intents."

  Hints: TRADING, NEAR INTENTS, CHAIN SIGNATURES. Claw Guard gates a trading agent's perps orders
  (Hyperliquid testnet) and ERC-20 transfers (Base Sepolia); it does not use NEAR Intents.

The `security` quote is the only place in this repository's docs where the brief's own wording
for detection appears; our own copy never uses verdict words about addresses, orders or projects.
