//! Pause flow, the contract-balance rule and NEP-297 events on a local
//! near-workspaces sandbox. Sandbox only. Not audited.
//!
//! * pause: guardian `pause` → every proposal `PAUSED` → owner `unpause` (1 yoctoNEAR; not
//!   without it, not by anyone else) → the next order is allowed;
//! * `INSUFFICIENT_CONTRACT_BALANCE`: when the guard cannot pay the MPC deposit (the owner set a
//!   huge `sign_deposit_yocto`, or its balance is one yoctoNEAR short of
//!   `(storage + 4096 bytes) × byte cost + deposit`), the order gets a `Blocked` receipt and no
//!   promise is created;
//! * storage reserve (Q-44): with the balance just above `(storage + 4096 bytes) × byte cost`,
//!   worst-case blocked proposals are stored until that reserve is reached, then answered with
//!   receipt id `"0"` (nothing stored, nothing signed); the guardian's `pause` with a 140-byte
//!   reason still succeeds, and once the owner adds NEAR receipts are stored again;
//! * events: the `EVENT_JSON` logs of registration, a blocked and an allowed order, pause and
//!   unpause follow NEP-297 (`standard`, `version`, `event`, `data`) with the fields listed in events.rs;
//! * owner rules over the real JSON wire (owner decision D-11): a market `sz_decimals` of 300
//!   or -1 (or 7) is refused with `ERR_INVALID_RULES (markets)` by `register_agent` and
//!   `set_rules`, not with near-sdk's JSON parse error, and nothing is stored.
//!
//! Each test prints `GAS …` lines (run with `--nocapture`) for the gas table in the docs.

mod common;

use anyhow::{Context, Result, bail, ensure};
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use serde_json::{Map, Value, json};

const NO_BALANCE: &str = "Blocked by your rule: guard has no balance to request a signature";

/// Parses one `EVENT_JSON` payload and checks the NEP-297 envelope: exactly the keys
/// `standard` ("clawguard"), `version` ("1.0.0"), `event` (= `name`) and `data`, where `data`
/// is a one-element array holding an object with exactly `fields`. Returns that object.
fn nep297(payload: &str, name: &str, fields: &[&str]) -> Result<Map<String, Value>> {
    let event: Value = serde_json::from_str(payload).with_context(|| payload.to_owned())?;
    let envelope = event.as_object().context("event is a JSON object")?;
    let mut keys: Vec<&str> = envelope.keys().map(String::as_str).collect();
    keys.sort_unstable();
    ensure!(
        keys == ["data", "event", "standard", "version"],
        "envelope keys {keys:?}"
    );
    ensure!(event["standard"] == "clawguard", "standard: {event}");
    ensure!(event["version"] == "1.0.0", "version: {event}");
    ensure!(event["event"] == name, "expected event {name}: {event}");
    let data = event["data"].as_array().context("data is an array")?;
    let [item] = data.as_slice() else {
        bail!("data must hold exactly one item: {event}");
    };
    let item = item.as_object().context("data item is an object")?.clone();
    let mut got: Vec<&str> = item.keys().map(String::as_str).collect();
    got.sort_unstable();
    let mut want = fields.to_vec();
    want.sort_unstable();
    ensure!(got == want, "{name} fields: got {got:?}, want {want:?}");
    Ok(item)
}

/// The only log of a transaction whose single receipt on the guard logged one event, checked
/// with [`nep297`].
fn single_event(
    result: &ExecutionFinalResult,
    name: &str,
    fields: &[&str],
) -> Result<Map<String, Value>> {
    let logs = result.logs();
    let [log] = logs.as_slice() else {
        bail!("expected exactly one log line, got {logs:?}");
    };
    let payload = log
        .strip_prefix("EVENT_JSON:")
        .with_context(|| format!("not an EVENT_JSON log: {log}"))?;
    nep297(payload, name, fields)
}

fn is_hex32(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 66
            && s.starts_with("0x")
            && s[2..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

#[tokio::test]
async fn guardian_pause_blocks_every_order_until_the_owner_unpauses() -> Result<()> {
    let sb = setup().await?;
    let mut nonces = HlNonces::default();

    let reason = "watch: 3 blocked orders in 10 min";
    let result = expect_success(sb.guardian_pause(reason).await?)?;
    println!("GAS guardian pause: {}", gas_breakdown(&result));
    let status = sb.status().await?;
    assert_eq!(status["paused"], true);
    assert_eq!(status["pause_reason"], reason);

    // Every proposal is blocked with the reason, on both targets, even one that breaks other
    // rules too (PAUSED is checked first).
    let paused = format!("Blocked by your rule: agent is paused ({reason})");
    let hl = hl_order("BTC", true, "1000", "0.001", nonces.next(&sb).await?);
    let result = sb.propose(&hl).await?;
    println!(
        "GAS propose_order blocked (PAUSED): {}",
        gas_breakdown(&result)
    );
    expect_blocked(result, "PAUSED", &paused)?;
    let evm = evm_transfer(USDC_SYMBOL, RECEIVER, 1_000_000, 0);
    expect_blocked(sb.propose(&evm).await?, "PAUSED", &paused)?;
    let doge = hl_order("DOGE", true, "0.1", "100", nonces.next(&sb).await?);
    expect_blocked(sb.propose(&doge).await?, "PAUSED", &paused)?;
    assert_eq!(sb.receipt("3").await?["status"], "Blocked");

    // Pausing again (here by the owner, no deposit) replaces the reason.
    let reason = "owner: checking keys";
    let result = sb
        .call_guard_as(
            &sb.owner,
            "pause",
            json!({"reason": reason}),
            NearToken::from_yoctonear(0),
        )
        .await?;
    let data = single_event(&expect_success(result)?, "paused", &["by", "reason"])?;
    assert_eq!(data["by"], OWNER_ID);
    assert_eq!(sb.status().await?["pause_reason"], reason);
    // A reason over 140 bytes is refused and changes nothing.
    let result = sb.guardian_pause(&"x".repeat(141)).await?;
    assert_contract_panic(&result, "ERR_REASON_TOO_LONG")?;
    assert_eq!(sb.status().await?["pause_reason"], reason);

    // Unpause needs the owner AND exactly 1 yoctoNEAR (only a full-access key can attach it).
    let result = sb
        .call_guard_as(
            &sb.owner,
            "unpause",
            json!({}),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert_contract_panic(&result, ONE_YOCTO_PANIC)?;
    let result = sb
        .call_guard_as(
            &sb.owner,
            "unpause",
            json!({}),
            NearToken::from_yoctonear(2),
        )
        .await?;
    assert_contract_panic(&result, ONE_YOCTO_PANIC)?;
    // test.near holds a full-access key but is not the owner.
    let result = sb
        .call_guard_as(&sb.root, "unpause", json!({}), ONE_YOCTO)
        .await?;
    assert_contract_panic(&result, "ERR_NOT_OWNER")?;
    assert_rejected_by_protocol(
        sb.call_guard_as(
            &sb.guardian,
            "unpause",
            json!({}),
            NearToken::from_yoctonear(0),
        )
        .await,
        KeyRejection::MethodNameMismatch("unpause"),
    )?;
    assert_eq!(sb.status().await?["paused"], true);
    assert_eq!(sb.sign_count().await?, 0);

    let result = expect_success(sb.owner_unpause().await?)?;
    println!("GAS owner unpause: {}", gas_breakdown(&result));
    let data = single_event(&result, "unpaused", &["by", "reason"])?;
    assert_eq!(data["by"], OWNER_ID);
    assert_eq!(
        data["reason"], reason,
        "unpaused reports the reason it cleared"
    );
    let status = sb.status().await?;
    assert_eq!(status["paused"], false);
    assert_eq!(status["pause_reason"], Value::Null);

    // The next order goes through. The blocked ones consumed no nonce and reserved nothing.
    let state = sb.agent_state().await?;
    assert_eq!(state["orders_today"], 0);
    assert_eq!(state["last_hl_nonce_ms"], Value::Null);
    let decision = expect_allowed(sb.propose(&hl).await?)?;
    assert_eq!(decision["receipt_id"], "4");
    assert_eq!(sb.receipt("4").await?["status"], "Signed");
    assert_eq!(sb.sign_count().await?, 1);
    Ok(())
}

#[tokio::test]
async fn huge_sign_deposit_blocks_with_insufficient_contract_balance() -> Result<()> {
    let sb = setup().await?;
    let mut nonces = HlNonces::default();
    // More than the guard will ever hold.
    let balance = sb.guard_account().await?.balance.as_yoctonear();
    sb.set_sign_config(balance * 1_000, SIGN_GAS_TGAS).await?;

    let proposal = hl_order("BTC", true, "1000", "0.001", nonces.next(&sb).await?);
    assert_eq!(
        sb.view_guard(
            "preview_payload",
            json!({"agent_id": AGENT_ID, "proposal": proposal})
        )
        .await?,
        json!({"Err": NO_BALANCE})
    );
    let result = sb.propose(&proposal).await?;
    println!(
        "GAS propose_order blocked (INSUFFICIENT_CONTRACT_BALANCE): {}",
        gas_breakdown(&result)
    );
    // No promise: propose_order is the only receipt that ran on any contract (no MPC call, no
    // on_signed callback).
    assert_eq!(outcomes_on(&result, CONTRACT_ID).len(), 1);
    assert!(outcomes_on(&result, MPC_ID).is_empty());
    let decision = expect_blocked(result, "INSUFFICIENT_CONTRACT_BALANCE", NO_BALANCE)?;
    assert_eq!(decision["receipt_id"], "1");
    let receipt = sb.receipt("1").await?;
    assert_eq!(receipt["status"], "Blocked");
    assert_eq!(receipt["rule_code"], "INSUFFICIENT_CONTRACT_BALANCE");
    for field in [
        "payload_hash",
        "signed_body",
        "derivation_path",
        "signature",
    ] {
        assert_eq!(receipt[field], Value::Null, "{field}");
    }
    let state = sb.agent_state().await?;
    assert_eq!(state["spent_today"], "0");
    assert_eq!(state["orders_today"], 0);
    assert_eq!(state["last_hl_nonce_ms"], Value::Null);
    assert_eq!(sb.sign_count().await?, 0);

    // It is the last rule: an earlier failure is reported first.
    let doge = hl_order("DOGE", true, "0.1", "100", nonces.next(&sb).await?);
    expect_blocked(
        sb.propose(&doge).await?,
        "MARKET_NOT_ALLOWED",
        "Blocked by your rule: market DOGE is not on your list",
    )?;

    // Once the owner sets a deposit the guard can pay, the same order (its nonce was never
    // consumed) is signed.
    sb.set_sign_config(1, SIGN_GAS_TGAS).await?;
    let decision = expect_allowed(sb.propose(&proposal).await?)?;
    assert_eq!(decision["receipt_id"], "3");
    assert_eq!(sb.sign_count().await?, 1);
    Ok(())
}

#[tokio::test]
async fn contract_balance_rule_is_exact_at_the_storage_floor() -> Result<()> {
    let sb = setup().await?;
    let mut nonces = HlNonces::default();
    let deposit = NearToken::from_near(1).as_yoctonear();
    sb.set_sign_config(deposit, SIGN_GAS_TGAS).await?;
    let proposal = hl_order("BTC", true, "1000", "0.001", nonces.next(&sb).await?);

    // One yoctoNEAR below (storage + 4096 bytes) × byte cost + deposit: blocked.
    let account = sb.guard_account().await?;
    let floor = sign_balance_floor(account.storage_usage, deposit);
    sb.patch_guard_balance(NearToken::from_yoctonear(floor - 1))
        .await?;
    let result = sb.propose(&proposal).await?;
    assert_eq!(outcomes_on(&result, CONTRACT_ID).len(), 1, "no promise");
    expect_blocked(result, "INSUFFICIENT_CONTRACT_BALANCE", NO_BALANCE)?;

    // Exactly at the floor (recomputed: the blocked receipt used more storage): allowed, and
    // the 1 NEAR deposit reaches the MPC.
    let account = sb.guard_account().await?;
    let floor = sign_balance_floor(account.storage_usage, deposit);
    sb.patch_guard_balance(NearToken::from_yoctonear(floor))
        .await?;
    let mpc_before = sb.mpc.view_account().await?.balance.as_yoctonear();
    let decision = expect_allowed(sb.propose(&proposal).await?)?;
    assert_eq!(decision["receipt_id"], "2");
    assert_eq!(sb.receipt("2").await?["status"], "Signed");
    let mpc_after = sb.mpc.view_account().await?.balance.as_yoctonear();
    assert!(
        mpc_after >= mpc_before + deposit,
        "the mock keeps the deposit: {mpc_before} -> {mpc_after}"
    );
    // What is left still covers the guard's storage.
    let account = sb.guard_account().await?;
    assert!(
        account.balance.as_yoctonear() >= u128::from(account.storage_usage) * STORAGE_BYTE_COST,
        "guard storage not covered: {account:?}"
    );
    assert_eq!(sb.sign_count().await?, 1);
    Ok(())
}

#[tokio::test]
async fn blocked_receipts_keep_the_storage_reserve_so_the_guardian_can_still_pause() -> Result<()> {
    let sb = setup().await?;
    let mut nonces = HlNonces::default();
    // Room for about two worst-case blocked receipts above the reserve floor.
    let account = sb.guard_account().await?;
    let floor = sign_balance_floor(account.storage_usage, 0);
    sb.patch_guard_balance(NearToken::from_yoctonear(floor + 1_500 * STORAGE_BYTE_COST))
        .await?;

    // Worst-case blocked proposals: every agent string far over its cut, in 4-byte characters.
    let long = "\u{1F600}".repeat(100);
    let mut worst = hl_order(&long, true, &long, &long, nonces.next(&sb).await?);
    worst["order"]["HlOrder"]["tif"] = json!(long);
    worst["memo"] = json!(long);
    let malformed = "Blocked by your rule: orders must be well-formed (market)";
    let mut stored = 0u64;
    let unstored = loop {
        ensure!(stored < 10, "the storage reserve was never reached");
        let usage_before = sb.guard_account().await?.storage_usage;
        let result = sb.propose(&worst).await?;
        let event = single_event(
            &result,
            "order_blocked",
            &["receipt_id", "agent_id", "target", "rule_code", "message"],
        )?;
        let decision = expect_blocked(result, "MALFORMED", malformed)?;
        ensure!(event["receipt_id"] == decision["receipt_id"], "{event:?}");
        if decision["receipt_id"] == "0" {
            break decision;
        }
        stored += 1;
        assert_eq!(decision["receipt_id"], stored.to_string());
        let grew = sb.guard_account().await?.storage_usage - usage_before;
        println!("STORAGE worst-case blocked receipt: {grew} bytes");
        // MAX_BLOCKED_RECEIPT_BYTES (700) + 9-byte key + 40 bytes per record.
        assert!(grew <= 749, "{grew} bytes");
    };
    assert!(stored >= 1, "at least one receipt fits above the reserve");
    assert_eq!(unstored["receipt_id"], "0");
    assert_eq!(sb.status().await?["receipts_count"], stored.to_string());

    // The guardian can still pause, with the longest reason (35 x 4 bytes = 140 bytes).
    let reason = "\u{1F600}".repeat(35);
    let result = expect_success(sb.guardian_pause(&reason).await?)?;
    let data = single_event(&result, "paused", &["by", "reason"])?;
    assert_eq!(data["by"], GUARDIAN_ID);
    assert_eq!(sb.status().await?["pause_reason"], reason);
    let paused = format!("Blocked by your rule: agent is paused ({reason})");
    let btc = hl_order("BTC", true, "1000", "0.001", nonces.next(&sb).await?);
    let decision = expect_blocked(sb.propose(&btc).await?, "PAUSED", &paused)?;
    assert_eq!(decision["receipt_id"], "0");
    assert_eq!(sb.sign_count().await?, 0, "nothing signed");

    // The owner adds NEAR: blocked receipts are stored again.
    let balance = sb.guard_account().await?.balance.as_yoctonear();
    sb.patch_guard_balance(NearToken::from_yoctonear(
        balance + NearToken::from_near(1).as_yoctonear(),
    ))
    .await?;
    let decision = expect_blocked(sb.propose(&btc).await?, "PAUSED", &paused)?;
    assert_eq!(decision["receipt_id"], (stored + 1).to_string());
    Ok(())
}

#[tokio::test]
async fn events_follow_nep297_for_blocked_and_allowed_orders() -> Result<()> {
    let sb = deploy().await?;
    let expires_at_ns = sb.now_ns().await? + 7 * 86_400 * 1_000_000_000;
    let result = expect_success(
        sb.register_agent(AGENT_ID, &default_rules(expires_at_ns))
            .await?,
    )?;
    let data = single_event(&result, "agent_registered", &["agent_id", "rules_version"])?;
    assert_eq!(
        Value::Object(data),
        json!({"agent_id": AGENT_ID, "rules_version": 1})
    );

    // Blocked: one order_blocked event, logged by propose_order on the guard.
    let mut nonces = HlNonces::default();
    let result = sb
        .propose(&hl_order(
            "DOGE",
            true,
            "0.1",
            "100",
            nonces.next(&sb).await?,
        ))
        .await?;
    assert_eq!(event_logs_on(&result, CONTRACT_ID).concat().len(), 1);
    let data = single_event(
        &result,
        "order_blocked",
        &["receipt_id", "agent_id", "target", "rule_code", "message"],
    )?;
    assert_eq!(
        Value::Object(data),
        json!({
            "receipt_id": "1",
            "agent_id": AGENT_ID,
            "target": "HlTestnet",
            "rule_code": "MARKET_NOT_ALLOWED",
            "message": "Blocked by your rule: market DOGE is not on your list"
        })
    );

    // Allowed: order_allowed from propose_order, then signature_ready from the on_signed
    // callback; the mock logs no clawguard event.
    let proposal = hl_order("BTC", true, "1000", "0.001", nonces.next(&sb).await?);
    let result = expect_success(sb.propose(&proposal).await?)?;
    let per_receipt = event_logs_on(&result, CONTRACT_ID);
    let [first, second] = per_receipt.as_slice() else {
        bail!("expected two receipts on the guard, got {per_receipt:?}");
    };
    let [allowed] = first.as_slice() else {
        bail!("propose_order must log one event: {first:?}");
    };
    let [ready] = second.as_slice() else {
        bail!("on_signed must log one event: {second:?}");
    };
    assert!(event_logs_on(&result, MPC_ID).concat().is_empty());
    let allowed = nep297(
        allowed,
        "order_allowed",
        &[
            "receipt_id",
            "agent_id",
            "target",
            "payload_hash",
            "derivation_path",
        ],
    )?;
    let ready = nep297(ready, "signature_ready", &["receipt_id", "payload_hash"])?;
    let receipt = sb.receipt("2").await?;
    assert!(is_hex32(&allowed["payload_hash"]), "{allowed:?}");
    assert_eq!(
        Value::Object(allowed),
        json!({
            "receipt_id": "2",
            "agent_id": AGENT_ID,
            "target": "HlTestnet",
            "payload_hash": receipt["payload_hash"],
            "derivation_path": HL_PATH
        })
    );
    assert_eq!(
        Value::Object(ready),
        json!({"receipt_id": "2", "payload_hash": receipt["payload_hash"]})
    );

    // Pause and unpause events carry who and why.
    let reason = "watch: new API wallet";
    let result = expect_success(sb.guardian_pause(reason).await?)?;
    let data = single_event(&result, "paused", &["by", "reason"])?;
    assert_eq!(
        Value::Object(data),
        json!({"by": GUARDIAN_ID, "reason": reason})
    );
    let result = expect_success(sb.owner_unpause().await?)?;
    let data = single_event(&result, "unpaused", &["by", "reason"])?;
    assert_eq!(
        Value::Object(data),
        json!({"by": OWNER_ID, "reason": reason})
    );
    Ok(())
}

#[tokio::test]
async fn owner_rules_with_bad_sz_decimals_are_refused_over_the_json_wire() -> Result<()> {
    let sb = setup().await?;
    let status_before = sb.status().await?;
    let state_before = sb.agent_state().await?;
    let invalid = "ERR_INVALID_RULES (markets)";
    for sz_decimals in [json!(300), json!(-1), json!(7)] {
        // The exact JSON an owner tool would send: the BTC market with a bad sz_decimals.
        let mut rules = state_before["rules"].clone();
        rules["markets"][0]["sz_decimals"] = sz_decimals.clone();

        let result = sb
            .call_guard_as(
                &sb.owner,
                "register_agent",
                json!({"agent_id": STRANGER_ID, "rules": rules}),
                ONE_YOCTO,
            )
            .await?;
        assert_contract_panic(&result, invalid)
            .with_context(|| format!("register_agent with sz_decimals {sz_decimals}"))?;

        let result = sb
            .call_guard_as(
                &sb.owner,
                "set_rules",
                json!({"agent_id": AGENT_ID, "rules": rules}),
                ONE_YOCTO,
            )
            .await?;
        assert_contract_panic(&result, invalid)
            .with_context(|| format!("set_rules with sz_decimals {sz_decimals}"))?;
    }
    // Nothing was stored: no new agent, same rules, nothing pending.
    assert_eq!(sb.status().await?, status_before);
    assert_eq!(
        sb.view_guard("get_rules", json!({"agent_id": STRANGER_ID}))
            .await?,
        Value::Null
    );
    assert_eq!(sb.agent_state().await?, state_before);
    assert_eq!(state_before["pending"], Value::Null);
    Ok(())
}
