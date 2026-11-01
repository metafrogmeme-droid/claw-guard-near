//! The rule model: pure order evaluation, rules validation, tighten-vs-loosen.
//!
//! [`evaluate`] is a pure function of (agent state, context, proposal). It checks the rules in
//! a fixed order and stops at the first failure:
//!
//! ```text
//!  1 PAUSED   2 EXPIRED   3 TARGET_NOT_ENABLED   4 MALFORMED   5 STALE_NONCE
//!  6 MARKET_NOT_ALLOWED / TOKEN_NOT_ALLOWED   7 RECEIVER_NOT_ALLOWED   8 LEVERAGE_ABOVE_LIMIT
//!  9 REDUCE_ONLY_REQUIRED   10 ORDER_ABOVE_CAP   11 DAILY_ORDER_COUNT   12 DAILY_CAP
//! 13 INSUFFICIENT_CONTRACT_BALANCE
//! ```
//!
//! Only when every rule passes does it build the payload, and it builds it only from
//! owner-set data (HL asset index, token address) plus the agent's *checked* fields. Every
//! arithmetic step is checked; overflow blocks the order (fail closed).

use crate::errors::{self, Blocked};
use crate::evm::{self, Erc20Transfer};
use crate::hl::{self, LimitOrder};
use crate::order::{
    self, CheckedHlOrder, Decimal8, EvmAddress, Field, MAX_PERP_DECIMALS, Malformed,
    is_canonical_evm_address, is_rule_symbol, normalize_evm_address, same_evm_address,
};
use crate::types::{AgentState, MarketRule, OrderRequest, Proposal, Rules, Target, TokenRule};
use crate::util::encode_hex_0x;
use core::num::NonZeroU8;

/// Nanoseconds per UTC day; `day = block_timestamp_ns / NS_PER_DAY`.
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
const NS_PER_MS: u64 = 1_000_000;
/// An HL `nonce_ms` must be within this many ms of the block time (±5 min).
pub const HL_NONCE_WINDOW_MS: u64 = 300_000;
/// Storage kept free for the receipt an allowed order writes (INSUFFICIENT_CONTRACT_BALANCE);
/// blocked receipts keep it free too ([`keeps_receipt_reserve`]), so `pause` always fits.
pub const RECEIPT_STORAGE_RESERVE_BYTES: u64 = 4096;
/// Longest accepted market, token or receiver list in owner rules (bounds evaluation gas).
pub const MAX_RULE_LIST_LEN: usize = 64;

/// UTC day number of a block timestamp.
pub const fn day_of(timestamp_ns: u64) -> u64 {
    timestamp_ns / NS_PER_DAY
}

/// Everything outside the agent's own state that a decision depends on.
#[derive(Debug, Clone, Copy)]
pub struct EvalContext<'a> {
    pub paused: bool,
    pub pause_reason: &'a str,
    /// Block timestamp, ns.
    pub now_ns: u64,
    /// Contract balance, yoctoNEAR.
    pub account_balance: u128,
    /// Contract storage in use, bytes.
    pub storage_usage: u64,
    /// yoctoNEAR per byte of storage.
    pub storage_byte_cost: u128,
    /// Deposit attached to the MPC `sign` call, yoctoNEAR.
    pub sign_deposit: u128,
}

/// The nonce an allowed order consumes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nonce {
    Hl(u64),
    Evm(u64),
}

/// An order that passed every rule, with the exact payload to sign.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approved {
    pub target: Target,
    pub derivation_path: &'static str,
    /// What the MPC signs: the HL EIP-712 digest or `keccak256(unsigned tx)`.
    pub payload_hash: [u8; 32],
    /// HL: canonical action JSON; Base Sepolia: `0x` + unsigned tx hex.
    pub signed_body: String,
    /// Counted against the daily cap: HL notional (1e-6) or token amount (raw units).
    pub spend: u128,
    pub nonce: Nonce,
}

impl Approved {
    pub fn payload_hash_hex(&self) -> String {
        encode_hex_0x(&self.payload_hash)
    }
}

/// The agent-supplied fields after the MALFORMED step (4).
enum Checked<'p> {
    HlOrder {
        market: &'p str,
        is_buy: bool,
        reduce_only: bool,
        fields: CheckedHlOrder,
        nonce_ms: u64,
    },
    HlUpdateLeverage {
        market: &'p str,
        is_cross: bool,
        leverage: NonZeroU8,
        nonce_ms: u64,
    },
    EvmTransfer {
        token: &'p str,
        to: EvmAddress,
        amount: u128,
        nonce: u64,
        gas_limit: u64,
        max_fee_per_gas: u128,
        max_priority_fee_per_gas: u128,
    },
}

/// Evaluates one proposal. `Ok` means every rule passed; the caller then reserves the spend,
/// consumes the nonce and requests the signature. `Err` is the first rule that failed.
pub fn evaluate(
    agent: &AgentState,
    ctx: &EvalContext<'_>,
    proposal: &Proposal,
) -> Result<Approved, Blocked> {
    let rules = &agent.rules;

    // 1-3: global state, expiry, target.
    if ctx.paused {
        return Err(errors::paused(ctx.pause_reason));
    }
    if ctx.now_ns > rules.expires_at_ns.0 {
        return Err(errors::expired());
    }
    if !rules.targets.contains(&proposal.target) {
        return Err(errors::target_not_enabled(proposal.target));
    }

    // 4: shape and canonical formats (for a listed market, also its size and price decimals).
    let checked = check_well_formed(rules, proposal).map_err(errors::malformed)?;

    // 5: nonces.
    check_nonce(&checked, agent, ctx.now_ns)?;

    // 6-10: per-kind allowlists and caps; yields the owner-bound payload inputs.
    let (spend, spec) = match &checked {
        Checked::HlOrder {
            market,
            is_buy,
            reduce_only,
            fields,
            nonce_ms,
        } => {
            let market_rule = find_market(rules, market)?;
            if rules.reduce_only_required && !reduce_only {
                return Err(errors::reduce_only_required());
            }
            let size_ok = Decimal8::parse(&market_rule.max_order_sz)
                .is_ok_and(|cap| fields.sz().units() <= cap.units());
            if !size_ok || fields.notional_1e6() > rules.max_order_notional.0 {
                return Err(errors::order_above_cap());
            }
            let spec = PayloadSpec::HlOrder {
                order: LimitOrder {
                    asset: market_rule.asset,
                    is_buy: *is_buy,
                    reduce_only: *reduce_only,
                    checked: fields,
                },
                nonce_ms: *nonce_ms,
            };
            (fields.notional_1e6(), spec)
        }
        Checked::HlUpdateLeverage {
            market,
            is_cross,
            leverage,
            nonce_ms,
        } => {
            let market_rule = find_market(rules, market)?;
            if leverage.get() > rules.max_leverage {
                return Err(errors::leverage_above_limit(
                    leverage.get(),
                    rules.max_leverage,
                ));
            }
            let spec = PayloadSpec::HlUpdateLeverage {
                asset: market_rule.asset,
                is_cross: *is_cross,
                leverage: *leverage,
                nonce_ms: *nonce_ms,
            };
            (0, spec)
        }
        Checked::EvmTransfer {
            token,
            to,
            amount,
            nonce,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
        } => {
            let token_rule = find_token(rules, token)?;
            // Compared as 20 bytes, so the case the owner or the agent wrote never matters;
            // the message shows the lowercase form.
            let listed = rules
                .receivers
                .iter()
                .any(|receiver| EvmAddress::parse(receiver).as_ref() == Some(to));
            if !listed {
                return Err(errors::receiver_not_allowed(&to.to_hex()));
            }
            if *amount > token_rule.max_per_order.0 {
                return Err(errors::order_above_cap());
            }
            // Validated at registration; refuse rather than sign if it ever is not.
            let token_address = EvmAddress::parse(&token_rule.address)
                .ok_or_else(|| errors::malformed(Malformed(Field::Token)))?;
            let spec = PayloadSpec::EvmTransfer(Erc20Transfer {
                token: *token_address.as_bytes(),
                to: *to.as_bytes(),
                amount: *amount,
                nonce: *nonce,
                max_priority_fee_per_gas: *max_priority_fee_per_gas,
                max_fee_per_gas: *max_fee_per_gas,
                gas_limit: *gas_limit,
            });
            (*amount, spec)
        }
    };

    // 11-12: daily counters (stale-day counters count as 0).
    let (spent_today, orders_today) = agent.counters_on(day_of(ctx.now_ns));
    if orders_today >= rules.max_orders_per_day {
        return Err(errors::daily_order_count());
    }
    if spent_today
        .checked_add(spend)
        .is_none_or(|total| total > rules.daily_cap.0)
    {
        return Err(errors::daily_cap());
    }

    // 13: the contract can pay for the MPC request and the receipt.
    if !has_sign_balance(ctx) {
        return Err(errors::insufficient_contract_balance());
    }

    build(proposal.target, &spec, spend).map_err(errors::malformed)
}

/// Step 4: target/order shape, then each field in a fixed order, then the memo. For an
/// `HlOrder` on a market in `rules`, the market's `sz_decimals` also bounds the decimals of
/// `sz` and `limit_px`; an unlisted market gets only the generic format check here and is
/// blocked at step 6.
fn check_well_formed<'p>(rules: &Rules, proposal: &'p Proposal) -> Result<Checked<'p>, Malformed> {
    let checked = match (&proposal.order, proposal.target) {
        (
            OrderRequest::HlOrder {
                market,
                is_buy,
                limit_px,
                sz,
                reduce_only,
                tif,
                nonce_ms,
            },
            Target::HlTestnet,
        ) => {
            order::check_market(market)?;
            let sz_decimals = rules
                .markets
                .iter()
                .find(|m| m.name == *market)
                .map(|m| m.sz_decimals);
            Checked::HlOrder {
                market,
                is_buy: *is_buy,
                reduce_only: *reduce_only,
                fields: order::check_hl_order(limit_px, sz, tif, sz_decimals)?,
                nonce_ms: nonce_ms.0,
            }
        }
        (
            OrderRequest::HlUpdateLeverage {
                market,
                is_cross,
                leverage,
                nonce_ms,
            },
            Target::HlTestnet,
        ) => {
            order::check_market(market)?;
            Checked::HlUpdateLeverage {
                market,
                is_cross: *is_cross,
                leverage: order::check_leverage(*leverage)?,
                nonce_ms: nonce_ms.0,
            }
        }
        (
            OrderRequest::EvmTransfer {
                token,
                to,
                amount,
                nonce,
                gas_limit,
                max_fee_per_gas,
                max_priority_fee_per_gas,
            },
            Target::BaseSepolia,
        ) => {
            order::check_token(token)?;
            let to = order::check_evm_transfer(
                to,
                amount.0,
                gas_limit.0,
                max_fee_per_gas.0,
                max_priority_fee_per_gas.0,
            )?;
            order::check_evm_nonce(nonce.0)?;
            Checked::EvmTransfer {
                token,
                to,
                amount: amount.0,
                nonce: nonce.0,
                gas_limit: gas_limit.0,
                max_fee_per_gas: max_fee_per_gas.0,
                max_priority_fee_per_gas: max_priority_fee_per_gas.0,
            }
        }
        // An HL order for Base Sepolia, or a transfer for Hyperliquid.
        _ => return Err(Malformed(Field::Order)),
    };
    order::check_memo(proposal.memo.as_deref())?;
    Ok(checked)
}

/// Step 5: HL nonces within ±5 min of block time and strictly increasing per agent; EVM nonces
/// strictly increasing per agent (any value up to `MAX_EVM_NONCE` for the first one; larger
/// values are already `MALFORMED` in step 4).
fn check_nonce(checked: &Checked<'_>, agent: &AgentState, now_ns: u64) -> Result<(), Blocked> {
    let fresh = match checked {
        Checked::HlOrder { nonce_ms, .. } | Checked::HlUpdateLeverage { nonce_ms, .. } => {
            let now_ms = now_ns / NS_PER_MS;
            nonce_ms.abs_diff(now_ms) <= HL_NONCE_WINDOW_MS
                && agent.last_hl_nonce_ms.is_none_or(|last| *nonce_ms > last.0)
        }
        Checked::EvmTransfer { nonce, .. } => {
            agent.last_evm_nonce.is_none_or(|last| *nonce > last.0)
        }
    };
    if fresh {
        Ok(())
    } else {
        Err(errors::stale_nonce())
    }
}

fn find_market<'r>(rules: &'r Rules, market: &str) -> Result<&'r MarketRule, Blocked> {
    rules
        .markets
        .iter()
        .find(|m| m.name == market)
        .ok_or_else(|| errors::market_not_allowed(market))
}

fn find_token<'r>(rules: &'r Rules, token: &str) -> Result<&'r TokenRule, Blocked> {
    rules
        .tokens
        .iter()
        .find(|t| t.symbol == token)
        .ok_or_else(|| errors::token_not_allowed(token))
}

/// `(storage_usage + RECEIPT_STORAGE_RESERVE_BYTES) × byte_cost`, or `None` on overflow.
fn reserve_floor(ctx: &EvalContext<'_>) -> Option<u128> {
    u128::from(ctx.storage_usage)
        .checked_add(u128::from(RECEIPT_STORAGE_RESERVE_BYTES))
        .and_then(|bytes| bytes.checked_mul(ctx.storage_byte_cost))
}

/// Step 13: `balance >= (storage_usage + RECEIPT_STORAGE_RESERVE_BYTES) × byte_cost + deposit`.
fn has_sign_balance(ctx: &EvalContext<'_>) -> bool {
    reserve_floor(ctx)
        .and_then(|cost| cost.checked_add(ctx.sign_deposit))
        .is_some_and(|needed| ctx.account_balance >= needed)
}

/// Whether a blocked receipt may be stored (Q-44):
/// `balance >= (storage_usage + RECEIPT_STORAGE_RESERVE_BYTES) × byte_cost`. Overflow counts as
/// not enough. Blocked receipts thus never use the last 4096 bytes the balance pays for.
pub fn keeps_receipt_reserve(ctx: &EvalContext<'_>) -> bool {
    reserve_floor(ctx).is_some_and(|needed| ctx.account_balance >= needed)
}

/// Payload inputs after every rule passed: owner-bound data plus checked agent fields.
enum PayloadSpec<'a> {
    HlOrder {
        order: LimitOrder<'a>,
        nonce_ms: u64,
    },
    HlUpdateLeverage {
        asset: u32,
        is_cross: bool,
        leverage: NonZeroU8,
        nonce_ms: u64,
    },
    EvmTransfer(Erc20Transfer),
}

fn build(target: Target, spec: &PayloadSpec<'_>, spend: u128) -> Result<Approved, Malformed> {
    let (payload_hash, signed_body, nonce) = match spec {
        PayloadSpec::HlOrder { order, nonce_ms } => {
            let payload = hl::build_order(order, *nonce_ms)?;
            (payload.digest, payload.action_json, Nonce::Hl(*nonce_ms))
        }
        PayloadSpec::HlUpdateLeverage {
            asset,
            is_cross,
            leverage,
            nonce_ms,
        } => {
            let payload = hl::build_update_leverage(*asset, *is_cross, *leverage, *nonce_ms)?;
            (payload.digest, payload.action_json, Nonce::Hl(*nonce_ms))
        }
        PayloadSpec::EvmTransfer(transfer) => {
            let payload = evm::build_transfer(transfer);
            (
                payload.payload_hash,
                encode_hex_0x(&payload.unsigned_tx),
                Nonce::Evm(transfer.nonce),
            )
        }
    };
    Ok(Approved {
        target,
        derivation_path: target.derivation_path(),
        payload_hash,
        signed_body,
        spend,
        nonce,
    })
}

// ---------------------------------------------------------------------------------------------
// Agent counters
// ---------------------------------------------------------------------------------------------

impl AgentState {
    /// A freshly registered agent: version 1, nothing pending, zero counters for `today`.
    pub fn new(rules: Rules, today: u64) -> Self {
        Self {
            rules,
            rules_version: 1,
            pending: None,
            day: today,
            spent_today: 0.into(),
            orders_today: 0,
            last_hl_nonce_ms: None,
            last_evm_nonce: None,
        }
    }

    /// `(spent, orders)` that count on `day`: the stored counters, or zero if they belong to
    /// another day.
    pub fn counters_on(&self, day: u64) -> (u128, u32) {
        if self.day == day {
            (self.spent_today.0, self.orders_today)
        } else {
            (0, 0)
        }
    }

    /// Records an allowed order on `day`: reserves its spend and one order, consumes its nonce.
    /// Callers have checked the caps, so the additions cannot overflow; they saturate anyway.
    pub fn reserve(&mut self, day: u64, spend: u128, nonce: Nonce) {
        let (spent, orders) = self.counters_on(day);
        self.day = day;
        self.spent_today = spent.saturating_add(spend).into();
        self.orders_today = orders.saturating_add(1);
        match nonce {
            Nonce::Hl(n) => self.last_hl_nonce_ms = Some(n.into()),
            Nonce::Evm(n) => self.last_evm_nonce = Some(n.into()),
        }
    }

    /// Gives back a reservation made on `reserved_day` if it is still `today` (a reservation
    /// from an earlier day already expired with that day's counters). Nonces stay consumed.
    pub fn release(&mut self, reserved_day: u64, today: u64, spend: u128) {
        if reserved_day == today && self.day == today {
            self.spent_today = self.spent_today.0.saturating_sub(spend).into();
            self.orders_today = self.orders_today.saturating_sub(1);
        }
    }

    /// The state as seen on `today`: counters of another day read as zero.
    pub fn view_on(&self, today: u64) -> Self {
        let (spent, orders) = self.counters_on(today);
        Self {
            day: today,
            spent_today: spent.into(),
            orders_today: orders,
            ..self.clone()
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Rules validation and tighten-vs-loosen
// ---------------------------------------------------------------------------------------------

/// Turns owner rules as sent to `register_agent` / `set_rules` into the stored form, or names
/// the offending field (`ERR_INVALID_RULES`).
///
/// Every EVM address (token addresses, receivers) may be sent as `0x`/`0X` + 40 hex digits,
/// all lowercase, all uppercase or a valid EIP-55 checksum; it is stored as `0x` + 40
/// lowercase hex, so `get_rules`, comparisons and messages only ever see that form. An
/// address that does not parse is left as sent, so [`validate_rules`] then refuses it; it
/// runs on the normalized rules, so duplicates are found whatever case they were sent in.
pub fn normalize_rules(mut rules: Rules) -> Result<Rules, &'static str> {
    let normalize = |address: &mut String| {
        if let Some(lowercase) = normalize_evm_address(address) {
            *address = lowercase;
        }
    };
    rules
        .tokens
        .iter_mut()
        .for_each(|token| normalize(&mut token.address));
    rules.receivers.iter_mut().for_each(normalize);
    validate_rules(&rules)?;
    Ok(rules)
}

/// Checks owner rules in their stored form (`ERR_INVALID_RULES`). The error names the
/// offending field. Addresses must already be `0x` + 40 lowercase hex: owner input goes through
/// [`normalize_rules`] first.
///
/// Markets: `sz_decimals <= MAX_PERP_DECIMALS` (6) and `max_order_sz` canonical with at most
/// `sz_decimals` decimals. The `sz_decimals` bound also refuses
/// [`INVALID_SZ_DECIMALS`](crate::types::INVALID_SZ_DECIMALS), which JSON input that is not an
/// integer from 0 to 255 (or no value) reads as (owner decision D-11): it runs on every path
/// that stores rules (`register_agent`, `set_rules` applied or pending, `confirm_rules`).
pub fn validate_rules(rules: &Rules) -> Result<(), &'static str> {
    if rules.targets.is_empty()
        || rules.targets.len() > Target::ALL.len()
        || !all_unique(rules.targets.iter())
    {
        return Err("targets");
    }
    let market_ok = |m: &MarketRule| {
        is_rule_symbol(&m.name)
            && m.sz_decimals <= MAX_PERP_DECIMALS
            && Decimal8::parse(&m.max_order_sz)
                .is_ok_and(|cap| cap.decimals() <= usize::from(m.sz_decimals))
    };
    if rules.markets.len() > MAX_RULE_LIST_LEN
        || !rules.markets.iter().all(market_ok)
        || !all_unique(rules.markets.iter().map(|m| m.name.as_str()))
        || !all_unique(rules.markets.iter().map(|m| m.asset))
    {
        return Err("markets");
    }
    if rules.max_leverage == 0 {
        return Err("max_leverage");
    }
    if rules.tokens.len() > MAX_RULE_LIST_LEN
        || !rules.tokens.iter().all(|t| {
            is_rule_symbol(&t.symbol) && is_canonical_evm_address(&t.address) && t.decimals == 6
        })
        || !all_unique(rules.tokens.iter().map(|t| t.symbol.as_str()))
        || !all_unique(rules.tokens.iter().map(|t| t.address.as_str()))
    {
        return Err("tokens");
    }
    if rules.receivers.len() > MAX_RULE_LIST_LEN
        || !rules.receivers.iter().all(|r| is_canonical_evm_address(r))
        || !all_unique(rules.receivers.iter())
    {
        return Err("receivers");
    }
    Ok(())
}

/// Quadratic, but callers check the list length first, and it needs no hasher in wasm.
fn all_unique<T: PartialEq>(items: impl Iterator<Item = T>) -> bool {
    let items: Vec<T> = items.collect();
    items
        .iter()
        .enumerate()
        .all(|(i, item)| !items[..i].contains(item))
}

/// The first field (wire name) in which `new` is looser than `old`, or `None` if `new` is
/// tighter or equal on every field (and can apply at once).
///
/// Looser means: a target, market, token or receiver added; any cap, limit or count raised; a
/// later expiry; `reduce_only_required` turned off. A market whose `asset` or `sz_decimals`
/// changed, or a token whose `address` or `decimals` changed, counts as removed and re-added,
/// so it is looser. Addresses are compared as 20 bytes, so case and `0x`/`0X` never matter; an
/// unparsable address matches nothing and reads as an addition (fail closed). Both rule sets
/// should have passed [`normalize_rules`] (canonical `max_order_sz`).
pub fn first_loosening(old: &Rules, new: &Rules) -> Option<&'static str> {
    if !new.targets.iter().all(|t| old.targets.contains(t)) {
        return Some("targets");
    }
    let market_tighter = |m: &MarketRule| {
        old.markets.iter().any(|o| {
            o.name == m.name
                && o.asset == m.asset
                && o.sz_decimals == m.sz_decimals
                && units(&m.max_order_sz)
                    .zip(units(&o.max_order_sz))
                    .is_some_and(|(new_cap, old_cap)| new_cap <= old_cap)
        })
    };
    if !new.markets.iter().all(market_tighter) {
        return Some("markets");
    }
    if new.max_order_notional.0 > old.max_order_notional.0 {
        return Some("max_order_notional");
    }
    if new.max_leverage > old.max_leverage {
        return Some("max_leverage");
    }
    let token_tighter = |t: &TokenRule| {
        old.tokens.iter().any(|o| {
            o.symbol == t.symbol
                && same_evm_address(&o.address, &t.address)
                && o.decimals == t.decimals
                && t.max_per_order.0 <= o.max_per_order.0
        })
    };
    if !new.tokens.iter().all(token_tighter) {
        return Some("tokens");
    }
    if !new
        .receivers
        .iter()
        .all(|r| old.receivers.iter().any(|o| same_evm_address(o, r)))
    {
        return Some("receivers");
    }
    if new.daily_cap.0 > old.daily_cap.0 {
        return Some("daily_cap");
    }
    if new.max_orders_per_day > old.max_orders_per_day {
        return Some("max_orders_per_day");
    }
    if new.expires_at_ns.0 > old.expires_at_ns.0 {
        return Some("expires_at_ns");
    }
    if old.reduce_only_required && !new.reduce_only_required {
        return Some("reduce_only_required");
    }
    None
}

fn units(decimal: &str) -> Option<u128> {
    Decimal8::parse(decimal).ok().map(|d| d.units())
}

#[cfg(test)]
mod tests;
