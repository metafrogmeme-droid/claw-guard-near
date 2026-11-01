//! Wire types of the claw-guard contract.
//!
//! Field names are the JSON wire names. Numbers that can exceed 2^53 travel as decimal strings
//! (`U64` / `U128`). The same types are stored with Borsh.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde::{Deserialize, Deserializer};
use near_sdk::{AccountId, near};
use serde_json::value::RawValue;

use crate::errors::RuleCode;
use crate::order::MAX_PERP_DECIMALS;

/// MPC derivation path for Hyperliquid testnet (one distinct path per chain).
pub const HL_TESTNET_PATH: &str = "hl-testnet-1";
/// MPC derivation path for Base Sepolia.
pub const BASE_SEPOLIA_PATH: &str = "base-sepolia-1";

/// Where a signed payload is used. JSON: `"HlTestnet"` | `"BaseSepolia"`.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Target {
    HlTestnet,
    BaseSepolia,
}

impl Target {
    pub const ALL: [Self; 2] = [Self::HlTestnet, Self::BaseSepolia];

    /// The JSON wire name, also used in decision messages.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HlTestnet => "HlTestnet",
            Self::BaseSepolia => "BaseSepolia",
        }
    }

    /// The fixed MPC derivation path for this target.
    pub const fn derivation_path(self) -> &'static str {
        match self {
            Self::HlTestnet => HL_TESTNET_PATH,
            Self::BaseSepolia => BASE_SEPOLIA_PATH,
        }
    }
}

/// What a market's `sz_decimals` reads as when the owner sent a JSON value that is not an
/// integer from 0 to 255, or no value at all (owner decision D-11). Rules validation refuses it
/// like any value above 6, so it can never be stored.
pub const INVALID_SZ_DECIMALS: u8 = u8::MAX;
const _: () = assert!(INVALID_SZ_DECIMALS > MAX_PERP_DECIMALS);

// Owner decision D-11: JSON input is read through `MarketRuleInput` (`serde(from)`), so a bad
// `sz_decimals` (300, -1, 1.5, 1e2, "5", true, null, missing) is refused by `register_agent` /
// `set_rules` with `ERR_INVALID_RULES (markets)`, not by near-sdk's "Failed to deserialize
// input from JSON" panic. Serialization, Borsh and the ABI schema still come from the plain
// fields below: `"sz_decimals"` is a required integer. The doc comments of this struct and its
// fields are the ABI descriptions; keep these notes out of them.
/// One allowed Hyperliquid market.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
#[serde(from = "MarketRuleInput")]
pub struct MarketRule {
    /// Market name, e.g. `"BTC"`: 1..=16 of `A-Z0-9`, unique per agent.
    pub name: String,
    /// HL testnet asset index. Set by the owner (from `/info` meta); the agent never supplies it.
    pub asset: u32,
    /// Largest size per order in coin units, canonical decimal (e.g. `"0.01"`) with at most
    /// `sz_decimals` decimals.
    pub max_order_sz: String,
    /// HL size decimals of this market (`/info` `meta` → `universe[i].szDecimals`), `0..=6`.
    /// Set by the owner; the agent never supplies it. An order's `sz` may have at most this
    /// many decimals and a non-integer `limit_px` at most `6 - sz_decimals`. Required in JSON.
    pub sz_decimals: u8,
}

// D-11: the JSON input form of `MarketRule`; see the note above it. Do not "simplify" this away:
// - Deriving `Deserialize` on `MarketRule` itself makes serde reject 300, -1, 1.5, "5", null or
//   a missing field while near-sdk parses the call arguments, so the owner would get "Failed to
//   deserialize input from JSON" instead of `ERR_INVALID_RULES (markets)`.
// - Putting `#[serde(default = ...)]` on `MarketRule::sz_decimals` instead would make schemars
//   list the field as optional with `"default": 255` in the ABI.
// - Reading the value as a `serde_json::Value` instead of its raw text fails to parse `1e400`
//   (see `deserialize_sz_decimals`).
// Every value that is not an integer from 0 to 255 becomes `INVALID_SZ_DECIMALS`, which
// `rules::validate_rules` refuses on every path that stores rules.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MarketRuleInput {
    name: String,
    asset: u32,
    max_order_sz: String,
    #[serde(
        default = "invalid_sz_decimals",
        deserialize_with = "deserialize_sz_decimals"
    )]
    sz_decimals: u8,
}

impl From<MarketRuleInput> for MarketRule {
    fn from(input: MarketRuleInput) -> Self {
        let MarketRuleInput {
            name,
            asset,
            max_order_sz,
            sz_decimals,
        } = input;
        Self {
            name,
            asset,
            max_order_sz,
            sz_decimals,
        }
    }
}

/// `sz_decimals` when the field is missing.
const fn invalid_sz_decimals() -> u8 {
    INVALID_SZ_DECIMALS
}

/// Reads any JSON value: an integer from 0 to 255 as is, anything else (a negative, larger or
/// non-integer number such as `5.0`, `1e2` or `1e400`, a string, a bool, `null`, an array or an
/// object) as [`INVALID_SZ_DECIMALS`]. Fails only where the JSON itself does not parse.
///
/// It looks at the raw JSON text, not a parsed `serde_json::Value`: building a `Value` fails
/// for a number out of `f64` range (`1e400`, a 400-digit integer), arrays nested more than 128
/// deep and strings with an unpaired `\u` surrogate, which would bring back the JSON parse
/// panic. JSON allows no `+`, leading zeros or surrounding spaces in a raw number, so raw text
/// of only ASCII digits is exactly a non-negative integer; `parse` refuses (never wraps)
/// anything above 255. `RawValue` needs a serde_json deserializer (near-sdk's `from_slice`,
/// `from_str`, `from_value`): keep `Rules` out of untagged or flattened serde types.
fn deserialize_sz_decimals<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u8, D::Error> {
    let raw = Box::<RawValue>::deserialize(deserializer)?;
    let text = raw.get();
    Ok(Some(text)
        .filter(|text| text.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(INVALID_SZ_DECIMALS))
}

/// One allowed ERC-20 token on Base Sepolia.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenRule {
    /// Token symbol the agent uses, e.g. `"USDC"`: 1..=16 of `A-Z0-9`, unique per agent.
    pub symbol: String,
    /// Token contract: `0x`/`0X` + 40 hex (all lowercase, all uppercase or a valid EIP-55
    /// checksum); stored and shown as `0x` + 40 lowercase hex. The agent never supplies it.
    pub address: String,
    /// Must be 6, so the shared daily counter compares like with like (1e-6 units).
    pub decimals: u8,
    /// Largest amount per transfer, raw token units.
    pub max_per_order: U128,
}

/// The owner's rules for one agent.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    /// Enabled targets (non-empty, unique).
    pub targets: Vec<Target>,
    /// HL market allowlist.
    pub markets: Vec<MarketRule>,
    /// HL per-order notional cap: `ceil(px × sz)` in 1e-6 quote units.
    pub max_order_notional: U128,
    /// HL `updateLeverage` ceiling (>= 1).
    pub max_leverage: u8,
    /// Base Sepolia token allowlist.
    pub tokens: Vec<TokenRule>,
    /// Base Sepolia allowed receivers; same address format as [`TokenRule::address`], stored
    /// and shown as `0x` + 40 lowercase hex.
    pub receivers: Vec<String>,
    /// Per UTC day, one counter across targets: HL notional (1e-6 quote units) plus EVM
    /// amounts (raw units of 6-decimal tokens).
    pub daily_cap: U128,
    /// Orders per UTC day (HL orders, leverage updates and transfers all count).
    pub max_orders_per_day: u32,
    /// Block timestamp (ns) after which every order is blocked.
    pub expires_at_ns: U64,
    /// Optional tightener: only reduce-only HL orders. Defaults to `false` when omitted.
    #[serde(default)]
    pub reduce_only_required: bool,
}

/// An agent's rules, pending change and today's counters, as returned by `get_rules`.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentState {
    pub rules: Rules,
    /// 1 at registration, +1 every time new rules take effect.
    pub rules_version: u32,
    /// A loosening waiting for `confirm_rules`: the rules and the earliest time (ns) to confirm.
    pub pending: Option<(Rules, U64)>,
    /// UTC day number (`block_timestamp / 86400 s`) the counters belong to.
    pub day: u64,
    pub spent_today: U128,
    pub orders_today: u32,
    /// Last HL nonce (ms) this agent had signed; the next must be strictly greater.
    /// Added so agents can read the nonce floor.
    pub last_hl_nonce_ms: Option<U64>,
    /// Last EVM nonce this agent had signed; the next must be strictly greater.
    pub last_evm_nonce: Option<U64>,
}

/// What the agent asks for. JSON is externally tagged, e.g. `{"HlOrder":{...}}`.
/// Unknown fields are ignored: nothing the agent adds can reach the signed payload.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderRequest {
    HlOrder {
        market: String,
        is_buy: bool,
        limit_px: String,
        sz: String,
        reduce_only: bool,
        /// `"Gtc"` | `"Ioc"` | `"Alo"`.
        tif: String,
        nonce_ms: U64,
    },
    HlUpdateLeverage {
        market: String,
        is_cross: bool,
        leverage: u8,
        nonce_ms: U64,
    },
    EvmTransfer {
        /// Token symbol from the owner's list (not an address).
        token: String,
        /// Receiver: `0x`/`0X` + 40 hex, all lowercase, all uppercase or a valid EIP-55
        /// checksum. Receipts store a well-formed `to` as `0x` + 40 lowercase hex.
        to: String,
        amount: U128,
        nonce: U64,
        gas_limit: U64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    },
}

/// A proposal from an agent: `propose_order({"proposal": {...}})`.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub target: Target,
    pub order: OrderRequest,
    /// Free text, at most 140 bytes (UTF-8); recorded in the receipt, never signed.
    pub memo: Option<String>,
}

/// Receipt status. JSON: the variant name.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Blocked,
    PendingSignature,
    Signed,
    SignFailed,
}

/// A secp256k1 signature as `0x` + 64 lowercase hex for `r` and `s`.
/// `v` is 27/28 for Hyperliquid and the y-parity 0/1 for EIP-1559.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sig {
    pub r: String,
    pub s: String,
    pub v: u8,
}

/// One on-chain decision record.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    /// Starts at 1.
    pub id: U64,
    pub agent_id: AccountId,
    pub target: Target,
    /// The proposal as received, except that a well-formed EVM `to` is stored as `0x` + 40
    /// lowercase hex; for a blocked proposal, over-long strings are cut short (48 bytes each,
    /// memo 140 bytes, never inside a character).
    pub proposal: Proposal,
    pub status: Status,
    pub rule_code: Option<RuleCode>,
    pub message: String,
    /// `0x` + 64 hex: exactly what the MPC was asked to sign.
    pub payload_hash: Option<String>,
    /// HL: canonical action JSON. Base Sepolia: `0x` + unsigned EIP-1559 tx.
    pub signed_body: Option<String>,
    pub derivation_path: Option<String>,
    pub signature: Option<Sig>,
    pub rules_version: u32,
    pub block_height: U64,
    pub timestamp_ns: U64,
}

/// What `propose_order` returns (directly when blocked, from `on_signed` otherwise).
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    /// Id of the receipt, from 1. `"0"` = not stored because the contract kept its storage
    /// reserve (a blocked order when the balance is near the storage floor; the decision and the
    /// `order_blocked` event are still complete, and nothing is signed).
    pub receipt_id: U64,
    pub rule_code: Option<RuleCode>,
    pub message: String,
    pub signature: Option<Sig>,
}

/// `get_status` result.
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardStatus {
    pub owner: AccountId,
    pub guardian: Option<AccountId>,
    pub paused: bool,
    pub pause_reason: Option<String>,
    pub mpc_contract_id: AccountId,
    pub agents_count: u32,
    /// Receipts ever created (older ones may have left the ring buffer).
    pub receipts_count: U64,
}

/// `preview_payload` result: `{"Ok":"0x<payload_hash>"}` or `{"Err":"Blocked by your rule: …"}`.
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewResult {
    Ok(String),
    Err(String),
}
