//! Every user-facing string the contract produces, in one place.
//!
//! Decision messages are worded exactly `Blocked by your rule: <rule text>` or
//! `Allowed: within your limits`; `scripts/copy_lint.sh` scans this file for banned words.
//! Technical panics (`ERR_*`) are not receipts: they mean the caller is not allowed to act at
//! all, and nothing is stored.

use near_sdk::near;

use crate::order::Malformed;
use crate::types::Target;

/// Why an order was blocked. JSON: the `SCREAMING_SNAKE_CASE` code, e.g. `"DAILY_CAP"`.
///
/// Variants are declared in the fixed evaluation order of rules.rs (first failure wins);
/// `MarketNotAllowed` and `TokenNotAllowed` share step 6 and never apply to the same order.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleCode {
    Paused,
    Expired,
    TargetNotEnabled,
    Malformed,
    StaleNonce,
    MarketNotAllowed,
    TokenNotAllowed,
    ReceiverNotAllowed,
    LeverageAboveLimit,
    ReduceOnlyRequired,
    OrderAboveCap,
    DailyOrderCount,
    DailyCap,
    InsufficientContractBalance,
}

impl RuleCode {
    /// All codes, in evaluation order.
    pub const ALL: [Self; 14] = [
        Self::Paused,
        Self::Expired,
        Self::TargetNotEnabled,
        Self::Malformed,
        Self::StaleNonce,
        Self::MarketNotAllowed,
        Self::TokenNotAllowed,
        Self::ReceiverNotAllowed,
        Self::LeverageAboveLimit,
        Self::ReduceOnlyRequired,
        Self::OrderAboveCap,
        Self::DailyOrderCount,
        Self::DailyCap,
        Self::InsufficientContractBalance,
    ];

    /// The wire code, e.g. `"DAILY_CAP"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Paused => "PAUSED",
            Self::Expired => "EXPIRED",
            Self::TargetNotEnabled => "TARGET_NOT_ENABLED",
            Self::Malformed => "MALFORMED",
            Self::StaleNonce => "STALE_NONCE",
            Self::MarketNotAllowed => "MARKET_NOT_ALLOWED",
            Self::TokenNotAllowed => "TOKEN_NOT_ALLOWED",
            Self::ReceiverNotAllowed => "RECEIVER_NOT_ALLOWED",
            Self::LeverageAboveLimit => "LEVERAGE_ABOVE_LIMIT",
            Self::ReduceOnlyRequired => "REDUCE_ONLY_REQUIRED",
            Self::OrderAboveCap => "ORDER_ABOVE_CAP",
            Self::DailyOrderCount => "DAILY_ORDER_COUNT",
            Self::DailyCap => "DAILY_CAP",
            Self::InsufficientContractBalance => "INSUFFICIENT_CONTRACT_BALANCE",
        }
    }

    /// Step number in the evaluation order (1 = checked first).
    pub const fn step(self) -> u8 {
        match self {
            Self::Paused => 1,
            Self::Expired => 2,
            Self::TargetNotEnabled => 3,
            Self::Malformed => 4,
            Self::StaleNonce => 5,
            Self::MarketNotAllowed | Self::TokenNotAllowed => 6,
            Self::ReceiverNotAllowed => 7,
            Self::LeverageAboveLimit => 8,
            Self::ReduceOnlyRequired => 9,
            Self::OrderAboveCap => 10,
            Self::DailyOrderCount => 11,
            Self::DailyCap => 12,
            Self::InsufficientContractBalance => 13,
        }
    }
}

/// A blocked decision: the rule that failed and its exact message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocked {
    pub code: RuleCode,
    pub message: String,
}

/// Decision message of an order that passed every rule.
pub const ALLOWED: &str = "Allowed: within your limits";
/// Receipt message when every rule passed but the signature request did not produce a signature.
pub const NOT_SIGNED: &str = "Not signed: the signature request failed";

/// `signature_failed` event reason: the MPC call failed or timed out.
pub const REASON_SIGN_CALL_FAILED: &str = "the signature request did not complete";
/// `signature_failed` event reason: the MPC answered with something that is not a usable
/// secp256k1 signature.
pub const REASON_UNREADABLE_RESPONSE: &str = "the signature response could not be read";

const PREFIX: &str = "Blocked by your rule: ";

fn blocked(code: RuleCode, rule_text: &str) -> Blocked {
    Blocked {
        code,
        message: format!("{PREFIX}{rule_text}"),
    }
}

pub fn paused(reason: &str) -> Blocked {
    blocked(RuleCode::Paused, &format!("agent is paused ({reason})"))
}

pub fn expired() -> Blocked {
    blocked(RuleCode::Expired, "this agent's permission has expired")
}

pub fn target_not_enabled(target: Target) -> Blocked {
    blocked(
        RuleCode::TargetNotEnabled,
        &format!("{} is not enabled for this agent", target.as_str()),
    )
}

pub fn malformed(err: Malformed) -> Blocked {
    blocked(
        RuleCode::Malformed,
        &format!("orders must be well-formed ({})", err.0.as_str()),
    )
}

pub fn stale_nonce() -> Blocked {
    blocked(
        RuleCode::StaleNonce,
        "order time is outside the allowed window",
    )
}

/// `market` has passed [`crate::order::check_market`], so it is short and alphanumeric.
pub fn market_not_allowed(market: &str) -> Blocked {
    blocked(
        RuleCode::MarketNotAllowed,
        &format!("market {market} is not on your list"),
    )
}

/// `token` has passed [`crate::order::check_token`], so it is short and alphanumeric.
pub fn token_not_allowed(token: &str) -> Blocked {
    blocked(
        RuleCode::TokenNotAllowed,
        &format!("token {token} is not on your list"),
    )
}

/// `to` is the lowercase `0x` form of a parsed address.
pub fn receiver_not_allowed(to: &str) -> Blocked {
    blocked(
        RuleCode::ReceiverNotAllowed,
        &format!("receiver {to} is not on your list"),
    )
}

pub fn leverage_above_limit(leverage: u8, limit: u8) -> Blocked {
    blocked(
        RuleCode::LeverageAboveLimit,
        &format!("leverage {leverage}x is above your limit of {limit}x"),
    )
}

pub fn reduce_only_required() -> Blocked {
    blocked(
        RuleCode::ReduceOnlyRequired,
        "only reduce-only orders are allowed",
    )
}

pub fn order_above_cap() -> Blocked {
    blocked(RuleCode::OrderAboveCap, "order is above your per-order cap")
}

pub fn daily_order_count() -> Blocked {
    blocked(RuleCode::DailyOrderCount, "daily order count reached")
}

pub fn daily_cap() -> Blocked {
    blocked(
        RuleCode::DailyCap,
        "this order would go over your daily cap",
    )
}

pub fn insufficient_contract_balance() -> Blocked {
    blocked(
        RuleCode::InsufficientContractBalance,
        "guard has no balance to request a signature",
    )
}

// ---- Technical panics (no receipt; the call is rejected and nothing is stored) ----

pub const ERR_NOT_OWNER: &str = "ERR_NOT_OWNER";
pub const ERR_NOT_OWNER_OR_GUARDIAN: &str = "ERR_NOT_OWNER_OR_GUARDIAN";
pub const ERR_NOT_AGENT: &str = "ERR_NOT_AGENT";
pub const ERR_MAINNET_REFUSED: &str = "ERR_MAINNET_REFUSED";
pub const ERR_TOO_EARLY: &str = "ERR_TOO_EARLY";
pub const ERR_NO_PENDING_RULES: &str = "ERR_NO_PENDING_RULES";
pub const ERR_AGENT_EXISTS: &str = "ERR_AGENT_EXISTS";
pub const ERR_REASON_TOO_LONG: &str = "ERR_REASON_TOO_LONG";
pub const ERR_INVALID_RULES: &str = "ERR_INVALID_RULES";
pub const ERR_NOT_ENOUGH_GAS: &str = "ERR_NOT_ENOUGH_GAS";
/// `on_signed` ran for a receipt id that has no signature in flight. Only reachable if the
/// contract's own invariants are broken (the callback is `#[private]`).
pub const ERR_NO_PENDING_SIGNATURE: &str = "ERR_NO_PENDING_SIGNATURE";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::order::Field;

    /// Every message the contract can put in a receipt or event, with sample arguments.
    pub(crate) fn all_user_facing_strings() -> Vec<String> {
        let mut out: Vec<String> = vec![
            paused("watch: new full-access key"),
            expired(),
            target_not_enabled(Target::HlTestnet),
            target_not_enabled(Target::BaseSepolia),
            malformed(Malformed(Field::LimitPx)),
            stale_nonce(),
            market_not_allowed("DOGE"),
            token_not_allowed("WETH"),
            receiver_not_allowed("0xbad0000000000000000000000000000000000bad"),
            leverage_above_limit(50, 3),
            reduce_only_required(),
            order_above_cap(),
            daily_order_count(),
            daily_cap(),
            insufficient_contract_balance(),
        ]
        .into_iter()
        .map(|b| b.message)
        .collect();
        out.extend(
            [
                ALLOWED,
                NOT_SIGNED,
                REASON_SIGN_CALL_FAILED,
                REASON_UNREADABLE_RESPONSE,
            ]
            .map(String::from),
        );
        out
    }

    #[test]
    fn exact_decision_strings() {
        // The published decision strings, verbatim.
        let cases: &[(Blocked, RuleCode, &str)] = &[
            (
                paused("watch: new full-access key"),
                RuleCode::Paused,
                "Blocked by your rule: agent is paused (watch: new full-access key)",
            ),
            (
                expired(),
                RuleCode::Expired,
                "Blocked by your rule: this agent's permission has expired",
            ),
            (
                target_not_enabled(Target::BaseSepolia),
                RuleCode::TargetNotEnabled,
                "Blocked by your rule: BaseSepolia is not enabled for this agent",
            ),
            (
                malformed(Malformed(Field::Sz)),
                RuleCode::Malformed,
                "Blocked by your rule: orders must be well-formed (sz)",
            ),
            (
                stale_nonce(),
                RuleCode::StaleNonce,
                "Blocked by your rule: order time is outside the allowed window",
            ),
            (
                market_not_allowed("DOGE"),
                RuleCode::MarketNotAllowed,
                "Blocked by your rule: market DOGE is not on your list",
            ),
            (
                token_not_allowed("WETH"),
                RuleCode::TokenNotAllowed,
                "Blocked by your rule: token WETH is not on your list",
            ),
            (
                receiver_not_allowed("0xbad0000000000000000000000000000000000bad"),
                RuleCode::ReceiverNotAllowed,
                "Blocked by your rule: receiver 0xbad0000000000000000000000000000000000bad is not on your list",
            ),
            (
                leverage_above_limit(50, 3),
                RuleCode::LeverageAboveLimit,
                "Blocked by your rule: leverage 50x is above your limit of 3x",
            ),
            (
                reduce_only_required(),
                RuleCode::ReduceOnlyRequired,
                "Blocked by your rule: only reduce-only orders are allowed",
            ),
            (
                order_above_cap(),
                RuleCode::OrderAboveCap,
                "Blocked by your rule: order is above your per-order cap",
            ),
            (
                daily_order_count(),
                RuleCode::DailyOrderCount,
                "Blocked by your rule: daily order count reached",
            ),
            (
                daily_cap(),
                RuleCode::DailyCap,
                "Blocked by your rule: this order would go over your daily cap",
            ),
            (
                insufficient_contract_balance(),
                RuleCode::InsufficientContractBalance,
                "Blocked by your rule: guard has no balance to request a signature",
            ),
        ];
        for (blocked, code, message) in cases {
            assert_eq!(blocked.code, *code);
            assert_eq!(blocked.message, *message);
        }
        assert_eq!(ALLOWED, "Allowed: within your limits");
    }

    #[test]
    fn codes_serialize_as_wire_names_in_evaluation_order() {
        let mut last_step = 0;
        for code in RuleCode::ALL {
            let json = near_sdk::serde_json::to_string(&code).unwrap();
            assert_eq!(json, format!("\"{}\"", code.as_str()));
            let back: RuleCode = near_sdk::serde_json::from_str(&json).unwrap();
            assert_eq!(back, code);
            assert!(code.step() >= last_step, "{code:?} out of order");
            last_step = code.step();
        }
        assert_eq!(RuleCode::InsufficientContractBalance.step(), 13);
    }

    #[test]
    fn copy_rules_hold_for_every_message() {
        // Copy rule: no verdict or token-sale words in anything users see.
        let banned = [
            "safe",
            "scam",
            "malicious",
            "secure",
            "presale",
            "staking",
            "airdrop",
            "$rclaw",
            "price target",
        ];
        for message in all_user_facing_strings() {
            let lower = message.to_lowercase();
            for word in banned {
                assert!(!lower.contains(word), "{message:?} contains {word:?}");
            }
            assert!(
                !message.contains('$'),
                "{message:?} contains a currency sign"
            );
            assert!(
                !lower
                    .split(|c: char| !c.is_ascii_alphanumeric())
                    .any(|w| w == "usd"),
                "{message:?} contains USD"
            );
        }
        for message in all_user_facing_strings() {
            if message != ALLOWED
                && !message.starts_with("Not signed")
                && !message.starts_with("the ")
            {
                assert!(message.starts_with(PREFIX), "{message:?}");
            }
        }
    }
}
