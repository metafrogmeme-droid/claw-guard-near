//! Sandbox end-to-end flow:
//! claw-guard + mock-mpc on a local near-workspaces node. Sandbox only. Not audited.
//!
//! * allowed HL order → receipt `Signed`; the signature recovers to
//!   `mock-mpc.derived_address("clawguard.test.near", "hl-testnet-1")`;
//! * allowed EVM transfer → `Signed` on path `base-sepolia-1`; the signed raw tx recovers to
//!   the `base-sepolia-1` address;
//! * mock MPC failure → `SignFailed`, counters unchanged;
//! * blocked order → receipt `Blocked`, no call to the MPC at all.
//!
//! Each test prints `GAS …` lines (run with `--nocapture`) for the gas table in the docs.

mod common;

use anyhow::{Context, Result, ensure};
use common::*;
use near_workspaces::Account;
use near_workspaces::types::{AccessKeyPermission, Gas};
use serde_json::{Value, json};

const ALLOWED: &str = "Allowed: within your limits";
const NOT_SIGNED: &str = "Not signed: the signature request failed";
/// offchain/test/vectors/derive_sandbox.json.
const GUARD_HL_ADDRESS: &str = "0xb966992b0783f42b2f78a7a94c8f190f03758a96";
const GUARD_BASE_ADDRESS: &str = "0x208293469e00a4e3775e131195b9a2e876202f60";

/// Asserts that `account` has exactly one key: a function-call key for `receiver`/`methods`.
async fn assert_only_function_call_key(
    account: &Account,
    receiver: &str,
    methods: &[&str],
) -> Result<()> {
    let keys = account.view_access_keys().await?;
    ensure!(keys.len() == 1, "{} has {} keys", account.id(), keys.len());
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(permission) => {
            ensure!(
                permission.receiver_id == receiver,
                "receiver {}",
                permission.receiver_id
            );
            ensure!(
                permission.method_names == methods,
                "methods {:?}",
                permission.method_names
            );
            ensure!(permission.allowance.is_some(), "allowance must be capped");
        }
        AccessKeyPermission::FullAccess => anyhow::bail!("{} has a full-access key", account.id()),
    }
    Ok(())
}

/// Gas burnt by the single receipt that ran on `account`.
fn single_outcome_gas(
    result: &near_workspaces::result::ExecutionFinalResult,
    account: &str,
) -> Result<Gas> {
    let outcomes = outcomes_on(result, account);
    ensure!(
        outcomes.len() == 1,
        "{} receipts ran on {account}",
        outcomes.len()
    );
    Ok(outcomes[0].gas_burnt)
}

#[tokio::test]
async fn setup_creates_the_brief_accounts_and_keys() -> Result<()> {
    let sb = setup().await?;
    assert_only_function_call_key(&sb.agent, CONTRACT_ID, &["propose_order"]).await?;
    assert_only_function_call_key(&sb.guardian, CONTRACT_ID, &["pause"]).await?;

    assert_eq!(
        sb.status().await?,
        json!({
            "owner": OWNER_ID,
            "guardian": GUARDIAN_ID,
            "paused": false,
            "pause_reason": null,
            "mpc_contract_id": MPC_ID,
            "agents_count": 1,
            "receipts_count": "0"
        })
    );
    assert_eq!(
        sb.view_guard("get_paths", json!({})).await?,
        json!([["HlTestnet", HL_PATH], ["BaseSepolia", BASE_PATH]])
    );
    let state = sb.agent_state().await?;
    assert_eq!(state["rules_version"], 1);
    assert_eq!(state["rules"]["markets"][0]["sz_decimals"], 5);
    assert_eq!(state["orders_today"], 0);
    assert_eq!(state["spent_today"], "0");

    // The mock derives the same addresses as the off-chain code, per caller and per path.
    assert_eq!(
        sb.derived_address(CONTRACT_ID, HL_PATH).await?,
        GUARD_HL_ADDRESS
    );
    assert_eq!(
        sb.derived_address(CONTRACT_ID, BASE_PATH).await?,
        GUARD_BASE_ADDRESS
    );
    assert_ne!(
        sb.derived_address(AGENT_ID, HL_PATH).await?,
        GUARD_HL_ADDRESS
    );
    assert_eq!(sb.sign_count().await?, 0);
    Ok(())
}

#[tokio::test]
async fn allowed_hl_order_is_signed_by_the_guard_key() -> Result<()> {
    let sb = setup().await?;
    let nonce_ms = sb.now_ms().await?;
    let proposal = hl_order("BTC", true, "1000", "0.001", nonce_ms);

    // preview_payload stores nothing and predicts the payload hash.
    let preview = sb
        .view_guard(
            "preview_payload",
            json!({"agent_id": AGENT_ID, "proposal": proposal}),
        )
        .await?;
    let previewed_hash = preview["Ok"].as_str().context("preview Ok")?.to_owned();

    let result = sb.propose(&proposal).await?;
    println!(
        "GAS propose_order allowed HL (300 Tgas attached): {}",
        gas_breakdown(&result)
    );
    println!(
        "GAS mock-mpc sign (HL): {} Tgas",
        tgas(single_outcome_gas(&result, MPC_ID)?)
    );
    assert_eq!(event_names(&result)?, ["order_allowed", "signature_ready"]);
    let all_events = events(&result)?;
    assert_eq!(
        all_events[0],
        json!({"standard": "clawguard", "version": "1.0.0", "event": "order_allowed", "data": [{
            "receipt_id": "1",
            "agent_id": AGENT_ID,
            "target": "HlTestnet",
            "payload_hash": previewed_hash,
            "derivation_path": HL_PATH
        }]})
    );
    assert_eq!(
        all_events[1]["data"],
        json!([{"receipt_id": "1", "payload_hash": previewed_hash}])
    );

    let decision = decision_json(result)?;
    println!("DECISION allowed HL: {decision}");
    assert_eq!(decision["allowed"], true);
    assert_eq!(decision["receipt_id"], "1");
    assert_eq!(decision["rule_code"], Value::Null);
    assert_eq!(decision["message"], ALLOWED);
    let sig = &decision["signature"];
    assert!(matches!(sig["v"].as_u64(), Some(27 | 28)), "HL v: {sig}");

    let receipt = sb.receipt("1").await?;
    println!("RECEIPT allowed HL: {receipt}");
    assert_eq!(receipt["status"], "Signed");
    assert_eq!(receipt["agent_id"], AGENT_ID);
    assert_eq!(receipt["target"], "HlTestnet");
    assert_eq!(receipt["proposal"], proposal);
    assert_eq!(receipt["rule_code"], Value::Null);
    assert_eq!(receipt["message"], ALLOWED);
    assert_eq!(receipt["derivation_path"], HL_PATH);
    assert_eq!(receipt["rules_version"], 1);
    assert_eq!(&receipt["signature"], sig);
    assert_eq!(receipt["payload_hash"], previewed_hash);
    assert_eq!(
        receipt["signed_body"],
        r#"{"type":"order","orders":[{"a":3,"b":true,"p":"1000","s":"0.001","r":false,"t":{"limit":{"tif":"Gtc"}}}],"grouping":"na"}"#
    );

    // The signature recovers to the guard's own derived address for the HL path.
    let expected = sb.derived_address(CONTRACT_ID, HL_PATH).await?;
    assert_eq!(expected, GUARD_HL_ADDRESS);
    assert_eq!(recover_receipt_signer(&previewed_hash, sig, 27)?, expected);
    assert_eq!(sb.sign_count().await?, 1);

    // px 1000 × sz 0.001 = 1 quote unit = 1_000_000 counter units.
    let state = sb.agent_state().await?;
    assert_eq!(state["spent_today"], "1000000");
    assert_eq!(state["orders_today"], 1);
    assert_eq!(state["last_hl_nonce_ms"], nonce_ms.to_string());
    Ok(())
}

#[tokio::test]
async fn allowed_evm_transfer_is_signed_on_the_base_path() -> Result<()> {
    let sb = setup().await?;
    // Same request as offchain/test/vectors/evm_transfers.json "usdc_1_to_owner" (viem 2.57.7).
    let proposal = evm_transfer(USDC_SYMBOL, RECEIVER, 1_000_000, 0);
    let result = sb.propose(&proposal).await?;
    println!(
        "GAS propose_order allowed EVM (300 Tgas attached): {}",
        gas_breakdown(&result)
    );
    println!(
        "GAS mock-mpc sign (EVM): {} Tgas",
        tgas(single_outcome_gas(&result, MPC_ID)?)
    );
    assert_eq!(event_names(&result)?, ["order_allowed", "signature_ready"]);

    let decision = decision_json(result)?;
    println!("DECISION allowed EVM: {decision}");
    assert_eq!(decision["allowed"], true);
    assert_eq!(decision["message"], ALLOWED);
    let sig = decision["signature"].clone();
    let y_parity = sig["v"].as_u64().context("v")?;
    assert!(y_parity <= 1, "EIP-1559 v is the y-parity: {sig}");

    let receipt = sb.receipt("1").await?;
    println!("RECEIPT allowed EVM: {receipt}");
    assert_eq!(receipt["status"], "Signed");
    assert_eq!(receipt["target"], "BaseSepolia");
    assert_eq!(receipt["derivation_path"], BASE_PATH);
    assert_eq!(receipt["signature"], sig);
    let unsigned_hex = receipt["signed_body"].as_str().context("signed_body")?;
    let payload_hash = receipt["payload_hash"].as_str().context("payload_hash")?;
    assert_eq!(
        unsigned_hex,
        "0x02f86e83014a3480830f4240843b9aca0082fde894036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f4240c0"
    );
    assert_eq!(
        payload_hash,
        "0x999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392"
    );
    let unsigned = decode_hex(unsigned_hex)?;
    assert_eq!(
        format!("0x{}", encode_hex(&keccak256(&unsigned))),
        payload_hash
    );

    // Build the raw signed tx as the relayer does, then recover it the way a node would.
    let signed = signed_eip1559_tx(
        &unsigned,
        u8::try_from(y_parity)?,
        decode_hex32(sig["r"].as_str().context("r")?)?,
        decode_hex32(sig["s"].as_str().context("s")?)?,
    )?;
    let (chain_id, signing_hash, sender) = recover_eip1559_sender(&signed)?;
    println!("RAW signed EVM tx: 0x{}", encode_hex(&signed));
    assert_eq!(chain_id, BASE_SEPOLIA_CHAIN_ID);
    assert_eq!(format!("0x{}", encode_hex(&signing_hash)), payload_hash);
    let expected = sb.derived_address(CONTRACT_ID, BASE_PATH).await?;
    assert_eq!(expected, GUARD_BASE_ADDRESS);
    assert_eq!(sender, expected);
    assert_eq!(sb.sign_count().await?, 1);

    let state = sb.agent_state().await?;
    assert_eq!(state["spent_today"], "1000000");
    assert_eq!(state["orders_today"], 1);
    assert_eq!(state["last_evm_nonce"], "0");
    Ok(())
}

#[tokio::test]
async fn mpc_failure_records_sign_failed_and_keeps_the_counters() -> Result<()> {
    let sb = setup().await?;
    let before = sb.agent_state().await?;
    sb.set_mpc_fail(true).await?;

    let nonce_ms = sb.now_ms().await?;
    let proposal = hl_order("BTC", true, "1000", "0.001", nonce_ms);
    let result = sb.propose(&proposal).await?;
    println!(
        "GAS propose_order HL with failing MPC: {}",
        gas_breakdown(&result)
    );
    // The mock's sign receipt failed; the guard's callback ran and the transaction succeeded.
    let mock_outcomes = outcomes_on(&result, MPC_ID);
    assert_eq!(mock_outcomes.len(), 1);
    assert!(mock_outcomes[0].is_failure());
    assert_eq!(event_names(&result)?, ["order_allowed", "signature_failed"]);
    assert_eq!(
        events(&result)?[1]["data"],
        json!([{"receipt_id": "1", "reason": "the signature request did not complete"}])
    );

    let decision = decision_json(result)?;
    assert_eq!(
        decision,
        json!({
            "allowed": false,
            "receipt_id": "1",
            "rule_code": null,
            "message": NOT_SIGNED,
            "signature": null
        })
    );
    let receipt = sb.receipt("1").await?;
    assert_eq!(receipt["status"], "SignFailed");
    assert_eq!(receipt["rule_code"], Value::Null);
    assert_eq!(receipt["message"], NOT_SIGNED);
    assert_eq!(receipt["signature"], Value::Null);
    assert_eq!(sb.sign_count().await?, 0);

    // The reservation was released: spend and order count are as before the proposal. The
    // nonce stays consumed, so re-sending the same order is stale.
    let after = sb.agent_state().await?;
    assert_eq!(after["spent_today"], before["spent_today"]);
    assert_eq!(after["orders_today"], before["orders_today"]);
    assert_eq!(after["spent_today"], "0");
    assert_eq!(after["orders_today"], 0);
    assert_eq!(after["last_hl_nonce_ms"], nonce_ms.to_string());

    let replay = decision_of(&sb, &proposal).await?;
    assert_eq!(replay["rule_code"], "STALE_NONCE");
    assert_eq!(replay["receipt_id"], "2");

    // With the MPC back, the next order is signed and counted once.
    sb.set_mpc_fail(false).await?;
    let next = decision_of(&sb, &hl_order("BTC", true, "1000", "0.001", nonce_ms + 1)).await?;
    assert_eq!(next["allowed"], true);
    assert_eq!(next["receipt_id"], "3");
    assert_eq!(sb.receipt("3").await?["status"], "Signed");
    assert_eq!(sb.sign_count().await?, 1);
    let state = sb.agent_state().await?;
    assert_eq!(state["spent_today"], "1000000");
    assert_eq!(state["orders_today"], 1);
    Ok(())
}

#[tokio::test]
async fn blocked_orders_store_receipts_and_never_call_the_mpc() -> Result<()> {
    let sb = setup().await?;
    let nonce_ms = sb.now_ms().await?;

    let result = sb
        .propose(&hl_order("DOGE", true, "0.1", "100", nonce_ms))
        .await?;
    println!(
        "GAS propose_order blocked HL (MARKET_NOT_ALLOWED): {}",
        gas_breakdown(&result)
    );
    assert!(
        outcomes_on(&result, MPC_ID).is_empty(),
        "a blocked order reached the MPC"
    );
    let blocked_message = "Blocked by your rule: market DOGE is not on your list";
    assert_eq!(
        events(&result)?,
        [
            json!({"standard": "clawguard", "version": "1.0.0", "event": "order_blocked", "data": [{
                "receipt_id": "1",
                "agent_id": AGENT_ID,
                "target": "HlTestnet",
                "rule_code": "MARKET_NOT_ALLOWED",
                "message": blocked_message
            }]})
        ]
    );
    let decision = decision_json(result)?;
    assert_eq!(
        decision,
        json!({
            "allowed": false,
            "receipt_id": "1",
            "rule_code": "MARKET_NOT_ALLOWED",
            "message": blocked_message,
            "signature": null
        })
    );
    let receipt = sb.receipt("1").await?;
    assert_eq!(receipt["status"], "Blocked");
    assert_eq!(receipt["rule_code"], "MARKET_NOT_ALLOWED");
    assert_eq!(receipt["message"], blocked_message);
    assert_eq!(receipt["payload_hash"], Value::Null);
    assert_eq!(receipt["signed_body"], Value::Null);
    assert_eq!(receipt["signature"], Value::Null);

    // An injected transfer to an unlisted receiver: blocked, address shown in lowercase.
    let result = sb
        .propose(&evm_transfer(
            USDC_SYMBOL,
            "0xBAD0000000000000000000000000000000000000",
            1_000_000,
            0,
        ))
        .await?;
    println!(
        "GAS propose_order blocked EVM (RECEIVER_NOT_ALLOWED): {}",
        gas_breakdown(&result)
    );
    assert!(
        outcomes_on(&result, MPC_ID).is_empty(),
        "a blocked order reached the MPC"
    );
    let decision = decision_json(result)?;
    assert_eq!(decision["receipt_id"], "2");
    assert_eq!(decision["rule_code"], "RECEIVER_NOT_ALLOWED");
    assert_eq!(
        decision["message"],
        "Blocked by your rule: receiver 0xbad0000000000000000000000000000000000000 is not on your list"
    );
    assert_eq!(sb.receipt("2").await?["status"], "Blocked");

    // Nothing was signed or reserved, and both receipts persisted (no panic, no rollback).
    assert_eq!(sb.sign_count().await?, 0);
    let state = sb.agent_state().await?;
    assert_eq!(state["orders_today"], 0);
    assert_eq!(state["spent_today"], "0");
    assert_eq!(state["last_hl_nonce_ms"], Value::Null);
    assert_eq!(sb.status().await?["receipts_count"], "2");
    Ok(())
}

#[tokio::test]
async fn mock_sign_fits_in_the_static_sign_gas() -> Result<()> {
    let sb = setup().await?;
    // Just above what propose_order requires before it creates the promise
    // (sign 100 + callback 20 + margin 10 Tgas, plus what it used so far), so the mock gets
    // about its static 100 Tgas and no large share of unused gas.
    let gas = Gas::from_tgas(SIGN_GAS_TGAS + 20 + 10 + 10);
    let nonce_ms = sb.now_ms().await?;
    let result = sb
        .propose_with_gas(&hl_order("ETH", false, "2000", "0.01", nonce_ms), gas)
        .await?;
    println!(
        "GAS propose_order allowed HL ({} Tgas attached): {}",
        tgas(gas),
        gas_breakdown(&result)
    );
    let sign_gas = single_outcome_gas(&result, MPC_ID)?;
    assert!(
        sign_gas < Gas::from_tgas(SIGN_GAS_TGAS),
        "mock sign burnt {} Tgas",
        tgas(sign_gas)
    );
    let decision = decision_json(result)?;
    assert_eq!(decision["allowed"], true, "{decision}");
    assert_eq!(sb.receipt("1").await?["status"], "Signed");
    assert_eq!(sb.sign_count().await?, 1);
    Ok(())
}

/// Proposes and returns the decision.
async fn decision_of(sb: &Sandbox, proposal: &Value) -> Result<Value> {
    decision_json(sb.propose(proposal).await?)
}
