//! On-chain receipts: a ring buffer of the last `max_receipts` (default 1000).
//!
//! Ids start at 1 and are never reused. When receipt `n` is written, receipt
//! `n - max_receipts` is deleted; older decisions survive only as events. Together with the
//! per-field byte cap on stored proposals this bounds the storage an agent can make the
//! contract pay for: at most [`MAX_BLOCKED_RECEIPT_BYTES`] per blocked receipt.

use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{IntoStorageKey, near};

use crate::order::{MAX_MEMO_BYTES, normalize_evm_address};
use crate::types::{OrderRequest, Proposal, Receipt};
use crate::util::truncate_utf8;
use crate::{ClawGuard, ClawGuardExt};

/// Receipts kept in state.
pub const DEFAULT_MAX_RECEIPTS: u64 = 1000;
/// Largest page `get_receipts` returns.
pub const MAX_PAGE: u32 = 50;
/// Longest agent-supplied string kept in a *blocked* receipt, in UTF-8 bytes (allowed orders are
/// already bounded by their format checks). Longer strings are cut at a character boundary.
pub const MAX_STORED_FIELD_BYTES: usize = 48;
/// Largest Borsh size of a blocked receipt: every agent string cut to its limit with 4-byte
/// characters, a 64-character agent id and the longest message (`PAUSED` with a 140-byte
/// reason). Measured by `worst_case_blocked_receipt_fits_the_pinned_size`. In storage add the
/// 9-byte key and NEAR's 40 bytes per record.
pub const MAX_BLOCKED_RECEIPT_BYTES: u64 = 700;

#[near(serializers = [borsh])]
pub struct ReceiptLog {
    receipts: LookupMap<u64, Receipt>,
    /// Id of the next receipt; `next_id - 1` receipts were ever created.
    next_id: u64,
    max_receipts: u64,
}

impl ReceiptLog {
    pub fn new(prefix: impl IntoStorageKey, max_receipts: u64) -> Self {
        Self {
            receipts: LookupMap::new(prefix),
            next_id: 1,
            max_receipts,
        }
    }

    /// Receipts ever created.
    pub fn total(&self) -> u64 {
        self.next_id - 1
    }

    /// Smallest id still stored (or `next_id` if none is).
    pub fn oldest_id(&self) -> u64 {
        self.next_id.saturating_sub(self.max_receipts).max(1)
    }

    /// Stores `receipt` under the next id (overwriting its `id` field), evicts the receipt that
    /// falls out of the window, and returns the new id.
    pub fn push(&mut self, mut receipt: Receipt) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        receipt.id = U64(id);
        self.receipts.insert(id, receipt);
        if id > self.max_receipts {
            self.receipts.remove(&(id - self.max_receipts));
        }
        id
    }

    pub fn get(&self, id: u64) -> Option<&Receipt> {
        self.receipts.get(&id)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Receipt> {
        self.receipts.get_mut(&id)
    }

    /// Up to `limit` (≤ [`MAX_PAGE`]) receipts with ids ≥ `from_id`, ascending.
    pub fn page(&self, from_id: u64, limit: u32) -> Vec<Receipt> {
        let start = from_id.max(self.oldest_id());
        let limit = u64::from(limit.min(MAX_PAGE));
        (start..self.next_id)
            .take(limit as usize)
            .filter_map(|id| self.receipts.get(&id).cloned())
            .collect()
    }

    /// Test hook: shrink the window (only before any receipt exists).
    #[cfg(test)]
    pub fn set_max_receipts(&mut self, max_receipts: u64) {
        assert_eq!(self.total(), 0, "set the window before writing receipts");
        self.max_receipts = max_receipts;
    }
}

/// The copy of an agent's proposal kept in a *blocked* receipt: a well-formed EVM `to` in its
/// lowercase `0x` form, every other agent-supplied string cut to [`MAX_STORED_FIELD_BYTES`]
/// (memo: [`MAX_MEMO_BYTES`]), never inside a character. Nothing else changes.
pub fn stored_proposal(proposal: &Proposal) -> Proposal {
    let cut = |s: &str| -> String { truncate_utf8(s, MAX_STORED_FIELD_BYTES).to_owned() };
    let order = match &proposal.order {
        OrderRequest::HlOrder {
            market,
            is_buy,
            limit_px,
            sz,
            reduce_only,
            tif,
            nonce_ms,
        } => OrderRequest::HlOrder {
            market: cut(market),
            is_buy: *is_buy,
            limit_px: cut(limit_px),
            sz: cut(sz),
            reduce_only: *reduce_only,
            tif: cut(tif),
            nonce_ms: *nonce_ms,
        },
        OrderRequest::HlUpdateLeverage {
            market,
            is_cross,
            leverage,
            nonce_ms,
        } => OrderRequest::HlUpdateLeverage {
            market: cut(market),
            is_cross: *is_cross,
            leverage: *leverage,
            nonce_ms: *nonce_ms,
        },
        OrderRequest::EvmTransfer {
            token,
            to,
            amount,
            nonce,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
        } => OrderRequest::EvmTransfer {
            token: cut(token),
            to: normalize_evm_address(to).unwrap_or_else(|| cut(to)),
            amount: *amount,
            nonce: *nonce,
            gas_limit: *gas_limit,
            max_fee_per_gas: *max_fee_per_gas,
            max_priority_fee_per_gas: *max_priority_fee_per_gas,
        },
    };
    Proposal {
        target: proposal.target,
        order,
        memo: proposal
            .memo
            .as_ref()
            .map(|memo| truncate_utf8(memo, MAX_MEMO_BYTES).to_owned()),
    }
}

/// The copy of an *allowed* proposal kept in its receipt: as received, except the EVM `to` in
/// its lowercase `0x` form (the form the rules compared). Allowed orders passed every format
/// check, so no string needs cutting.
pub fn allowed_proposal(mut proposal: Proposal) -> Proposal {
    if let OrderRequest::EvmTransfer { to, .. } = &mut proposal.order
        && let Some(lowercase) = normalize_evm_address(to)
    {
        *to = lowercase;
    }
    proposal
}

#[near]
impl ClawGuard {
    /// `get_receipt({"id":"12"})` → the receipt, or `null` if it never existed or was evicted.
    pub fn get_receipt(&self, id: U64) -> Option<Receipt> {
        self.receipts.get(id.0).cloned()
    }

    /// `get_receipts({"from_id":"1","limit":20})` → receipts with id ≥ `from_id`, ascending,
    /// at most 50. Evicted ids are skipped.
    pub fn get_receipts(&self, from_id: U64, limit: u32) -> Vec<Receipt> {
        self.receipts.page(from_id.0, limit)
    }
}
