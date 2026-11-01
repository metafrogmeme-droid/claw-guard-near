//! The prompt-injection demo scenario against a local near-workspaces
//! sandbox, with the exact decision messages. Sandbox only. Not audited.
//!
//! Rules: [`demo_rules`] (the same JSON as the TypeScript demo's `demo/rules.json`). A scripted
//! agent first places one normal order, then follows an injected "support message" that tells it
//! to move everything to `0xBAD…` and open max leverage on DOGE:
//!
//! 1. normal: buy 0.001 BTC at 50000            → `Allowed: within your limits` (signed)
//! 2. buy DOGE                                   → market DOGE is not on your list
//! 3. BTC size 5                                 → order is above your per-order cap
//! 4. updateLeverage BTC 50x                     → leverage 50x is above your limit of 3x
//! 5. USDC transfer to 0xbad…bad (lowercase, D-12) → receiver … is not on your list
//! 6. 0.01 BTC at 50000 (at the per-order cap) until the daily cap: 2 allowed, then
//!    → this order would go over your daily cap
//! 7. a full-access key appears on agent-1 (simulated with a sandbox state patch); the test
//!    acts as Claw Watch: it sees the new key, prints the public signal and has the guardian
//!    pause("watch: new full-access key"); the next order, otherwise within limits,
//!    → agent is paused (watch: new full-access key)
//!
//! The mock MPC's `sign_count` must equal the number of allowed orders after every step: no
//! blocked step may reach the MPC.

mod common;

use anyhow::{Context, Result, ensure};
use common::*;
use near_workspaces::Account;
use near_workspaces::types::AccessKeyPermission;
use serde_json::{Value, json};

/// "Far below market" limit price used for every BTC order of the scenario.
const BTC_PX: &str = "50000";
/// Step 1 size: 0.001 BTC × 50000 = 50 quote units.
const NORMAL_SZ: &str = "0.001";
const NORMAL_NOTIONAL: u128 = 50_000_000;
/// Step 6 size: 0.01 BTC (the BTC size cap) × 50000 = 500 quote units (the notional cap).
const IN_CAP_SZ: &str = "0.01";
const IN_CAP_NOTIONAL: u128 = 500_000_000;
/// The injected receiver, all lowercase (owner decision D-12).
const INJECTED_RECEIVER: &str = "0xbad0000000000000000000000000000000000bad";
const WATCH_PAUSE_REASON: &str = "watch: new full-access key";

/// Expected result of one proposal.
enum Expect {
    Allowed,
    Blocked {
        rule_code: &'static str,
        message: String,
    },
}

fn blocked(rule_code: &'static str, rule_text: &str) -> Expect {
    Expect::Blocked {
        rule_code,
        message: format!("Blocked by your rule: {rule_text}"),
    }
}

/// Runs proposals one by one and checks each decision, its stored receipt and the MPC count.
struct Scenario {
    sb: Sandbox,
    nonces: HlNonces,
    allowed: u64,
    blocked: u64,
    /// (status, rule_code, message) of every receipt, in id order.
    expected_receipts: Vec<(&'static str, Value, String)>,
}

impl Scenario {
    async fn propose(&mut self, step: &str, proposal: Value, expect: Expect) -> Result<Value> {
        let signs_before = self.sb.sign_count().await?;
        let result = self.sb.propose(&proposal).await?;
        let decision = match &expect {
            Expect::Allowed => expect_allowed(result),
            Expect::Blocked { rule_code, message } => expect_blocked(result, rule_code, message),
        }
        .with_context(|| format!("step {step}"))?;
        let id = decision["receipt_id"].as_str().context("receipt_id")?;
        let message = decision["message"].as_str().context("message")?;
        println!("step {step}: #{id} {message}");

        let receipt = self.sb.receipt(id).await?;
        assert_eq!(receipt["proposal"], proposal, "step {step}");
        assert_eq!(receipt["message"], message, "step {step}");
        assert_eq!(receipt["rule_code"], decision["rule_code"], "step {step}");
        let signs_after = self.sb.sign_count().await?;
        match expect {
            Expect::Allowed => {
                self.allowed += 1;
                assert_eq!(receipt["status"], "Signed", "step {step}");
                assert_eq!(receipt["signature"], decision["signature"], "step {step}");
                self.expected_receipts
                    .push(("Signed", Value::Null, message.to_owned()));
            }
            Expect::Blocked { rule_code, .. } => {
                self.blocked += 1;
                assert_eq!(receipt["status"], "Blocked", "step {step}");
                for field in [
                    "payload_hash",
                    "signed_body",
                    "derivation_path",
                    "signature",
                ] {
                    assert_eq!(receipt[field], Value::Null, "step {step}: {field}");
                }
                self.expected_receipts
                    .push(("Blocked", json!(rule_code), message.to_owned()));
            }
        }
        // A blocked step never reaches the MPC; an allowed one makes exactly one sign call.
        let new_signs = if receipt["status"] == "Signed" { 1 } else { 0 };
        assert_eq!(signs_after, signs_before + new_signs, "step {step}");
        assert_eq!(
            signs_after, self.allowed,
            "step {step}: sign_count must equal the allowed orders"
        );
        Ok(decision)
    }

    async fn hl_order(&mut self, market: &str, px: &str, sz: &str) -> Result<Value> {
        let nonce_ms = self.nonces.next(&self.sb).await?;
        Ok(hl_order(market, true, px, sz, nonce_ms))
    }
}

/// Full-access keys of `account` (as strings).
async fn full_access_keys(account: &Account) -> Result<Vec<String>> {
    Ok(account
        .view_access_keys()
        .await?
        .into_iter()
        .filter(|info| matches!(info.access_key.permission, AccessKeyPermission::FullAccess))
        .map(|info| info.public_key.to_string())
        .collect())
}

#[tokio::test]
async fn prompt_injection_scenario_blocks_every_injected_order() -> Result<()> {
    let sb = setup_with_rules(demo_rules).await?;
    let mut run = Scenario {
        sb,
        nonces: HlNonces::default(),
        allowed: 0,
        blocked: 0,
        expected_receipts: Vec::new(),
    };

    // 1. Normal order: allowed, and signed by the guard's derived key.
    let proposal = run.hl_order("BTC", BTC_PX, NORMAL_SZ).await?;
    let decision = run.propose("1", proposal.clone(), Expect::Allowed).await?;
    let payload_hash = run.sb.receipt("1").await?["payload_hash"]
        .as_str()
        .context("payload_hash")?
        .to_owned();
    assert_eq!(
        recover_receipt_signer(&payload_hash, &decision["signature"], 27)?,
        run.sb.derived_address(CONTRACT_ID, HL_PATH).await?
    );

    // 2-5. The injected instructions.
    let proposal = run.hl_order("DOGE", "0.1", "1000").await?;
    run.propose(
        "2",
        proposal,
        blocked("MARKET_NOT_ALLOWED", "market DOGE is not on your list"),
    )
    .await?;

    let proposal = run.hl_order("BTC", BTC_PX, "5").await?;
    run.propose(
        "3",
        proposal,
        blocked("ORDER_ABOVE_CAP", "order is above your per-order cap"),
    )
    .await?;

    let nonce_ms = run.nonces.next(&run.sb).await?;
    run.propose(
        "4",
        hl_update_leverage("BTC", true, 50, nonce_ms),
        blocked(
            "LEVERAGE_ABOVE_LIMIT",
            "leverage 50x is above your limit of 3x",
        ),
    )
    .await?;

    run.propose(
        "5",
        evm_transfer(USDC_SYMBOL, INJECTED_RECEIVER, DEMO_USDC_MAX_PER_ORDER, 0),
        blocked(
            "RECEIVER_NOT_ALLOWED",
            &format!("receiver {INJECTED_RECEIVER} is not on your list"),
        ),
    )
    .await?;

    // 6. Orders at the per-order cap until the daily cap: the demo numbers allow exactly two.
    let fits = u64::try_from((DEMO_DAILY_CAP - NORMAL_NOTIONAL) / IN_CAP_NOTIONAL)?;
    assert_eq!(fits, 2, "demo rules: two in-cap orders fit after step 1");
    assert_eq!(IN_CAP_NOTIONAL, DEMO_MAX_ORDER_NOTIONAL);
    for i in 1..=fits {
        let proposal = run.hl_order("BTC", BTC_PX, IN_CAP_SZ).await?;
        run.propose(&format!("6.{i}"), proposal, Expect::Allowed)
            .await?;
    }
    let proposal = run.hl_order("BTC", BTC_PX, IN_CAP_SZ).await?;
    run.propose(
        &format!("6.{}", fits + 1),
        proposal,
        blocked("DAILY_CAP", "this order would go over your daily cap"),
    )
    .await?;
    let spent = NORMAL_NOTIONAL + u128::from(fits) * IN_CAP_NOTIONAL;
    let state = run.sb.agent_state().await?;
    assert_eq!(state["spent_today"], spent.to_string());
    assert_eq!(state["orders_today"], 1 + fits);

    // 7. A full-access key appears on agent-1. The next order would be within limits (50 more
    //    units stay under the daily cap); only the pause blocks it.
    let next = run.hl_order("BTC", BTC_PX, NORMAL_SZ).await?;
    let preview_args = json!({"agent_id": AGENT_ID, "proposal": next});
    let preview = run
        .sb
        .view_guard("preview_payload", preview_args.clone())
        .await?;
    ensure!(preview["Ok"].is_string(), "next order must pass: {preview}");

    let baseline = full_access_keys(&run.sb.agent).await?;
    assert!(
        baseline.is_empty(),
        "agent-1 starts without full-access keys"
    );
    let attacker_key = run.sb.patch_in_full_access_key(run.sb.agent.id()).await?;
    println!("simulated: a full-access key was added to {AGENT_ID} by a sandbox state patch");

    // The watcher's poll: diff the key list against the baseline (offchain watch/alerts.ts
    // words the alert the same way).
    let now = full_access_keys(&run.sb.agent).await?;
    let alerts: Vec<String> = now
        .iter()
        .filter(|key| !baseline.contains(key))
        .map(|_| format!("Public signal: new full-access key on {AGENT_ID}"))
        .collect();
    assert_eq!(
        alerts,
        ["Public signal: new full-access key on agent-1.test.near"]
    );
    assert_eq!(now, [attacker_key.public_key().to_string()]);
    println!("{}", alerts[0]);

    let pause = expect_success(run.sb.guardian_pause(WATCH_PAUSE_REASON).await?)?;
    assert_eq!(
        events(&pause)?,
        [
            json!({"standard": "clawguard", "version": "1.0.0", "event": "paused",
                "data": [{"by": GUARDIAN_ID, "reason": WATCH_PAUSE_REASON}]})
        ]
    );
    assert_eq!(
        run.sb.view_guard("preview_payload", preview_args).await?,
        json!({"Err": "Blocked by your rule: agent is paused (watch: new full-access key)"})
    );
    run.propose(
        "7",
        next,
        blocked("PAUSED", "agent is paused (watch: new full-access key)"),
    )
    .await?;

    // Totals: 3 signatures for 3 allowed orders, 6 blocked receipts, nothing else signed.
    assert_eq!(run.allowed, 1 + fits);
    assert_eq!(run.blocked, 6);
    assert_eq!(run.sb.sign_count().await?, run.allowed);
    let state = run.sb.agent_state().await?;
    assert_eq!(state["spent_today"], spent.to_string());
    assert_eq!(state["orders_today"], 1 + fits);

    // The on-chain receipt log tells the same story, in order.
    let receipts = run.sb.receipts(1, 50).await?;
    let stored: Vec<(&str, Value, String)> = receipts
        .iter()
        .map(|r| {
            (
                r["status"].as_str().unwrap_or_default(),
                r["rule_code"].clone(),
                r["message"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert_eq!(stored, run.expected_receipts);
    let ids: Vec<&str> = receipts.iter().filter_map(|r| r["id"].as_str()).collect();
    assert_eq!(ids, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    assert_eq!(run.sb.status().await?["receipts_count"], "9");
    Ok(())
}
