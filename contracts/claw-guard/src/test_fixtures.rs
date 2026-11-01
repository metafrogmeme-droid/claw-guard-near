//! Shared fixtures for the unit tests (rule model and contract). Testnet values only.

use near_sdk::json_types::{U64, U128};

use crate::rules::NS_PER_DAY;
use crate::types::{MarketRule, OrderRequest, Proposal, Rules, Target, TokenRule};

/// 2026-10-30T00:00:00Z, the base of the HL vector nonces.
pub const DAY_START_NS: u64 = 1_793_318_400_000_000_000;
/// "Now" for most tests: noon of that day, far from both day boundaries.
pub const NOW_NS: u64 = DAY_START_NS + NS_PER_DAY / 2;
pub const NOW_MS: u64 = NOW_NS / 1_000_000;

/// Allowed receiver (the owner's own test address).
pub const OWNER_ADDR: &str = "0x1111111111111111111111111111111111111111";
/// Circle test USDC on Base Sepolia (lowercase).
pub const USDC_ADDR: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
pub const BAD_ADDR: &str = "0xbad0000000000000000000000000000000000bad";

/// BTC: per-order size cap `0.01`, size decimals 5. ETH: `0.1`, size decimals 4 (the HL
/// testnet `szDecimals` of the demo rules).
pub const BTC_ASSET: u32 = 3;
pub const ETH_ASSET: u32 = 4;
pub const BTC_SZ_DECIMALS: u8 = 5;
pub const ETH_SZ_DECIMALS: u8 = 4;
/// HL per-order notional cap: 1000 quote units (1e-6).
pub const MAX_NOTIONAL: u128 = 1_000_000_000;
/// USDC per-transfer cap: 5 units (6 decimals).
pub const USDC_CAP: u128 = 5_000_000;
pub const DAILY_CAP: u128 = 2_000_000_000;
pub const MAX_ORDERS: u32 = 10;
pub const MAX_LEVERAGE: u8 = 3;

pub fn market(name: &str, asset: u32, max_order_sz: &str, sz_decimals: u8) -> MarketRule {
    MarketRule {
        name: name.to_owned(),
        asset,
        max_order_sz: max_order_sz.to_owned(),
        sz_decimals,
    }
}

pub fn token(symbol: &str, address: &str, max_per_order: u128) -> TokenRule {
    TokenRule {
        symbol: symbol.to_owned(),
        address: address.to_owned(),
        decimals: 6,
        max_per_order: U128(max_per_order),
    }
}

/// The demo-style rules: both targets, BTC/ETH, leverage 3, 10 orders per day,
/// one receiver, expiry in 7 days.
pub fn rules() -> Rules {
    Rules {
        targets: vec![Target::HlTestnet, Target::BaseSepolia],
        markets: vec![
            market("BTC", BTC_ASSET, "0.01", BTC_SZ_DECIMALS),
            market("ETH", ETH_ASSET, "0.1", ETH_SZ_DECIMALS),
        ],
        max_order_notional: U128(MAX_NOTIONAL),
        max_leverage: MAX_LEVERAGE,
        tokens: vec![token("USDC", USDC_ADDR, USDC_CAP)],
        receivers: vec![OWNER_ADDR.to_owned()],
        daily_cap: U128(DAILY_CAP),
        max_orders_per_day: MAX_ORDERS,
        expires_at_ns: U64(NOW_NS + 7 * NS_PER_DAY),
        reduce_only_required: false,
    }
}

/// A buy limit order (Gtc, not reduce-only).
pub fn hl_order(market: &str, limit_px: &str, sz: &str, nonce_ms: u64) -> Proposal {
    Proposal {
        target: Target::HlTestnet,
        order: OrderRequest::HlOrder {
            market: market.to_owned(),
            is_buy: true,
            limit_px: limit_px.to_owned(),
            sz: sz.to_owned(),
            reduce_only: false,
            tif: "Gtc".to_owned(),
            nonce_ms: U64(nonce_ms),
        },
        memo: None,
    }
}

/// `0.001 BTC` at `1000`: notional 1 quote unit (1_000_000).
pub fn small_btc(nonce_ms: u64) -> Proposal {
    hl_order("BTC", "1000", "0.001", nonce_ms)
}

pub fn hl_leverage(market: &str, leverage: u8, nonce_ms: u64) -> Proposal {
    Proposal {
        target: Target::HlTestnet,
        order: OrderRequest::HlUpdateLeverage {
            market: market.to_owned(),
            is_cross: true,
            leverage,
            nonce_ms: U64(nonce_ms),
        },
        memo: None,
    }
}

/// A USDC transfer with gas 65 000, max fee 1 gwei, priority fee 0.001 gwei.
pub fn transfer(to: &str, amount: u128, nonce: u64) -> Proposal {
    Proposal {
        target: Target::BaseSepolia,
        order: OrderRequest::EvmTransfer {
            token: "USDC".to_owned(),
            to: to.to_owned(),
            amount: U128(amount),
            nonce: U64(nonce),
            gas_limit: U64(65_000),
            max_fee_per_gas: U128(1_000_000_000),
            max_priority_fee_per_gas: U128(1_000_000),
        },
        memo: None,
    }
}

/// Canonical decimal string of a value in 1e-8 units (`150_000_000` -> `"1.5"`).
pub fn decimal_from_units(units: u128) -> String {
    let int = units / 100_000_000;
    let frac = units % 100_000_000;
    if frac == 0 {
        return int.to_string();
    }
    let frac = format!("{frac:08}");
    format!("{int}.{}", frac.trim_end_matches('0'))
}

/// Deterministic pseudo-random numbers (SplitMix64) for the property tests.
pub struct SplitMix64(pub u64);

impl SplitMix64 {
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in `lo..=hi`.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next_u64() % (hi - lo + 1)
    }

    pub fn coin(&mut self) -> bool {
        self.next_u64() & 1 == 1
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.range(0, items.len() as u64 - 1) as usize]
    }
}

#[test]
fn decimal_formatting() {
    assert_eq!(decimal_from_units(1), "0.00000001");
    assert_eq!(decimal_from_units(100_000_000), "1");
    assert_eq!(decimal_from_units(150_000_000), "1.5");
    assert_eq!(decimal_from_units(1_000_000), "0.01");
}
