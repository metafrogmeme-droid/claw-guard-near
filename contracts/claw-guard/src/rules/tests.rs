//! Unit tests for the pure rule model: every rule code (blocked + boundary), the
//! fixed evaluation order, day rollover, rules validation and tighten-vs-loosen per field.

use near_sdk::json_types::{U64, U128};

use super::*;
use crate::errors::RuleCode;
use crate::test_fixtures::*;
use crate::types::{AgentState, OrderRequest, Proposal, Rules, Target};

const BYTE_COST: u128 = 10_000_000_000_000_000_000; // 1e19 yocto per byte
const STORAGE: u64 = 300_000;

fn ctx() -> EvalContext<'static> {
    EvalContext {
        paused: false,
        pause_reason: "",
        now_ns: NOW_NS,
        account_balance: 100 * 10u128.pow(24),
        storage_usage: STORAGE,
        storage_byte_cost: BYTE_COST,
        sign_deposit: 1,
    }
}

fn agent() -> AgentState {
    AgentState::new(rules(), day_of(NOW_NS))
}

fn agent_with(rules: Rules) -> AgentState {
    AgentState::new(rules, day_of(NOW_NS))
}

fn eval(agent: &AgentState, proposal: &Proposal) -> Result<Approved, Blocked> {
    evaluate(agent, &ctx(), proposal)
}

#[track_caller]
fn assert_blocked(result: Result<Approved, Blocked>, code: RuleCode, message: &str) {
    match result {
        Ok(approved) => panic!("expected {code:?}, got allowed {approved:?}"),
        Err(blocked) => {
            assert_eq!(blocked.code, code, "{}", blocked.message);
            assert_eq!(blocked.message, message);
        }
    }
}

#[track_caller]
fn assert_code(result: Result<Approved, Blocked>, code: RuleCode) {
    match result {
        Ok(approved) => panic!("expected {code:?}, got allowed {approved:?}"),
        Err(blocked) => assert_eq!(blocked.code, code, "{}", blocked.message),
    }
}

#[track_caller]
fn assert_allowed(result: Result<Approved, Blocked>) -> Approved {
    result.unwrap_or_else(|blocked| panic!("expected allowed, got {blocked:?}"))
}

fn with_order(mut proposal: Proposal, edit: impl FnOnce(&mut OrderRequest)) -> Proposal {
    edit(&mut proposal.order);
    proposal
}

// ---- allowed paths ---------------------------------------------------------------------------

#[test]
fn allowed_orders_carry_path_spend_and_nonce() {
    let a = agent();
    let order = assert_allowed(eval(&a, &small_btc(NOW_MS)));
    assert_eq!(order.target, Target::HlTestnet);
    assert_eq!(order.derivation_path, "hl-testnet-1");
    assert_eq!(order.spend, 1_000_000);
    assert_eq!(order.nonce, Nonce::Hl(NOW_MS));
    assert!(
        order
            .signed_body
            .starts_with(r#"{"type":"order","orders":[{"a":3,"#)
    );

    let lev = assert_allowed(eval(&a, &hl_leverage("ETH", 3, NOW_MS)));
    assert_eq!(lev.spend, 0);
    assert_eq!(
        lev.signed_body,
        r#"{"type":"updateLeverage","asset":4,"isCross":true,"leverage":3}"#
    );

    let evm = assert_allowed(eval(&a, &transfer(OWNER_ADDR, 1_000_000, 0)));
    assert_eq!(evm.target, Target::BaseSepolia);
    assert_eq!(evm.derivation_path, "base-sepolia-1");
    assert_eq!(evm.spend, 1_000_000);
    assert_eq!(evm.nonce, Nonce::Evm(0));
    assert!(evm.signed_body.starts_with("0x02"));
}

// ---- 1 PAUSED ----------------------------------------------------------------------------------

#[test]
fn paused_blocks_everything() {
    let a = agent();
    let ctx = EvalContext {
        paused: true,
        pause_reason: "watch: new full-access key",
        ..ctx()
    };
    for proposal in [
        small_btc(NOW_MS),
        hl_leverage("BTC", 1, NOW_MS),
        transfer(OWNER_ADDR, 1, 0),
    ] {
        assert_blocked(
            evaluate(&a, &ctx, &proposal),
            RuleCode::Paused,
            "Blocked by your rule: agent is paused (watch: new full-access key)",
        );
    }
}

// ---- 2 EXPIRED ---------------------------------------------------------------------------------

#[test]
fn expiry_boundary() {
    let mut r = rules();
    r.expires_at_ns = U64(NOW_NS);
    let a = agent_with(r);
    // Exactly at the expiry: still allowed. One nanosecond later: blocked.
    assert_allowed(eval(&a, &small_btc(NOW_MS)));
    let later = EvalContext {
        now_ns: NOW_NS + 1,
        ..ctx()
    };
    assert_blocked(
        evaluate(&a, &later, &small_btc(NOW_MS)),
        RuleCode::Expired,
        "Blocked by your rule: this agent's permission has expired",
    );
}

// ---- 3 TARGET_NOT_ENABLED ----------------------------------------------------------------------

#[test]
fn target_not_enabled() {
    let mut r = rules();
    r.targets = vec![Target::HlTestnet];
    let a = agent_with(r);
    assert_allowed(eval(&a, &small_btc(NOW_MS)));
    assert_blocked(
        eval(&a, &transfer(OWNER_ADDR, 1, 0)),
        RuleCode::TargetNotEnabled,
        "Blocked by your rule: BaseSepolia is not enabled for this agent",
    );
    let mut r = rules();
    r.targets = vec![Target::BaseSepolia];
    assert_blocked(
        eval(&agent_with(r), &small_btc(NOW_MS)),
        RuleCode::TargetNotEnabled,
        "Blocked by your rule: HlTestnet is not enabled for this agent",
    );
}

// ---- 4 MALFORMED -------------------------------------------------------------------------------

#[test]
fn malformed_names_the_field() {
    let a = agent();
    let hl = small_btc(NOW_MS);
    let set_hl = |field: &str, value: &str| {
        with_order(hl.clone(), |o| {
            if let OrderRequest::HlOrder {
                market,
                limit_px,
                sz,
                tif,
                ..
            } = o
            {
                match field {
                    "market" => *market = value.to_owned(),
                    "limit_px" => *limit_px = value.to_owned(),
                    "sz" => *sz = value.to_owned(),
                    "tif" => *tif = value.to_owned(),
                    _ => unreachable!(),
                }
            }
        })
    };
    let evm = transfer(OWNER_ADDR, 1, 0);
    let set_evm = |edit: &dyn Fn(&mut OrderRequest)| with_order(evm.clone(), edit);
    let with_memo = |mut p: Proposal, memo: String| {
        p.memo = Some(memo);
        p
    };

    let cases: Vec<(Proposal, &str)> = vec![
        (set_hl("market", "BTC-PERP"), "market"),
        (set_hl("market", ""), "market"),
        (set_hl("market", &"B".repeat(17)), "market"),
        (set_hl("limit_px", "0.010"), "limit_px"),
        (set_hl("limit_px", "1e3"), "limit_px"),
        (set_hl("limit_px", "-1"), "limit_px"),
        (set_hl("limit_px", ".5"), "limit_px"),
        (set_hl("limit_px", "01"), "limit_px"),
        (set_hl("limit_px", "123.456"), "limit_px"), // 6 significant figures
        (set_hl("sz", "0.000000001"), "sz"),         // 9 decimals
        (set_hl("sz", "0"), "sz"),
        (set_hl("tif", "GTC"), "tif"),
        (
            hl_order("BTC", "100000000000000000000", "100000000000", NOW_MS),
            "notional",
        ),
        (hl_leverage("BTC", 0, NOW_MS), "leverage"),
        (hl_leverage("BTC USD", 1, NOW_MS), "market"),
        (
            set_evm(&|o| {
                if let OrderRequest::EvmTransfer { token, .. } = o {
                    *token = "US DC".to_owned();
                }
            }),
            "token",
        ),
        (transfer("0xBAD", 1, 0), "to"),
        (transfer(OWNER_ADDR, 0, 0), "amount"),
        (
            transfer(OWNER_ADDR, 1, crate::order::MAX_EVM_NONCE + 1),
            "nonce",
        ),
        (transfer(OWNER_ADDR, 1, u64::MAX), "nonce"),
        (
            set_evm(&|o| {
                if let OrderRequest::EvmTransfer { gas_limit, .. } = o {
                    *gas_limit = U64(20_999);
                }
            }),
            "gas_limit",
        ),
        (
            set_evm(&|o| {
                if let OrderRequest::EvmTransfer {
                    max_fee_per_gas, ..
                } = o
                {
                    *max_fee_per_gas = U128(100_000_000_001);
                }
            }),
            "max_fee_per_gas",
        ),
        (
            set_evm(&|o| {
                if let OrderRequest::EvmTransfer {
                    max_priority_fee_per_gas,
                    ..
                } = o
                {
                    *max_priority_fee_per_gas = U128(1_000_000_001);
                }
            }),
            "max_priority_fee_per_gas",
        ),
        (with_memo(small_btc(NOW_MS), "m".repeat(141)), "memo"),
        (
            with_memo(transfer(OWNER_ADDR, 1, 0), "m".repeat(141)),
            "memo",
        ),
    ];
    for (proposal, field) in cases {
        assert_blocked(
            eval(&a, &proposal),
            RuleCode::Malformed,
            &format!("Blocked by your rule: orders must be well-formed ({field})"),
        );
    }
    // Boundaries: a 140-character memo and a 16-character market name are well-formed (the
    // market then simply is not on the list).
    assert_allowed(eval(&a, &with_memo(small_btc(NOW_MS), "m".repeat(140))));
    assert_code(
        eval(&a, &set_hl("market", &"B".repeat(16))),
        RuleCode::MarketNotAllowed,
    );
}

#[test]
fn target_and_order_kind_must_match() {
    let a = agent();
    let mut hl_on_base = small_btc(NOW_MS);
    hl_on_base.target = Target::BaseSepolia;
    let mut evm_on_hl = transfer(OWNER_ADDR, 1, 0);
    evm_on_hl.target = Target::HlTestnet;
    let mut lev_on_base = hl_leverage("BTC", 1, NOW_MS);
    lev_on_base.target = Target::BaseSepolia;
    for proposal in [hl_on_base, evm_on_hl, lev_on_base] {
        assert_blocked(
            eval(&a, &proposal),
            RuleCode::Malformed,
            "Blocked by your rule: orders must be well-formed (order)",
        );
    }
}

// ---- 4 MALFORMED: the market's size and price decimals ----------------------------------------

#[track_caller]
fn assert_malformed(result: Result<Approved, Blocked>, field: &str) {
    assert_blocked(
        result,
        RuleCode::Malformed,
        &format!("Blocked by your rule: orders must be well-formed ({field})"),
    );
}

/// The fixture rules with BTC set to `sz_decimals` (and a cap that has no more decimals).
fn btc_with_sz_decimals(sz_decimals: u8, max_order_sz: &str) -> AgentState {
    let mut r = rules();
    r.markets[0] = market("BTC", BTC_ASSET, max_order_sz, sz_decimals);
    assert_eq!(validate_rules(&r), Ok(()));
    agent_with(r)
}

#[test]
fn sz_decimals_bound_the_size() {
    let a = agent();
    // BTC: 5 size decimals. Exactly 5 allowed, 6 malformed.
    assert_allowed(eval(&a, &hl_order("BTC", "1000", "0.00001", NOW_MS)));
    assert_allowed(eval(&a, &hl_order("BTC", "1000", "0.00123", NOW_MS)));
    assert_malformed(eval(&a, &hl_order("BTC", "1000", "0.000001", NOW_MS)), "sz");
    assert_malformed(eval(&a, &hl_order("BTC", "1000", "0.001234", NOW_MS)), "sz");
    // ETH: 4.
    assert_allowed(eval(&a, &hl_order("ETH", "1000", "0.0001", NOW_MS)));
    assert_malformed(eval(&a, &hl_order("ETH", "1000", "0.00001", NOW_MS)), "sz");
    // 0 size decimals: whole coins only.
    let whole = btc_with_sz_decimals(0, "1");
    assert_allowed(eval(&whole, &hl_order("BTC", "1000", "1", NOW_MS)));
    assert_malformed(eval(&whole, &hl_order("BTC", "1000", "0.5", NOW_MS)), "sz");
    // 6 size decimals (the largest): 6 allowed, 7 malformed.
    let fine = btc_with_sz_decimals(6, "0.01");
    assert_allowed(eval(&fine, &hl_order("BTC", "1000", "0.000001", NOW_MS)));
    assert_malformed(
        eval(&fine, &hl_order("BTC", "1000", "0.0000001", NOW_MS)),
        "sz",
    );
}

#[test]
fn sz_decimals_bound_the_price_decimals() {
    let a = agent();
    // BTC (5 size decimals): prices may have 6 - 5 = 1 decimal.
    assert_allowed(eval(&a, &hl_order("BTC", "1000.5", "0.001", NOW_MS)));
    assert_malformed(
        eval(&a, &hl_order("BTC", "100.25", "0.001", NOW_MS)),
        "limit_px",
    );
    // ETH (4 size decimals): 2 price decimals, so the same price is fine there.
    assert_allowed(eval(&a, &hl_order("ETH", "100.25", "0.001", NOW_MS)));
    assert_malformed(
        eval(&a, &hl_order("ETH", "10.125", "0.001", NOW_MS)),
        "limit_px",
    );
    // Integer prices always pass, even with 6 size decimals (no price decimals left), and
    // whatever their significant figures.
    let fine = btc_with_sz_decimals(6, "0.01");
    assert_allowed(eval(&fine, &hl_order("BTC", "1000", "0.000001", NOW_MS)));
    assert_allowed(eval(&fine, &hl_order("BTC", "123456", "0.000001", NOW_MS)));
    assert_malformed(
        eval(&fine, &hl_order("BTC", "1000.5", "0.001", NOW_MS)),
        "limit_px",
    );
    // 0 size decimals: 6 price decimals allowed, 7 malformed; 5 significant figures still apply.
    let whole = btc_with_sz_decimals(0, "1");
    assert_allowed(eval(&whole, &hl_order("BTC", "0.012345", "1", NOW_MS)));
    assert_malformed(
        eval(&whole, &hl_order("BTC", "0.0012345", "1", NOW_MS)),
        "limit_px",
    );
    assert_malformed(
        eval(&whole, &hl_order("BTC", "0.123456", "1", NOW_MS)),
        "limit_px",
    );
}

#[test]
fn decimal_checks_keep_the_field_order() {
    let a = agent();
    // Price and size both too fine for BTC: limit_px is checked first.
    assert_malformed(
        eval(&a, &hl_order("BTC", "100.25", "0.000001", NOW_MS)),
        "limit_px",
    );
    // Size before tif.
    let p = with_order(hl_order("BTC", "1000", "0.000001", NOW_MS), |o| {
        if let OrderRequest::HlOrder { tif, .. } = o {
            *tif = "GTC".into();
        }
    });
    assert_malformed(eval(&a, &p), "sz");
}

#[test]
fn too_many_decimals_is_reported_before_a_stale_nonce() {
    let mut a = agent();
    a.last_hl_nonce_ms = Some(U64(NOW_MS));
    assert_code(eval(&a, &small_btc(NOW_MS)), RuleCode::StaleNonce);
    // Step 4 comes before step 5: an order that is both too fine and stale is MALFORMED.
    assert_malformed(eval(&a, &hl_order("BTC", "1000", "0.000001", NOW_MS)), "sz");
    assert_malformed(
        eval(&a, &hl_order("BTC", "100.25", "0.001", NOW_MS)),
        "limit_px",
    );
    // Also when the nonce is outside the ±5 min window.
    assert_malformed(eval(&a, &hl_order("BTC", "1000", "0.000001", 0)), "sz");
}

#[test]
fn unlisted_market_with_bad_decimals_is_market_not_allowed() {
    let a = agent();
    // DOGE is not on the list, so there is no size precision to check against: step 6 decides.
    assert_blocked(
        eval(&a, &hl_order("DOGE", "0.0012345", "0.12345678", NOW_MS)),
        RuleCode::MarketNotAllowed,
        "Blocked by your rule: market DOGE is not on your list",
    );
    // A listed name in the wrong case matches no market either.
    assert_code(
        eval(&a, &hl_order("btc", "100.25", "0.000001", NOW_MS)),
        RuleCode::MarketNotAllowed,
    );
    // The generic format is still checked first.
    assert_malformed(
        eval(&a, &hl_order("DOGE", "0.1", "0.123456789", NOW_MS)),
        "sz",
    );
}

#[test]
fn unlisted_market_borrows_no_precision_and_keeps_the_step_order() {
    let mut a = agent();
    // Finer than both listed markets (BTC 5, ETH 4) but a valid generic format: no listed
    // market's precision applies to DOGE, so step 5 (nonce) and then step 6 decide.
    let doge = |nonce_ms| hl_order("DOGE", "100.25", "0.000001", nonce_ms);
    assert_code(eval(&a, &doge(NOW_MS)), RuleCode::MarketNotAllowed);
    a.last_hl_nonce_ms = Some(U64(NOW_MS));
    assert_code(eval(&a, &doge(NOW_MS)), RuleCode::StaleNonce);
    assert_code(eval(&a, &doge(0)), RuleCode::StaleNonce);
    // The same fields on a listed market are step 4, before the stale nonce.
    assert_malformed(eval(&a, &hl_order("BTC", "1000", "0.000001", NOW_MS)), "sz");
}

#[test]
fn leverage_updates_ignore_sz_decimals() {
    for sz_decimals in [0, 6] {
        let a = btc_with_sz_decimals(sz_decimals, "1");
        assert_allowed(eval(&a, &hl_leverage("BTC", MAX_LEVERAGE, NOW_MS)));
    }
}

// ---- 5 STALE_NONCE -----------------------------------------------------------------------------

#[test]
fn hl_nonce_window_is_five_minutes_each_way() {
    let a = agent();
    for nonce in [NOW_MS - 300_000, NOW_MS + 300_000] {
        assert_allowed(eval(&a, &small_btc(nonce)));
        assert_allowed(eval(&a, &hl_leverage("BTC", 1, nonce)));
    }
    for nonce in [NOW_MS - 300_001, NOW_MS + 300_001, 0, u64::MAX] {
        assert_blocked(
            eval(&a, &small_btc(nonce)),
            RuleCode::StaleNonce,
            "Blocked by your rule: order time is outside the allowed window",
        );
        assert_code(
            eval(&a, &hl_leverage("BTC", 1, nonce)),
            RuleCode::StaleNonce,
        );
    }
}

#[test]
fn nonces_strictly_increase_per_agent() {
    let mut a = agent();
    a.reserve(day_of(NOW_NS), 0, Nonce::Hl(NOW_MS));
    assert_code(eval(&a, &small_btc(NOW_MS)), RuleCode::StaleNonce);
    assert_code(eval(&a, &small_btc(NOW_MS - 1)), RuleCode::StaleNonce);
    // HL orders and leverage updates share the signer, so they share the nonce floor.
    assert_code(
        eval(&a, &hl_leverage("BTC", 1, NOW_MS)),
        RuleCode::StaleNonce,
    );
    assert_allowed(eval(&a, &small_btc(NOW_MS + 1)));

    // EVM: any first nonce, then strictly greater.
    assert_allowed(eval(&a, &transfer(OWNER_ADDR, 1, 0)));
    a.reserve(day_of(NOW_NS), 1, Nonce::Evm(7));
    assert_code(eval(&a, &transfer(OWNER_ADDR, 1, 7)), RuleCode::StaleNonce);
    assert_code(eval(&a, &transfer(OWNER_ADDR, 1, 6)), RuleCode::StaleNonce);
    assert_allowed(eval(&a, &transfer(OWNER_ADDR, 1, 8)));
    // The EVM nonce does not move the HL floor and vice versa.
    assert_allowed(eval(&a, &small_btc(NOW_MS + 1)));
}

/// Regression: an EVM nonce the relayer cannot carry (above 2^53 - 1, including the
/// EIP-2681-invalid 2^64 - 1) used to be signed and then raised the agent's EVM nonce floor past
/// every nonce it could still use. It is now `MALFORMED(nonce)`: nothing is signed, nothing is
/// reserved, and the next honest nonce is still allowed.
#[test]
fn evm_nonce_above_relayer_range_is_malformed_and_keeps_the_floor() {
    use crate::order::MAX_EVM_NONCE;
    let a = agent();
    for nonce in [MAX_EVM_NONCE + 1, (1 << 53) + 1, u64::MAX - 1, u64::MAX] {
        assert_blocked(
            eval(&a, &transfer(OWNER_ADDR, 1, nonce)),
            RuleCode::Malformed,
            "Blocked by your rule: orders must be well-formed (nonce)",
        );
    }
    assert_eq!(a.last_evm_nonce, None);
    assert_allowed(eval(&a, &transfer(OWNER_ADDR, 1, 0)));
    // The largest accepted nonce is allowed, and its signed body still carries it.
    let top = assert_allowed(eval(&a, &transfer(OWNER_ADDR, 1, MAX_EVM_NONCE)));
    assert_eq!(top.nonce, Nonce::Evm(MAX_EVM_NONCE));
    // Malformed is checked before the nonce floor: above the bound it stays MALFORMED.
    let mut used = agent();
    used.reserve(day_of(NOW_NS), 1, Nonce::Evm(MAX_EVM_NONCE));
    assert_code(
        eval(&used, &transfer(OWNER_ADDR, 1, u64::MAX)),
        RuleCode::Malformed,
    );
}

// ---- 6 MARKET_NOT_ALLOWED / TOKEN_NOT_ALLOWED ---------------------------------------------------

#[test]
fn market_and_token_allowlists() {
    let a = agent();
    assert_blocked(
        eval(&a, &hl_order("DOGE", "0.1", "100", NOW_MS)),
        RuleCode::MarketNotAllowed,
        "Blocked by your rule: market DOGE is not on your list",
    );
    // Exact, case-sensitive names.
    assert_code(
        eval(&a, &hl_order("btc", "1000", "0.001", NOW_MS)),
        RuleCode::MarketNotAllowed,
    );
    assert_blocked(
        eval(&a, &hl_leverage("DOGE", 50, NOW_MS)),
        RuleCode::MarketNotAllowed,
        "Blocked by your rule: market DOGE is not on your list",
    );
    let mut weth = transfer(OWNER_ADDR, 1, 0);
    if let OrderRequest::EvmTransfer { token, .. } = &mut weth.order {
        *token = "WETH".to_owned();
    }
    assert_blocked(
        eval(&a, &weth),
        RuleCode::TokenNotAllowed,
        "Blocked by your rule: token WETH is not on your list",
    );
}

// ---- 7 RECEIVER_NOT_ALLOWED --------------------------------------------------------------------

#[test]
fn receiver_allowlist_compares_lowercased() {
    let a = agent();
    assert_blocked(
        eval(
            &a,
            &transfer("0xBAD0000000000000000000000000000000000BAD", 1, 0),
        ),
        RuleCode::ReceiverNotAllowed,
        "Blocked by your rule: receiver 0xbad0000000000000000000000000000000000bad is not on your list",
    );
    let upper = format!("0x{}", OWNER_ADDR[2..].to_uppercase());
    assert_allowed(eval(&a, &transfer(&upper, 1, 0)));
}

/// EIP-55 test address from the specification, and its lowercase form.
const SPEC_ADDR: &str = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SPEC_ADDR_LOWER: &str = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
/// Base Sepolia USDC with its EIP-55 checksum (eth_utils).
const USDC_ADDR_CHECKSUM: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

#[test]
fn receiver_accepts_checksum_upper_and_0x_upper_prefix() {
    let mut r = rules();
    r.receivers.push(SPEC_ADDR_LOWER.into());
    let a = agent_with(r);
    let upper = format!("0X{}", SPEC_ADDR_LOWER[2..].to_uppercase());
    for to in [
        SPEC_ADDR,
        SPEC_ADDR_LOWER,
        &upper,
        &format!("0X{}", &SPEC_ADDR[2..]),
    ] {
        let approved = assert_allowed(eval(&a, &transfer(to, 1, 0)));
        assert!(approved.signed_body.contains(&SPEC_ADDR_LOWER[2..]), "{to}");
    }
    // A wrong checksum (one letter's case flipped) is malformed, not silently lowercased.
    assert_malformed(
        eval(
            &a,
            &transfer("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", 1, 0),
        ),
        "to",
    );
    // A blocked receiver is quoted in lowercase, whatever case the agent sent.
    assert_blocked(
        eval(
            &a,
            &transfer("0xBAd0000000000000000000000000000000000Bad", 1, 0),
        ),
        RuleCode::ReceiverNotAllowed,
        "Blocked by your rule: receiver 0xbad0000000000000000000000000000000000bad is not on your list",
    );
}

#[test]
fn receiver_comparison_ignores_the_case_stored_in_rules() {
    // Stored rules are always normalized; evaluation still compares bytes, not strings.
    let mut r = rules();
    r.receivers = vec![SPEC_ADDR.into()];
    let a = agent_with(r);
    assert_allowed(eval(&a, &transfer(SPEC_ADDR_LOWER, 1, 0)));
    // An unparsable stored receiver matches nothing (fail closed).
    let mut r = rules();
    r.receivers = vec!["0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed".into()];
    assert_code(
        eval(&agent_with(r), &transfer(SPEC_ADDR_LOWER, 1, 0)),
        RuleCode::ReceiverNotAllowed,
    );
}

// ---- 8 LEVERAGE_ABOVE_LIMIT --------------------------------------------------------------------

#[test]
fn leverage_boundary() {
    let a = agent();
    assert_allowed(eval(&a, &hl_leverage("BTC", MAX_LEVERAGE, NOW_MS)));
    assert_blocked(
        eval(&a, &hl_leverage("BTC", MAX_LEVERAGE + 1, NOW_MS)),
        RuleCode::LeverageAboveLimit,
        "Blocked by your rule: leverage 4x is above your limit of 3x",
    );
    assert_blocked(
        eval(&a, &hl_leverage("BTC", 50, NOW_MS)),
        RuleCode::LeverageAboveLimit,
        "Blocked by your rule: leverage 50x is above your limit of 3x",
    );
}

// ---- 9 REDUCE_ONLY_REQUIRED --------------------------------------------------------------------

#[test]
fn reduce_only_required() {
    let mut r = rules();
    r.reduce_only_required = true;
    let a = agent_with(r);
    assert_blocked(
        eval(&a, &small_btc(NOW_MS)),
        RuleCode::ReduceOnlyRequired,
        "Blocked by your rule: only reduce-only orders are allowed",
    );
    let reduce = with_order(small_btc(NOW_MS), |o| {
        if let OrderRequest::HlOrder { reduce_only, .. } = o {
            *reduce_only = true;
        }
    });
    assert_allowed(eval(&a, &reduce));
    // Applies to HL orders only.
    assert_allowed(eval(&a, &hl_leverage("BTC", 1, NOW_MS)));
    assert_allowed(eval(&a, &transfer(OWNER_ADDR, 1, 0)));
}

// ---- 10 ORDER_ABOVE_CAP ------------------------------------------------------------------------

#[test]
fn per_order_size_cap_boundary() {
    let a = agent();
    // BTC cap 0.01 with 5 size decimals: exactly at the cap allowed, one size step (0.00001)
    // above blocked.
    assert_allowed(eval(&a, &hl_order("BTC", "1000", "0.01", NOW_MS)));
    assert_blocked(
        eval(&a, &hl_order("BTC", "1000", "0.01001", NOW_MS)),
        RuleCode::OrderAboveCap,
        "Blocked by your rule: order is above your per-order cap",
    );
    // One 1e-8 unit above the cap is finer than BTC sizes go: malformed (step 4) before the cap.
    assert_blocked(
        eval(&a, &hl_order("BTC", "1000", "0.01000001", NOW_MS)),
        RuleCode::Malformed,
        "Blocked by your rule: orders must be well-formed (sz)",
    );
    // With the finest size step HL allows (`sz_decimals` 6): cap + 0.000001 is above the cap.
    let mut r = rules();
    r.markets[0].sz_decimals = 6;
    let fine = agent_with(r);
    assert_allowed(eval(&fine, &hl_order("BTC", "1000", "0.01", NOW_MS)));
    assert_code(
        eval(&fine, &hl_order("BTC", "1000", "0.010001", NOW_MS)),
        RuleCode::OrderAboveCap,
    );
    assert_code(
        eval(&a, &hl_order("BTC", "1000", "5", NOW_MS)),
        RuleCode::OrderAboveCap,
    );
}

#[test]
fn per_order_notional_cap_boundary() {
    let a = agent();
    // 0.01 × 100000 = 1000 quote units = MAX_NOTIONAL exactly.
    let at_cap = assert_allowed(eval(&a, &hl_order("BTC", "100000", "0.01", NOW_MS)));
    assert_eq!(at_cap.spend, MAX_NOTIONAL);
    // 0.01 × 100001 = 1000.01 quote units: above the cap.
    assert_code(
        eval(&a, &hl_order("BTC", "100001", "0.01", NOW_MS)),
        RuleCode::OrderAboveCap,
    );
    // Exactly one 1e-6 unit above the cap.
    let mut r = rules();
    r.max_order_notional = U128(MAX_NOTIONAL - 1);
    assert_code(
        eval(&agent_with(r), &hl_order("BTC", "100000", "0.01", NOW_MS)),
        RuleCode::OrderAboveCap,
    );
}

#[test]
fn per_transfer_token_cap_boundary() {
    let a = agent();
    assert_allowed(eval(&a, &transfer(OWNER_ADDR, USDC_CAP, 0)));
    assert_blocked(
        eval(&a, &transfer(OWNER_ADDR, USDC_CAP + 1, 0)),
        RuleCode::OrderAboveCap,
        "Blocked by your rule: order is above your per-order cap",
    );
}

// ---- 11 DAILY_ORDER_COUNT ----------------------------------------------------------------------

#[test]
fn daily_order_count_boundary() {
    let mut a = agent();
    a.orders_today = MAX_ORDERS - 1;
    assert_allowed(eval(&a, &small_btc(NOW_MS)));
    a.orders_today = MAX_ORDERS;
    for proposal in [
        small_btc(NOW_MS),
        hl_leverage("BTC", 1, NOW_MS),
        transfer(OWNER_ADDR, 1, 0),
    ] {
        assert_blocked(
            eval(&a, &proposal),
            RuleCode::DailyOrderCount,
            "Blocked by your rule: daily order count reached",
        );
    }
}

// ---- 12 DAILY_CAP ------------------------------------------------------------------------------

#[test]
fn daily_cap_boundary() {
    let mut a = agent();
    // 1 quote unit per order (1_000_000).
    a.spent_today = U128(DAILY_CAP - 1_000_000);
    assert_allowed(eval(&a, &small_btc(NOW_MS)));
    a.spent_today = U128(DAILY_CAP - 999_999);
    assert_blocked(
        eval(&a, &small_btc(NOW_MS)),
        RuleCode::DailyCap,
        "Blocked by your rule: this order would go over your daily cap",
    );
    // One counter across targets: a transfer counts against the same cap.
    assert_code(
        eval(&a, &transfer(OWNER_ADDR, 1_000_000, 0)),
        RuleCode::DailyCap,
    );
    assert_allowed(eval(&a, &transfer(OWNER_ADDR, 999_999, 0)));
    // A leverage update spends nothing.
    a.spent_today = U128(DAILY_CAP);
    assert_allowed(eval(&a, &hl_leverage("BTC", 1, NOW_MS)));
}

#[test]
fn daily_cap_overflow_blocks() {
    let mut r = rules();
    r.daily_cap = U128(u128::MAX);
    r.tokens[0].max_per_order = U128(u128::MAX);
    let mut a = agent_with(r);
    assert_allowed(eval(&a, &transfer(OWNER_ADDR, u128::MAX, 0)));
    a.spent_today = U128(1);
    assert_code(
        eval(&a, &transfer(OWNER_ADDR, u128::MAX, 0)),
        RuleCode::DailyCap,
    );
}

// ---- 13 INSUFFICIENT_CONTRACT_BALANCE ----------------------------------------------------------

#[test]
fn contract_balance_boundary() {
    let a = agent();
    let needed = u128::from(STORAGE + RECEIPT_STORAGE_RESERVE_BYTES) * BYTE_COST + 1;
    let with_balance = |account_balance| EvalContext {
        account_balance,
        ..ctx()
    };
    assert_allowed(evaluate(&a, &with_balance(needed), &small_btc(NOW_MS)));
    assert_blocked(
        evaluate(&a, &with_balance(needed - 1), &small_btc(NOW_MS)),
        RuleCode::InsufficientContractBalance,
        "Blocked by your rule: guard has no balance to request a signature",
    );
    // A deposit or byte cost so large the sum overflows: blocked, not wrapped.
    let huge = EvalContext {
        sign_deposit: u128::MAX,
        ..ctx()
    };
    assert_code(
        evaluate(&a, &huge, &small_btc(NOW_MS)),
        RuleCode::InsufficientContractBalance,
    );
    let huge = EvalContext {
        storage_byte_cost: u128::MAX,
        ..ctx()
    };
    assert_code(
        evaluate(&a, &huge, &transfer(OWNER_ADDR, 1, 0)),
        RuleCode::InsufficientContractBalance,
    );
}

/// Blocked receipts keep the same storage reserve, without the sign deposit (Q-44).
#[test]
fn receipt_reserve_boundary() {
    let floor = u128::from(STORAGE + RECEIPT_STORAGE_RESERVE_BYTES) * BYTE_COST;
    let with_balance = |account_balance| EvalContext {
        account_balance,
        ..ctx()
    };
    assert!(keeps_receipt_reserve(&with_balance(floor)));
    assert!(!keeps_receipt_reserve(&with_balance(floor - 1)));
    // Overflow counts as not enough.
    let huge = EvalContext {
        account_balance: u128::MAX,
        storage_byte_cost: u128::MAX,
        ..ctx()
    };
    assert!(!keeps_receipt_reserve(&huge));
}

// ---- evaluation order --------------------------------------------------------------------------

/// Starts with an order that breaks every rule it can, then fixes one rule at a time: each
/// step must report exactly the next rule in the evaluation order.
#[test]
fn first_failure_wins_in_evaluation_order() {
    // HL order: steps 1-6, 9-13 (no receiver or leverage rule for orders).
    let mut r = rules();
    r.expires_at_ns = U64(NOW_NS - 1);
    r.targets = vec![Target::BaseSepolia];
    r.reduce_only_required = true;
    let mut a = agent_with(r);
    a.orders_today = MAX_ORDERS;
    a.spent_today = U128(DAILY_CAP);
    a.last_hl_nonce_ms = Some(U64(NOW_MS));
    let mut c = EvalContext {
        paused: true,
        pause_reason: "drill",
        account_balance: 0,
        ..ctx()
    };
    let mut p = hl_order("DOGE", "01", "5", NOW_MS);

    assert_code(evaluate(&a, &c, &p), RuleCode::Paused);
    c.paused = false;
    assert_code(evaluate(&a, &c, &p), RuleCode::Expired);
    a.rules.expires_at_ns = U64(NOW_NS);
    assert_code(evaluate(&a, &c, &p), RuleCode::TargetNotEnabled);
    a.rules.targets = vec![Target::HlTestnet];
    assert_code(evaluate(&a, &c, &p), RuleCode::Malformed);
    p = hl_order("DOGE", "1000", "5", NOW_MS);
    assert_code(evaluate(&a, &c, &p), RuleCode::StaleNonce);
    a.last_hl_nonce_ms = None;
    assert_code(evaluate(&a, &c, &p), RuleCode::MarketNotAllowed);
    p = hl_order("BTC", "1000", "5", NOW_MS);
    assert_code(evaluate(&a, &c, &p), RuleCode::ReduceOnlyRequired);
    a.rules.reduce_only_required = false;
    assert_code(evaluate(&a, &c, &p), RuleCode::OrderAboveCap);
    p = small_btc(NOW_MS);
    assert_code(evaluate(&a, &c, &p), RuleCode::DailyOrderCount);
    a.orders_today = 0;
    assert_code(evaluate(&a, &c, &p), RuleCode::DailyCap);
    a.spent_today = U128(0);
    assert_code(evaluate(&a, &c, &p), RuleCode::InsufficientContractBalance);
    c.account_balance = ctx().account_balance;
    assert_allowed(evaluate(&a, &c, &p));

    // Transfer: token, then receiver, then cap.
    let a = agent();
    let mut p = transfer(BAD_ADDR, USDC_CAP + 1, 0);
    if let OrderRequest::EvmTransfer { token, .. } = &mut p.order {
        *token = "WETH".to_owned();
    }
    assert_code(eval(&a, &p), RuleCode::TokenNotAllowed);
    p = transfer(BAD_ADDR, USDC_CAP + 1, 0);
    assert_code(eval(&a, &p), RuleCode::ReceiverNotAllowed);
    p = transfer(OWNER_ADDR, USDC_CAP + 1, 0);
    assert_code(eval(&a, &p), RuleCode::OrderAboveCap);

    // Leverage: market before leverage, leverage before the daily count.
    let mut a = agent();
    a.orders_today = MAX_ORDERS;
    assert_code(
        eval(&a, &hl_leverage("DOGE", 50, NOW_MS)),
        RuleCode::MarketNotAllowed,
    );
    assert_code(
        eval(&a, &hl_leverage("BTC", 50, NOW_MS)),
        RuleCode::LeverageAboveLimit,
    );
    assert_code(
        eval(&a, &hl_leverage("BTC", 3, NOW_MS)),
        RuleCode::DailyOrderCount,
    );
}

#[test]
fn paused_beats_daily_cap() {
    let mut a = agent();
    a.spent_today = U128(DAILY_CAP);
    let c = EvalContext {
        paused: true,
        pause_reason: "owner",
        ..ctx()
    };
    assert_code(evaluate(&a, &c, &small_btc(NOW_MS)), RuleCode::Paused);
}

// ---- day rollover and reservations -------------------------------------------------------------

#[test]
fn counters_roll_over_at_utc_midnight() {
    let today = day_of(NOW_NS);
    let mut a = agent();
    a.orders_today = MAX_ORDERS;
    a.spent_today = U128(DAILY_CAP);
    assert_code(eval(&a, &small_btc(NOW_MS)), RuleCode::DailyOrderCount);

    // Last nanosecond of the day: still the same day.
    let last_ns = DAY_START_NS + NS_PER_DAY - 1;
    let c = EvalContext {
        now_ns: last_ns,
        ..ctx()
    };
    assert_eq!(day_of(last_ns), today);
    assert_code(
        evaluate(&a, &c, &small_btc(last_ns / 1_000_000)),
        RuleCode::DailyOrderCount,
    );
    // Midnight: a new day, counters read as zero.
    let midnight = DAY_START_NS + NS_PER_DAY;
    let c = EvalContext {
        now_ns: midnight,
        ..ctx()
    };
    assert_eq!(day_of(midnight), today + 1);
    assert_eq!(a.counters_on(today + 1), (0, 0));
    assert_allowed(evaluate(&a, &c, &small_btc(midnight / 1_000_000)));

    // Reserving on the new day starts from zero.
    a.reserve(today + 1, 5, Nonce::Hl(1));
    assert_eq!((a.day, a.spent_today.0, a.orders_today), (today + 1, 5, 1));
    assert_eq!(a.view_on(today + 2).spent_today.0, 0);
    assert_eq!(a.view_on(today + 2).day, today + 2);
}

#[test]
fn release_only_on_the_same_day() {
    let today = day_of(NOW_NS);
    let mut a = agent();
    a.reserve(today, 700, Nonce::Hl(NOW_MS));
    a.reserve(today, 300, Nonce::Hl(NOW_MS + 1));
    a.release(today, today, 700);
    assert_eq!((a.spent_today.0, a.orders_today), (300, 1));
    // The nonce stays consumed.
    assert_eq!(a.last_hl_nonce_ms, Some(U64(NOW_MS + 1)));
    // A reservation from yesterday is not released into today's counters.
    a.release(today - 1, today, 300);
    assert_eq!((a.spent_today.0, a.orders_today), (300, 1));
    // Releasing after midnight changes nothing either.
    a.release(today, today + 1, 300);
    assert_eq!((a.spent_today.0, a.orders_today), (300, 1));
    // Never below zero.
    a.release(today, today, 10_000);
    a.release(today, today, 10_000);
    assert_eq!((a.spent_today.0, a.orders_today), (0, 0));
}

// ---- payload binding ---------------------------------------------------------------------------

#[test]
fn payload_uses_owner_asset_and_token_address() {
    let a = agent();
    let eth = assert_allowed(eval(&a, &hl_order("ETH", "1000", "0.001", NOW_MS)));
    assert!(eth.signed_body.contains(r#""a":4,"#), "{}", eth.signed_body);

    let mut r = rules();
    r.markets[1].asset = 99;
    let moved = assert_allowed(eval(
        &agent_with(r),
        &hl_order("ETH", "1000", "0.001", NOW_MS),
    ));
    assert!(moved.signed_body.contains(r#""a":99,"#));
    assert_ne!(moved.payload_hash, eth.payload_hash);

    let evm = assert_allowed(eval(&a, &transfer(OWNER_ADDR, 1, 0)));
    assert!(
        evm.signed_body.contains(&USDC_ADDR[2..]),
        "token address from the owner rule"
    );
    let mut r = rules();
    r.tokens[0].address = "0x2222222222222222222222222222222222222222".to_owned();
    let other = assert_allowed(eval(&agent_with(r), &transfer(OWNER_ADDR, 1, 0)));
    assert!(other.signed_body.contains(&"22".repeat(20)));
    assert_ne!(other.payload_hash, evm.payload_hash);
}

// ---- rules validation --------------------------------------------------------------------------

#[test]
fn validation_accepts_the_fixture_and_rejects_bad_rules() {
    assert_eq!(validate_rules(&rules()), Ok(()));

    type Edit = fn(&mut Rules);
    let cases: &[(Edit, &str)] = &[
        (|r| r.targets.clear(), "targets"),
        (|r| r.targets.push(Target::HlTestnet), "targets"),
        (|r| r.markets[0].name = "btc".into(), "markets"),
        (|r| r.markets[0].name = "".into(), "markets"),
        (|r| r.markets[0].name = "B".repeat(17), "markets"),
        (|r| r.markets[1].name = "BTC".into(), "markets"),
        (|r| r.markets[1].asset = BTC_ASSET, "markets"),
        (|r| r.markets[0].max_order_sz = "0.010".into(), "markets"),
        (|r| r.markets[0].max_order_sz = "0".into(), "markets"),
        (|r| r.markets[0].max_order_sz = "1e3".into(), "markets"),
        (
            |r| {
                r.markets = (0..=MAX_RULE_LIST_LEN as u32)
                    .map(|i| market(&format!("M{i}"), i, "1", 0))
                    .collect()
            },
            "markets",
        ),
        (|r| r.max_leverage = 0, "max_leverage"),
        (|r| r.tokens[0].decimals = 18, "tokens"),
        (|r| r.tokens[0].address = USDC_ADDR.to_uppercase(), "tokens"),
        (|r| r.tokens[0].address = "0x036c".into(), "tokens"),
        (|r| r.tokens[0].symbol = "usdc".into(), "tokens"),
        (
            |r| {
                let mut dup = r.tokens[0].clone();
                dup.address = OWNER_ADDR.into();
                r.tokens.push(dup);
            },
            "tokens",
        ),
        (|r| r.tokens.push(token("USDT", USDC_ADDR, 1)), "tokens"),
        (
            |r| {
                r.receivers
                    .push(BAD_ADDR.to_uppercase().replace("0X", "0x"))
            },
            "receivers",
        ),
        (|r| r.receivers.push(OWNER_ADDR.into()), "receivers"),
        (|r| r.receivers.push("bad.testnet".into()), "receivers"),
    ];
    for (edit, field) in cases {
        let mut r = rules();
        edit(&mut r);
        assert_eq!(validate_rules(&r), Err(*field), "{r:?}");
    }
    // Empty allowlists are fine (that target then allows nothing).
    let mut r = rules();
    r.markets.clear();
    r.tokens.clear();
    r.receivers.clear();
    assert_eq!(validate_rules(&r), Ok(()));
}

#[test]
fn validation_of_sz_decimals() {
    let with_market = |sz_decimals: u8, max_order_sz: &str| {
        let mut r = rules();
        r.markets[0] = market("BTC", BTC_ASSET, max_order_sz, sz_decimals);
        validate_rules(&r)
    };
    // 0..=6, and a cap with at most `sz_decimals` decimals.
    for (sz_decimals, cap) in [
        (0, "1"),
        (0, "100"),
        (2, "0.01"),
        (5, "0.01"),
        (5, "0.00001"),
        (6, "0.000001"),
        (6, "1"),
    ] {
        assert_eq!(with_market(sz_decimals, cap), Ok(()), "{sz_decimals} {cap}");
    }
    for (sz_decimals, cap) in [
        (7, "1"),
        (8, "0.00000001"),
        (u8::MAX, "1"),
        (5, "0.000001"),
        (4, "0.00001"),
        (1, "0.01"),
        (0, "0.5"),
        (6, "0.0000001"),
    ] {
        assert_eq!(
            with_market(sz_decimals, cap),
            Err("markets"),
            "{sz_decimals} {cap}"
        );
    }
}

#[test]
fn normalize_rules_lowercases_every_address() {
    assert_eq!(normalize_rules(rules()), Ok(rules()));

    let mut sent = rules();
    sent.tokens[0].address = USDC_ADDR_CHECKSUM.into();
    sent.receivers = vec![
        SPEC_ADDR.into(),
        format!("0X{}", BAD_ADDR[2..].to_uppercase()),
        OWNER_ADDR.replace("0x", "0X"),
    ];
    let stored = normalize_rules(sent).expect("valid");
    assert_eq!(stored.tokens[0].address, USDC_ADDR);
    assert_eq!(
        stored.receivers,
        vec![SPEC_ADDR_LOWER, BAD_ADDR, OWNER_ADDR]
    );
    assert_eq!(validate_rules(&stored), Ok(()));
    // Everything else is kept as sent.
    let mut expected = rules();
    expected.receivers = stored.receivers.clone();
    assert_eq!(stored, expected);
}

#[test]
fn normalize_rules_refuses_bad_addresses_and_finds_duplicates_in_any_case() {
    type Edit = fn(&mut Rules);
    let cases: &[(Edit, &str)] = &[
        // One letter's case flipped: not the EIP-55 checksum.
        (
            |r| r.tokens[0].address = "0x036cBD53842c5426634e7929541eC2318f3dCF7e".into(),
            "tokens",
        ),
        (
            |r| {
                r.receivers
                    .push("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed".into())
            },
            "receivers",
        ),
        (|r| r.tokens[0].address = "0x036cbd".into(), "tokens"),
        (|r| r.tokens[0].address = USDC_ADDR[2..].into(), "tokens"),
        (|r| r.receivers.push(format!("{BAD_ADDR}0")), "receivers"),
        (
            |r| r.receivers.push(BAD_ADDR.replace('b', "g")),
            "receivers",
        ),
        // The same receiver twice, in two spellings.
        (
            |r| r.receivers.push(OWNER_ADDR.replace("0x", "0X")),
            "receivers",
        ),
        (
            |r| r.receivers = vec![SPEC_ADDR.into(), SPEC_ADDR_LOWER.into()],
            "receivers",
        ),
        // Two tokens at one contract, in two spellings.
        (
            |r| r.tokens.push(token("USDT", USDC_ADDR_CHECKSUM, 1)),
            "tokens",
        ),
        // Earlier fields are still reported first.
        (
            |r| {
                r.targets.clear();
                r.receivers.push("0xbad".into());
            },
            "targets",
        ),
        (
            |r| {
                r.markets[0].sz_decimals = 7;
                r.receivers.push("0xbad".into());
            },
            "markets",
        ),
    ];
    for (edit, field) in cases {
        let mut r = rules();
        edit(&mut r);
        assert_eq!(normalize_rules(r.clone()), Err(*field), "{r:?}");
    }
}

// ---- tighten vs loosen, every field ------------------------------------------------------------

#[test]
fn equal_rules_are_not_a_loosening() {
    assert_eq!(first_loosening(&rules(), &rules()), None);
}

#[test]
fn tighten_and_loosen_every_field() {
    type Edit = fn(&mut Rules);
    // (field, tightening edit, loosening edit)
    let cases: &[(&str, Edit, Edit)] = &[
        (
            "targets",
            |r| r.targets = vec![Target::HlTestnet],
            |_| {}, // the fixture enables every target; the undo check below covers adding one
        ),
        (
            "markets",
            |r| {
                r.markets.remove(1);
            },
            |r| r.markets.push(market("SOL", 5, "1", 2)),
        ),
        (
            "markets",
            |r| r.markets[0].max_order_sz = "0.005".into(),
            |r| r.markets[0].max_order_sz = "0.02".into(),
        ),
        (
            "markets",
            |r| r.markets[0].max_order_sz = "0.00999".into(),
            |r| r.markets[0].asset = 30, // same name, other asset: remove + add
        ),
        (
            "markets",
            |r| r.markets.clear(),
            |r| r.markets[0].name = "XBT".into(), // rename = remove + add
        ),
        (
            "markets",
            |r| r.markets[1].max_order_sz = "0.05".into(),
            |r| r.markets[0].sz_decimals = BTC_SZ_DECIMALS - 1, // fewer size decimals
        ),
        (
            "markets",
            |r| r.markets[1].max_order_sz = "0.09".into(),
            |r| r.markets[1].sz_decimals = ETH_SZ_DECIMALS + 2, // more size decimals
        ),
        (
            "max_order_notional",
            |r| r.max_order_notional = U128(MAX_NOTIONAL - 1),
            |r| r.max_order_notional = U128(MAX_NOTIONAL + 1),
        ),
        (
            "max_leverage",
            |r| r.max_leverage = 1,
            |r| r.max_leverage = MAX_LEVERAGE + 1,
        ),
        (
            "tokens",
            |r| r.tokens.clear(),
            |r| r.tokens.push(token("EURC", OWNER_ADDR, 1)),
        ),
        (
            "tokens",
            |r| r.tokens[0].max_per_order = U128(USDC_CAP - 1),
            |r| r.tokens[0].max_per_order = U128(USDC_CAP + 1),
        ),
        (
            "tokens",
            |r| r.tokens[0].max_per_order = U128(0),
            |r| r.tokens[0].address = BAD_ADDR.into(), // same symbol, other contract
        ),
        (
            "tokens",
            |r| r.tokens[0].max_per_order = U128(1),
            |r| r.tokens[0].decimals = 18, // other decimals
        ),
        (
            "receivers",
            |r| r.receivers.clear(),
            |r| r.receivers.push(BAD_ADDR.into()),
        ),
        (
            "daily_cap",
            |r| r.daily_cap = U128(DAILY_CAP - 1),
            |r| r.daily_cap = U128(DAILY_CAP + 1),
        ),
        (
            "max_orders_per_day",
            |r| r.max_orders_per_day = MAX_ORDERS - 1,
            |r| r.max_orders_per_day = MAX_ORDERS + 1,
        ),
        (
            "expires_at_ns",
            |r| r.expires_at_ns = U64(NOW_NS),
            |r| r.expires_at_ns = U64(NOW_NS + 8 * NS_PER_DAY),
        ),
        (
            "reduce_only_required",
            |r| r.reduce_only_required = true,
            |_| {}, // loosening is from true to false; checked below
        ),
    ];
    for (field, tighten, loosen) in cases {
        let old = rules();
        let mut tighter = rules();
        tighten(&mut tighter);
        assert_eq!(first_loosening(&old, &tighter), None, "tightening {field}");
        // And back again is a loosening of the same field.
        assert_eq!(
            first_loosening(&tighter, &old),
            Some(*field),
            "undoing the tightening of {field}"
        );
        let mut looser = rules();
        loosen(&mut looser);
        if looser != old {
            assert_eq!(
                first_loosening(&old, &looser),
                Some(*field),
                "loosening {field}"
            );
        }
    }

    let mut strict = rules();
    strict.reduce_only_required = true;
    assert_eq!(
        first_loosening(&strict, &rules()),
        Some("reduce_only_required")
    );
    assert_eq!(first_loosening(&rules(), &strict), None);

    // Reordering lists is neither.
    let mut reordered = rules();
    reordered.markets.reverse();
    reordered.targets.reverse();
    assert_eq!(first_loosening(&rules(), &reordered), None);
    // Tightening one field and loosening another is a loosening.
    let mut mixed = rules();
    mixed.daily_cap = U128(1);
    mixed.max_leverage = 50;
    assert_eq!(first_loosening(&rules(), &mixed), Some("max_leverage"));
}

#[test]
fn any_sz_decimals_change_is_a_loosening() {
    // BTC cap 0.01 (2 decimals) allows 2..=6; every value but 5 is a change.
    for sz_decimals in [2, 3, BTC_SZ_DECIMALS - 1, BTC_SZ_DECIMALS + 1] {
        let mut changed = rules();
        changed.markets[0].sz_decimals = sz_decimals;
        assert_eq!(validate_rules(&changed), Ok(()));
        assert_eq!(
            first_loosening(&rules(), &changed),
            Some("markets"),
            "{sz_decimals}"
        );
        assert_eq!(first_loosening(&changed, &rules()), Some("markets"));
    }
    // Even together with a smaller size cap.
    let mut changed = rules();
    changed.markets[0].sz_decimals = 6;
    changed.markets[0].max_order_sz = "0.001".into();
    assert_eq!(validate_rules(&changed), Ok(()));
    assert_eq!(first_loosening(&rules(), &changed), Some("markets"));
    // The same `sz_decimals` with a smaller cap is a tightening.
    let mut smaller = rules();
    smaller.markets[0].max_order_sz = "0.001".into();
    assert_eq!(first_loosening(&rules(), &smaller), None);
}

#[test]
fn checksummed_addresses_compare_equal_to_their_lowercase_form() {
    let mut old = rules();
    old.receivers.push(SPEC_ADDR_LOWER.into());
    let mut new = old.clone();
    new.tokens[0].address = USDC_ADDR_CHECKSUM.into();
    new.receivers = vec![
        OWNER_ADDR.replace("0x", "0X"),
        format!("0X{}", SPEC_ADDR_LOWER[2..].to_uppercase()),
    ];
    assert_eq!(first_loosening(&old, &new), None);
    assert_eq!(first_loosening(&new, &old), None);
    // Normalized, they are the same rules.
    assert_eq!(normalize_rules(new.clone()), Ok(old.clone()));
    // An address that does not parse matches nothing: a loosening (fail closed).
    let mut bad = old.clone();
    bad.receivers[1] = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed".into();
    assert_eq!(first_loosening(&old, &bad), Some("receivers"));
    let mut bad = old.clone();
    bad.tokens[0].address = "0x036cBD53842c5426634e7929541eC2318f3dCF7e".into();
    assert_eq!(first_loosening(&old, &bad), Some("tokens"));
}
