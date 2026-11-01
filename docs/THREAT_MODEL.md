# Claw Guard threat model

Prototype. Testnet only. Not audited.
The server never holds mainnet keys or signs for users.

Each point names the mechanism and the tests that check it. Test
names are Rust test functions (contract unit tests in
[contracts/claw-guard/src/tests.rs](../contracts/claw-guard/src/tests.rs) and
[contracts/claw-guard/src/rules/tests.rs](../contracts/claw-guard/src/rules/tests.rs), sandbox
tests in [tests/](../tests)) or vitest cases in [offchain/test/](../offchain/test). All of them
run in `make test`. "Sandbox" means a real local NEAR node (neard 2.14.0) with the real contract
wasm; nothing here has been run on NEAR testnet yet ([VERIFY.md](VERIFY.md)).

## Actors and trust

| Actor | Trusted? | Holds |
|---|---|---|
| Owner | Yes | Full-access key of the owner account; on the Hyperliquid path, the testnet-only master EVM key. |
| Agent (scripted or LLM) | **No**: assume it is hijacked (prompt injection, poisoned tools, compromised front end) | One function-call key: receiver = claw-guard, methods = `["propose_order"]`, allowance 1 NEAR. |
| claw-guard contract | Trusted code (not audited) | No private keys; MPC derives its signing keys from its account id. |
| NEAR MPC network | Trusted to sign only what the caller asks | Threshold key (testnet `v1.signer-prod.testnet`). |
| Guardian | Partly: can only stop things | Function-call key, method `pause` only. |
| Relayer, Claw Watch, Telegram module | Not trusted with anything | No keys (Claw Watch may use the guardian key for autopause). |

## What it stops

### A hijacked agent placing orders outside the owner's rules

Mechanism: `propose_order` is the only method the agent key can call. The contract evaluates
every proposal that parses with the pure function `rules::evaluate` in a fixed order, first
failure wins, and stores a `Blocked` receipt with the exact message (no panic, so the receipt
persists). Only a proposal that passes every rule reaches the MPC. A proposal that does not fit
the typed JSON interface fails before any rule runs, with nothing signed and no receipt (Q-47 in
"What it does not stop").

| Attempt | Rule code | Tests |
|---|---|---|
| Market not on the list (e.g. DOGE) | `MARKET_NOT_ALLOWED` | `market_and_token_allowlists`, `every_rule_code_through_the_contract`, sandbox `prompt_injection_scenario_blocks_every_injected_order` (step 2), `make demo` #2 |
| Token not on the list | `TOKEN_NOT_ALLOWED` | `market_and_token_allowlists`, `every_rule_code_through_the_contract` |
| Receiver not on the list (e.g. `0xbad…0bad`) | `RECEIVER_NOT_ALLOWED` | `receiver_allowlist_compares_lowercased`, `receiver_accepts_checksum_upper_and_0x_upper_prefix`, `checksummed_receiver_in_rules_matches_a_lowercase_to`, sandbox injection step 5, `make demo` #5 |
| Size or notional above the per-order cap (notional at the limit price, which for a sell is only a lower bound: Q-42) | `ORDER_ABOVE_CAP` | `per_order_size_cap_boundary`, `per_order_notional_cap_boundary`, `per_transfer_token_cap_boundary`, sandbox injection step 3, `make demo` #3 |
| Leverage above the limit | `LEVERAGE_ABOVE_LIMIT` | `leverage_boundary`, sandbox injection step 4, `make demo` #4 |
| Too many orders today | `DAILY_ORDER_COUNT` | `daily_order_count_boundary` |
| Over the daily cap (Hyperliquid notional at the limit price, so not a bound for sells: Q-42) | `DAILY_CAP` | `daily_cap_boundary`, `daily_cap_overflow_blocks`, `counters_roll_over_at_utc_midnight`, `daily_counters_roll_over_at_utc_midnight`, sandbox injection step 6, `make demo` #8 |
| After the permission expired | `EXPIRED` | `expiry_boundary` |
| Target venue not enabled | `TARGET_NOT_ENABLED` | `target_not_enabled`, `target_and_order_kind_must_match` |
| Non-reduce-only order when reduce-only is required | `REDUCE_ONLY_REQUIRED` | `reduce_only_required` |
| While paused (new proposals; signatures issued before the pause stay valid: Q-45) | `PAUSED` | `paused_blocks_everything`, `paused_beats_daily_cap`, sandbox `guardian_pause_blocks_every_order_until_the_owner_unpauses`, `make demo` #9 |
| Replaying or back-dating an order | `STALE_NONCE` | `hl_nonce_window_is_five_minutes_each_way`, `nonces_strictly_increase_per_agent`, `nonces_are_monotonic_and_windowed_through_the_contract` |
| Odd formats meant to confuse parsing in the string fields (`1e3`, `-1`, `.5`, `01`, 9 decimals, too many decimals for the market, mixed-case non-checksum address). A value that does not fit a typed field (`-1` as `leverage` or `amount`) fails at argument parsing instead, with no receipt: Q-47 | `MALFORMED` | `malformed_names_the_field`, `sz_decimals_bound_the_size`, `sz_decimals_bound_the_price_decimals`, `too_fine_orders_are_malformed_through_the_contract`, the `order.rs` format tests |

Every rule code has a blocked case and a boundary case (exactly at the cap passes, one unit more
is blocked); the order itself is tested by `first_failure_wins_in_evaluation_order` and
`paused_beats_daily_cap_through_the_contract`.

### A blocked order ever reaching the signer

- Property tests: `property_violating_orders_never_reach_the_mpc` (1000 random proposals with at
  least one violated rule never create a promise) and `property_valid_orders_always_reach_the_mpc`
  (1000 valid ones always do).
- `blocked_order_stores_receipt_and_event_and_never_calls_mpc`; sandbox
  `blocked_orders_store_receipts_and_never_call_the_mpc` (the mock's `sign_count` does not move).
- The sandbox injection scenario and `make demo` check `sign_count` after every step: +1 for each
  allowed order, +0 for each blocked one.

### Signing something other than what was checked

Mechanism: the contract builds the payload itself. The Hyperliquid asset index and the token
contract address come from the owner's rules, never from the agent; the agent's fields are
parsed to canonical form first. The contract computes the hash and sends only that hash to the
MPC.

- `payload_uses_owner_asset_and_token_address`, `agent_cannot_supply_asset_index_or_token_address`,
  `every_order_field_changes_the_payload_hash`.
- `allowed_hl_orders_sign_the_vector_digests`, `allowed_leverage_updates_sign_the_vector_digests`,
  `allowed_transfers_sign_the_vector_hashes`: the contract's digests equal hyperliquid-python-sdk
  0.24.0 and viem 2.57.7 vectors.
- Off-chain, `verify-sig` recomputes the hash from the stored `signed_body` and recovers the signer
  (`sig.test.ts`: "a tampered hash → MISMATCH"); the relayer refuses a tampered body, a wrong `v`,
  the wrong chain or a signer that is not the derived address (`relayer.test.ts`: "refuses to send
  when the signature is not from the expected signer").

### The agent's key doing anything else

Mechanism: NEAR function-call access keys can only call the named methods on the named receiver
and cannot attach deposits; owner methods additionally require exactly 1 yoctoNEAR.

| Attempt with the agent key | Refused by | Test |
|---|---|---|
| Transfer NEAR (to anyone, including the guard) | protocol: `RequiresFullAccess` | sandbox `agent_key_cannot_move_funds_deploy_or_manage_keys`; `make demo` "agent key sends 0.1 NEAR … rejected" |
| Add or delete keys, deploy code, delete or create accounts | protocol: `RequiresFullAccess` | same test; `make demo` "adds a full-access key … rejected" |
| `propose_order` with any deposit attached | protocol: `DepositWithFunctionCall` | same test |
| `set_rules`, `unpause`, `register_agent`, `pause`, `remove_agent`, `confirm_rules`, `cancel_pending_rules`, `set_guardian`, `set_sign_config`, `on_signed`, `new` | protocol: `MethodNameMismatch` | sandbox `agent_key_cannot_call_admin_methods`; `make demo` "calls set_rules … rejected" |
| Call the MPC `sign` directly | protocol: `ReceiverMismatch`; and even with a full-access key the MPC derives a different key from the agent's account id, so the result never recovers to the guard's address | sandbox `agent_cannot_get_a_guard_signature_by_calling_the_mpc` |
| Owner methods from any non-owner, or without exactly 1 yocto | contract: `ERR_NOT_OWNER`, one-yocto panic | `owner_methods_need_the_owner_and_exactly_one_yocto` |

After each refused attempt the sandbox test checks that the agent's balance, keys and the
receipts are unchanged.

### Other accounts and roles

- Unregistered or removed agents: `ERR_NOT_AGENT`, no receipt, no log, no MPC call
  (`unregistered_caller_is_refused_and_nothing_is_stored`, sandbox
  `unregistered_accounts_get_err_not_agent_and_no_receipt`).
- Guardian: can pause and cancel a pending loosening; cannot unpause or loosen
  (`guardian_can_pause_and_cancel_but_not_unpause`, sandbox
  `guardian_key_can_pause_but_not_unpause`). Autopause refuses a guardian key that is not a
  function-call key for the contract with exactly `pause` (`watch_index.test.ts`: "refuses a
  full-access key, extra methods, another receiver, or an unknown key").
- Loosening through `set_rules`: a `set_rules` call that loosens any field waits
  `loosen_delay_sec` and needs `confirm_rules`; the guardian can cancel it meanwhile
  (`tighten_applies_now_and_loosen_waits`, `tighten_and_loosen_every_field`,
  `any_sz_decimals_change_is_a_loosening`, `changing_sz_decimals_waits_for_the_delay`). The delay
  and the guardian's cancel window cover `set_rules` only. `register_agent` of any account id, or
  `remove_agent` followed by `register_agent`, applies new rules at once (owner-only, 1 yoctoNEAR),
  so whoever holds the owner key, even briefly, gets no delay and the guardian gets no window; see
  "does not stop" (Q-43).

### Running against mainnet by mistake

- Contract: `new` panics `ERR_MAINNET_REFUSED` unless the contract and MPC ids both end in
  `.testnet` or both in `.test.near` (`init_refuses_anything_but_testnet_or_sandbox`). The
  Hyperliquid source `"b"` and the EVM chain id 84532 are compile-time constants; no code path
  produces a mainnet payload.
- mock-mpc: `new` refuses any id that does not end in `.test.near` (mock-mpc unit tests).
- Off-chain: every CLI refuses on `NEAR_NETWORK` other than sandbox/testnet, mainnet-looking URLs,
  a Hyperliquid URL other than the testnet one, the `v1.signer` MPC id, non-testnet account ids, a
  NEAR RPC whose chain id is not the expected one, and (Base path) `eth_chainId` other than
  `0x14a34` (`config.test.ts`: "ERR_MAINNET_REFUSED guards", "Base path eth_chainId"; the relayer
  "refuses the mainnet API without calling fetch").

### Fail closed

- A signature request that fails, times out, returns more than 1024 bytes or an unusable signature
  → `SignFailed`, no signature, reservation released (`failed_signature_releases_the_reservation`,
  `oversized_mpc_response_is_a_failure`, sandbox
  `mpc_failure_records_sign_failed_and_keeps_the_counters`). The nonce stays consumed; on Base
  Sepolia that stalls later transfers (Q-46 in "What it does not stop").
- Not enough gas for the sign and callback → `ERR_NOT_ENOUGH_GAS` before anything is written
  (`not_enough_gas_fails_closed_before_anything_is_written`).
- Contract balance too low for the MPC deposit plus storage → `INSUFFICIENT_CONTRACT_BALANCE`, no
  promise (sandbox `huge_sign_deposit_blocks_with_insufficient_contract_balance`,
  `contract_balance_rule_is_exact_at_the_storage_floor`).
- Invalid owner rules (bad `sz_decimals`, bad addresses, duplicates, too many entries) →
  `ERR_INVALID_RULES`, nothing stored (`validation_accepts_the_fixture_and_rejects_bad_rules`,
  `every_unreadable_sz_decimals_is_an_invalid_rules_error`, sandbox
  `owner_rules_with_bad_sz_decimals_are_refused_over_the_json_wire`).
- LLM mode: every tool input is validated before anything is proposed; invalid input proposes
  nothing (`agent_llm.test.ts`: "validates inputs fail closed", "answers invalid input and unknown
  tools with is_error and proposes nothing").

### Text injection into what the owner reads

- Agent-supplied market and token names must be 1 to 16 ASCII letters or digits, otherwise
  `MALFORMED`, so decision messages cannot carry agent prose (Q-05).
- Claw Watch strips control, bidi and newline characters from chain text and caps its length
  (`watch_alerts.test.ts`: "values from chain cannot add lines, reorder text or grow without
  bound"). Telegram messages are plain text (no Markdown parsing).
- A blocked receipt still stores the agent's raw strings (cut to 48 bytes, never inside a
  character, Q-03). The
  `receipts` table, the agent's decision lines and the LLM mode's `llm proposes:` line show
  control, bidi and newline characters as visible `\uXXXX` escapes, so a stored value cannot
  move the cursor, clear the screen or fake a row (`receipts_view.test.ts`: "prints control
  characters from receipts as visible escapes, one row per receipt"; `decode.test.ts`,
  `agent_llm.test.ts`). `--json` output is escaped by JSON itself.
- The "what is being signed" lines are decoded strictly from the signed body: any key or value
  the contract does not build (a builder fee, another grouping, a trigger, native value, an access
  list) gives "could not be decoded", and the market or token name comes from the owner's rules
  for the signed asset index or token address, not from the agent (`decode.test.ts`: "strict
  decoding", "market and token names come from the owner's rules").

### Storage griefing

Receipts are a ring buffer of the last 1000 (`ring_buffer_evicts_the_oldest_receipt`,
`default_ring_buffer_holds_1000_receipts`); a late `on_signed` still works after its receipt was
evicted (`callback_still_works_after_the_receipt_left_the_ring_buffer`). Every bound counts UTF-8
bytes, not characters: blocked receipts keep each agent string to 48 bytes and the memo to 140,
cut at a character boundary (`stored_proposal_cuts_agent_strings_in_bytes_at_char_boundaries`,
`blocked_receipts_cut_long_agent_strings`); a memo or a pause reason over 140 bytes is refused
(`memo_and_pause_reason_are_bounded_in_bytes`).

- Measured worst case: a blocked receipt with every agent string at its cut in 4-byte
  characters, a 64-character agent id and the longest message (`PAUSED` with a 140-byte reason)
  is 653 bytes of Borsh (pinned bound `MAX_BLOCKED_RECEIPT_BYTES` = 700,
  `worst_case_blocked_receipt_fits_the_pinned_size`), so 702 bytes of storage with its 9-byte key
  and NEAR's 40 bytes per record (the sandbox measures exactly that, less the shorter demo agent
  id and message). A full ring of 1000 such receipts is 702,000 bytes, 7.02 NEAR at 10^19
  yoctoNEAR per byte.
- Storage reserve: a blocked receipt is stored only while the balance covers
  `(storage_usage + 4096 bytes) × byte cost`, the same reserve allowed orders keep
  (`INSUFFICIENT_CONTRACT_BALANCE`). Below it the order is still blocked, the decision and the
  `order_blocked` event are unchanged, but nothing is stored and the decision's `receipt_id` is
  `"0"` (`blocked_receipt_is_stored_only_while_the_storage_reserve_is_kept`). Nothing is signed on
  this path. The largest allowed receipt with its pending-sign record is under 1.2 KB
  (`largest_allowed_receipt_fits_well_inside_the_storage_reserve`), and `pause` adds at most 144
  bytes, so the guardian can always pause.
- With the planned 5 NEAR of contract funding (about 2.9 NEAR of it for the code) a hijacked agent
  can reach the reserve with about 290 worst-case blocked proposals. After that its proposals
  leave only events, the guardian's `pause` with a 140-byte reason still succeeds, and the next
  proposal reads `Blocked by your rule: agent is paused (...)` with receipt id 0 (sandbox
  `blocked_receipts_keep_the_storage_reserve_so_the_guardian_can_still_pause`). The owner then adds
  NEAR to the contract and receipts are stored again. Owner decision D-18 (was Q-44); see the
  storage row in "What it does not stop".

### Secrets leaking from the off-chain tools

Secrets are wrapped so printing or serialising a config never shows them, and logs redact them
(`config.test.ts`: "secrets never reach logs"; `telegram.test.ts`: "6) the bot token never appears
in logs or errors"; `agent_llm.test.ts`: "reports API errors without the key"). `.gitleaks.toml`
adds rules for NEAR ed25519/secp256k1 secret keys (secp256k1 in both the 96-byte near-api-js form
and the 32-byte near-crypto / near-cli-rs form), EVM private keys and Telegram bot tokens. It has
no path allowlist, so the CI history scan also reports a key force-added under `target/`;
`scripts/gitleaks_selftest.sh` (also a step of the CI gitleaks job) checks both against random
throwaway values.

## What it does not stop

| Gap | Why | Mitigation or decision |
|---|---|---|
| Orders inside the owner's rules that are still bad trades | The contract checks limits, not judgement. | Keep caps small; Claw Watch reports bursts of blocked orders. |
| A compromised owner full-access key | The owner is trusted: it can register agents with any rules at once, set rules (a loosening `set_rules` waits for the delay), unpause. | Key hygiene is the owner's. The timelock and guardian cancel do not give a window against this key: they cover `set_rules` only (see the Q-43 row). |
| A compromised Hyperliquid master key | Outside this system; it controls the venue account directly. | Claw Watch reports new API wallets and builder fee approvals on the master account (testnet). |
| A known advisory in an npm dependency | The off-chain tools and the demo use npm packages. | Runtime dependencies: `npm audit --omit=dev` reports 0 and the CI `offchain` job fails on any new runtime advisory; `tar` (used by near-sandbox to unpack the sandbox node) is overridden to 7.5.22 (Q-32, `docs/VERIFY.md` section (b)). Dev-only tools: one `minimatch` advisory in eslint / typescript-eslint is recorded, not fixed, because its only fix is a new major version neither tool accepts yet; the patterns it parses come from this repository's own lint config. |
| The holder of the contract account's full-access key calling the MPC `sign` as the contract | The MPC derives keys from the caller account; whoever controls that account can sign. On testnet `setup:testnet` gives the contract account the owner's public key. | Owner decision (Q-14): lock the contract account after deploy, or keep the key offline. |
| A compromised guardian key | It can pause (denial of service) and cancel a pending loosening. It cannot unpause, loosen or sign. | Owner unpauses and replaces the guardian (`set_guardian`). |
| A venue that accepts a signed order and then behaves differently | Hyperliquid and Base Sepolia are outside the contract. | None in scope. |
| Bugs in the contract, the encoders or the off-chain tools | Not audited. | Tests listed here; prototype on testnet only. |
| The real MPC behaving differently from the mock (response shape, deposit, gas, yield timing) | Only the mock was exercised. | Parser is lenient on known variants and fails closed otherwise; testnet checks listed in [VERIFY.md](VERIFY.md). |
| Leverage updates once the daily cap is reached | A leverage update has zero notional, so `DAILY_CAP` does not block it (it still counts toward the order count). | Open question Q-01. |
| Hyperliquid sells worth more than the notional caps | Notional is counted at the agent's limit price (`ceil(px × sz)`), for buys and sells alike. A buy fills at or below its limit, so the count is an upper bound; a sell that crosses the book fills at the bid, which can be well above a low limit, so for sells the count is only a lower bound. The per-order notional cap and the daily cap therefore do not bound sells. | `max_order_sz` (per-order size), `max_orders_per_day` and `reduce_only_required` still apply to sells. Open question Q-42. |
| New rules applied at once with the owner key | The loosening delay and the guardian's cancel window cover `set_rules` only. `register_agent` of any account id, or `remove_agent` followed by `register_agent`, applies new rules at once (owner-only, 1 yoctoNEAR each). Re-registering also resets that agent's daily counters and nonce floors, and a new agent id signs through the same derived addresses (paths are per target, not per agent). | Needs the owner's full-access key (trusted). Claw Watch has no alert for `agent_registered`, `agent_removed` or `rules_pending`. Open question Q-43. |
| A hijacked agent filling the contract's storage with blocked receipts | Blocked proposals cost the agent only gas, do not count toward `max_orders_per_day`, and are stored while paused (`PAUSED`). A worst-case blocked receipt is 702 bytes of storage (653 bytes measured plus key and record overhead; strings cut in bytes), so the 1000-receipt ring needs 7.02 NEAR plus about 2.9 NEAR for the code, more than the planned 5 NEAR: about 290 worst-case blocked proposals reach the 4096-byte storage reserve. | Fails closed and pause keeps working: below the reserve a blocked order is answered with the same decision and `order_blocked` event but receipt id `"0"` and nothing stored; allowed orders get `INSUFFICIENT_CONTRACT_BALANCE`; nothing is signed. The guardian's `pause` still succeeds (it adds at most 144 bytes). Claw Watch reads receipts, so it does not alert on each order without a stored receipt; instead the `watch` CLI reads the contract account and raises `Public signal: contract storage reserve is close …` / `… reached …` (Telegram too; `reached` can trigger the opt-in autopause). The owner adds NEAR to the contract. Owner decisions D-18 (was Q-44; see also Q-04) and D-20 (was Q-56). |
| Signatures already issued | `pause` and a tightening `set_rules` only affect later `propose_order` calls; a signed receipt keeps its signature, anyone can read it with `get_receipt`, and the relayer holds no keys. The signed Hyperliquid action has no `expiresAfter`, so a signed order stays submittable for about 2 days (Hyperliquid's nonce window); a signed Base Sepolia transaction stays valid until its nonce is used. | Every such signature passed the owner's rules when it was signed. On the Hyperliquid path the owner, as master account, can deregister the derived API wallet on Hyperliquid testnet. Open question Q-45. |
| Base Sepolia transfers after a failed signature request | An allowed request consumes the agent's EVM nonce before the MPC answers; on `SignFailed` the reservation is released but the nonce stays consumed. The derived address's next on-chain nonce is then never signed, and the contract signs only higher ones, so every later transfer is signed with a nonce the chain cannot mine (the relayer refuses to send it) and still counts toward the daily cap and order count. | Liveness only: nothing outside the rules is signed. The agent cannot recover; the owner resets it with `remove_agent` + `register_agent` (which also resets its counters). After a reset the bundled agent takes its next EVM nonce from the contract, not the chain, so it starts again at 0: transfers with nonces the address already used are signed and counted, and the relayer refuses them. Open question Q-46 (see also Q-12). |
| Proposals that do not parse leave no record | `propose_order` takes typed JSON: `target` and the order kind are closed enums, `leverage` is a u8, `amount` and `nonce_ms` are integers. A proposal that does not fit (an unknown order kind or target, a negative or out-of-range number) fails in near-sdk's argument parsing before any rule runs. | Fails closed: nothing is signed. But no receipt and no event are stored, so `get_receipts` and Claw Watch do not see the attempt; only the failed transaction on the agent account shows it. Open question Q-47. |

## Watch only (after the fact)

Claw Watch reports, and with `CLAW_WATCH_AUTOPAUSE=1` pauses the guard through the guardian key:

| Change | Alert | Autopause | Tests |
|---|---|---|---|
| New key on the owner, agent, contract or guardian account | `Public signal: new full-access key on <account>` / `… function-call key …` | yes | `watch_near_keys.test.ts`, `watch_index.test.ts`, `make demo` (attacker key → pause → #9 blocked) |
| Key removed | `Public signal: key removed from <account>` | no | `watch_near_keys.test.ts` |
| New Hyperliquid API wallet or builder fee approval (testnet) | `Public signal: new API wallet …` / `… new builder fee approval …`; Telegram `Needs your OK: …` for the approval | yes | `watch_hl.test.ts`, `telegram.test.ts` |
| Blocked orders | `Order #<id> by <agent>: Blocked by your rule: …`; 3+ in 10 min: `Public signal: <n> orders blocked in the last 10 min` | burst only | `watch_receipts.test.ts` |
| Pause / unpause | `Public signal: agent paused by …` / `… unpaused by …` | — | `watch_receipts.test.ts` |

Limits of watching: it is polling (default every 15 s), so a change between polls is reported
late; the owner and guardian ids are read once at start (a guardian changed while the watcher runs
is watched after a restart); the Hyperliquid `approvedBuilders` response shape is not verified on
testnet; a builder approval removed and approved again within one long `watch` session is sent to
Telegram only once (dedupe); a proposal that does not parse leaves no receipt, so it raises no
alert (Q-47); and there is no alert for `agent_registered`, `agent_removed` or `rules_pending`
(Q-43).
