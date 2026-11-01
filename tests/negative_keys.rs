//! Negative key tests on a local
//! near-workspaces sandbox. Sandbox only. Not audited.
//!
//! `agent-1.test.near` holds ONE key: a function-call key with receiver `clawguard.test.near`
//! and methods `["propose_order"]`. `guardian.test.near` holds one for `["pause"]`. Every
//! attempt below must fail, for the stated reason:
//! * the protocol refuses the transaction before anything runs (nearcore
//!   `InvalidAccessKeyError`): any action but one function call is `RequiresFullAccess`, an
//!   unlisted method is `MethodNameMismatch`, another contract is `ReceiverMismatch`, any
//!   deposit is `DepositWithFunctionCall`. A refused transaction is never included in a block,
//!   so it burns no gas and changes nothing;
//! * or the guard refuses the call (`ERR_NOT_AGENT`) and stores nothing.
//!
//! The MPC derives keys from the caller account, so even a full-access key on the agent
//! account (simulated with a sandbox state patch) only yields signatures from agent-1's own
//! derived address, never from the guard's.
//!
//! Markers (1)–(5) in the comments are the acceptance items: the agent key cannot
//! (1) transfer NEAR, (2) call admin methods, (3) call any other contract, (4) add or delete
//! keys, (5) deploy code.

mod common;

use anyhow::{Context, Result};
use common::*;
use near_workspaces::types::{AccessKeyPermission, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account};
use serde_json::{Value, json};

use KeyRejection::{
    DepositWithFunctionCall, MethodNameMismatch, ReceiverMismatch, RequiresFullAccess,
};

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

/// The `sign` arguments of the MPC interface for a `0x…` payload hash.
fn mpc_sign_args(path: &str, payload_hash: &str) -> Value {
    json!({"request": {
        "path": path,
        "payload_v2": {"Ecdsa": payload_hash.trim_start_matches("0x")},
        "domain_id": 0
    }})
}

/// The account's keys as (public key, is full access), sorted.
async fn keys_of(account: &Account) -> Result<Vec<(String, bool)>> {
    let mut keys: Vec<(String, bool)> = account
        .view_access_keys()
        .await?
        .into_iter()
        .map(|info| {
            let full = matches!(info.access_key.permission, AccessKeyPermission::FullAccess);
            (info.public_key.to_string(), full)
        })
        .collect();
    keys.sort();
    Ok(keys)
}

#[tokio::test]
async fn agent_key_cannot_move_funds_deploy_or_manage_keys() -> Result<()> {
    let sb = setup().await?;
    let agent_id = sb.agent.id().clone();
    let agent_balance = sb.agent.view_account().await?.balance;
    let keys_before = keys_of(&sb.agent).await?;
    assert_eq!(keys_before.len(), 1);
    assert!(
        !keys_before[0].1,
        "the agent must not hold a full-access key"
    );

    let own_key = sb.agent.secret_key().public_key();
    let new_key = SecretKey::from_random(KeyType::ED25519).public_key();
    let wasm_path = &claw_guard_tests::contract_wasm()
        .map_err(anyhow::Error::msg)?
        .mock_mpc;
    let wasm = std::fs::read(wasm_path).with_context(|| wasm_path.display().to_string())?;

    // (1) Move NEAR out: to the owner, and even to the key's own receiver.
    assert_rejected_by_protocol(
        sb.agent
            .transfer_near(sb.owner.id(), NearToken::from_millinear(100))
            .await,
        RequiresFullAccess,
    )?;
    assert_rejected_by_protocol(
        sb.agent
            .batch(sb.guard.id())
            .transfer(NearToken::from_yoctonear(1))
            .transact()
            .await,
        RequiresFullAccess,
    )?;
    // (4) Add a full-access key, add a key for another contract, delete its own key.
    assert_rejected_by_protocol(
        sb.agent
            .batch(&agent_id)
            .add_key(new_key.clone(), AccessKey::full_access())
            .transact()
            .await,
        RequiresFullAccess,
    )?;
    assert_rejected_by_protocol(
        sb.agent
            .batch(&agent_id)
            .add_key(
                new_key,
                AccessKey::function_call_access(sb.mpc.id(), &[], None),
            )
            .transact()
            .await,
        RequiresFullAccess,
    )?;
    assert_rejected_by_protocol(
        sb.agent
            .batch(&agent_id)
            .delete_key(own_key)
            .transact()
            .await,
        RequiresFullAccess,
    )?;
    // (5) Deploy code onto itself; delete itself (sending its balance away); create a
    // sub-account.
    assert_rejected_by_protocol(
        sb.agent.batch(&agent_id).deploy(&wasm).transact().await,
        RequiresFullAccess,
    )?;
    assert_rejected_by_protocol(
        sb.agent
            .batch(&agent_id)
            .delete_account(sb.owner.id())
            .transact()
            .await,
        RequiresFullAccess,
    )?;
    let sub_account: near_workspaces::AccountId = format!("sub.{agent_id}").parse()?;
    assert_rejected_by_protocol(
        sb.agent
            .batch(&sub_account)
            .create_account()
            .transfer(NearToken::from_millinear(100))
            .transact()
            .await,
        RequiresFullAccess,
    )?;

    // The key signs exactly one function call: not even propose_order batched with a transfer.
    let proposal = hl_order("BTC", true, "1000", "0.001", sb.now_ms().await?);
    assert_rejected_by_protocol(
        sb.agent
            .batch(sb.guard.id())
            .call(
                near_workspaces::operations::Function::new("propose_order")
                    .args_json(json!({"proposal": proposal}))
                    .gas(PROPOSE_GAS),
            )
            .transfer(NearToken::from_yoctonear(1))
            .transact()
            .await,
        RequiresFullAccess,
    )?;
    // Attaching a deposit to its one allowed method: 1 yoctoNEAR (the owner-method proof)
    // and 0.1 NEAR. (The protocol checks balance and allowance before the key permission, so a
    // deposit above the agent's 0.5 NEAR would be refused as NotEnoughBalance instead.)
    for deposit in [ONE_YOCTO, NearToken::from_millinear(100)] {
        assert_rejected_by_protocol(
            sb.agent
                .call(sb.guard.id(), "propose_order")
                .args_json(json!({"proposal": proposal}))
                .deposit(deposit)
                .gas(PROPOSE_GAS)
                .transact()
                .await,
            DepositWithFunctionCall,
        )?;
    }

    // Nothing ran: the agent was not even charged gas, its keys are as before, no receipt
    // exists.
    assert_eq!(sb.agent.view_account().await?.balance, agent_balance);
    assert_eq!(keys_of(&sb.agent).await?, keys_before);
    assert!(
        sb.worker.view_account(&sub_account).await.is_err(),
        "{sub_account} must not exist"
    );
    assert_eq!(sb.status().await?["receipts_count"], "0");

    // The one thing the key can do still works.
    let decision = expect_allowed(sb.propose(&proposal).await?)?;
    assert_eq!(decision["receipt_id"], "1");
    Ok(())
}

#[tokio::test]
async fn agent_key_cannot_call_admin_methods() -> Result<()> {
    let sb = setup().await?;
    let status_before = sb.status().await?;
    let state_before = sb.agent_state().await?;
    let mut loosened = state_before["rules"].clone();
    loosened["max_leverage"] = json!(50);

    // (2) Every guard method except propose_order, with well-formed arguments, as the agent's key
    // would send them (no deposit: it cannot attach one).
    let calls: Vec<(&str, Value)> = vec![
        (
            "set_rules",
            json!({"agent_id": AGENT_ID, "rules": loosened}),
        ),
        ("unpause", json!({})),
        (
            "register_agent",
            json!({"agent_id": STRANGER_ID, "rules": state_before["rules"]}),
        ),
        ("pause", json!({"reason": "agent"})),
        ("remove_agent", json!({"agent_id": AGENT_ID})),
        ("confirm_rules", json!({"agent_id": AGENT_ID})),
        ("cancel_pending_rules", json!({"agent_id": AGENT_ID})),
        ("set_guardian", json!({"guardian_id": AGENT_ID})),
        (
            "set_sign_config",
            json!({"sign_deposit_yocto": "0", "sign_gas_tgas": 1}),
        ),
        ("on_signed", json!({"receipt_id": "1"})),
        (
            "new",
            json!({
                "owner_id": AGENT_ID,
                "guardian_id": null,
                "mpc_contract_id": MPC_ID,
                "sign_deposit_yocto": "1",
                "sign_gas_tgas": SIGN_GAS_TGAS,
                "loosen_delay_sec": 0
            }),
        ),
    ];
    for (method, args) in &calls {
        assert_rejected_by_protocol(
            sb.call_guard_as(&sb.agent, method, args.clone(), NO_DEPOSIT)
                .await,
            MethodNameMismatch(method),
        )
        .with_context(|| format!("agent calling {method}"))?;
    }
    // With the 1 yoctoNEAR the owner methods require, the deposit is refused first.
    for (method, args) in calls.iter().take(3) {
        assert_rejected_by_protocol(
            sb.call_guard_as(&sb.agent, method, args.clone(), ONE_YOCTO)
                .await,
            DepositWithFunctionCall,
        )
        .with_context(|| format!("agent calling {method} with 1 yocto"))?;
    }

    // Nothing changed: same status, same rules version, nothing pending.
    assert_eq!(sb.status().await?, status_before);
    assert_eq!(sb.agent_state().await?, state_before);
    assert_eq!(state_before["rules_version"], 1);
    assert_eq!(state_before["pending"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn agent_cannot_get_a_guard_signature_by_calling_the_mpc() -> Result<()> {
    let sb = setup().await?;
    let proposal = hl_order("BTC", true, "1000", "0.001", sb.now_ms().await?);
    // The exact payload the guard would sign for this order.
    let preview = sb
        .view_guard(
            "preview_payload",
            json!({"agent_id": AGENT_ID, "proposal": proposal}),
        )
        .await?;
    let payload_hash = preview["Ok"].as_str().context("preview Ok")?.to_owned();
    let sign_args = mpc_sign_args(HL_PATH, &payload_hash);

    // (3) Its function-call key cannot call any other contract.
    assert_rejected_by_protocol(
        sb.agent
            .call(sb.mpc.id(), "sign")
            .args_json(&sign_args)
            .gas(PROPOSE_GAS)
            .transact()
            .await,
        ReceiverMismatch {
            tx_receiver: MPC_ID,
            ak_receiver: CONTRACT_ID,
        },
    )?;
    // With the deposit the MPC asks for, the deposit is refused first.
    assert_rejected_by_protocol(
        sb.agent
            .call(sb.mpc.id(), "sign")
            .args_json(&sign_args)
            .deposit(ONE_YOCTO)
            .gas(PROPOSE_GAS)
            .transact()
            .await,
        DepositWithFunctionCall,
    )?;
    assert_eq!(sb.sign_count().await?, 0);

    // The MPC derives a key per caller: agent-1's addresses are not the guard's on any path.
    for path in [HL_PATH, BASE_PATH] {
        let agent_address = sb.derived_address(AGENT_ID, path).await?;
        let guard_address = sb.derived_address(CONTRACT_ID, path).await?;
        assert_ne!(agent_address, guard_address, "path {path}");
    }

    // Even with a full-access key on agent-1 (simulated: an attacker took over the account),
    // calling the MPC directly signs with agent-1's own derived key, which no venue approved.
    let attacker_key = sb.patch_in_full_access_key(sb.agent.id()).await?;
    let attacker = Account::from_secret_key(sb.agent.id().clone(), attacker_key, &sb.worker);
    let result = attacker
        .call(sb.mpc.id(), "sign")
        .args_json(&sign_args)
        .deposit(ONE_YOCTO)
        .gas(PROPOSE_GAS)
        .transact()
        .await?;
    let response = decision_json(result)?;
    let big_r = response["big_r"]["affine_point"]
        .as_str()
        .context("big_r")?;
    let recovery_id = u8::try_from(response["recovery_id"].as_u64().context("recovery_id")?)?;
    let direct_signer = recover_address(
        &decode_hex32(&payload_hash)?,
        decode_hex32(&big_r[2..])?,
        decode_hex32(response["s"]["scalar"].as_str().context("s")?)?,
        recovery_id,
    )?;
    assert_eq!(direct_signer, sb.derived_address(AGENT_ID, HL_PATH).await?);
    assert_ne!(
        direct_signer,
        sb.derived_address(CONTRACT_ID, HL_PATH).await?
    );

    // Only the guard's own request yields the guard's address, for the same payload.
    let decision = expect_allowed(sb.propose(&proposal).await?)?;
    assert_eq!(
        recover_receipt_signer(&payload_hash, &decision["signature"], 27)?,
        sb.derived_address(CONTRACT_ID, HL_PATH).await?
    );
    assert_eq!(sb.sign_count().await?, 2);
    Ok(())
}

#[tokio::test]
async fn unregistered_accounts_get_err_not_agent_and_no_receipt() -> Result<()> {
    let sb = setup().await?;
    // A key for propose_order is not enough: the guard checks the caller is registered.
    let stranger = create_function_call_account(
        &sb.worker,
        &sb.root,
        STRANGER_ID,
        NearToken::from_millinear(500),
        sb.guard.id(),
        &["propose_order"],
    )
    .await?;
    let proposal = hl_order("BTC", true, "1000", "0.001", sb.now_ms().await?);
    let result = stranger
        .call(sb.guard.id(), "propose_order")
        .args_json(json!({"proposal": proposal}))
        .gas(PROPOSE_GAS)
        .transact()
        .await?;
    assert_contract_panic(&result, "ERR_NOT_AGENT")?;
    assert!(result.logs().is_empty(), "no event: {:?}", result.logs());
    assert!(outcomes_on(&result, MPC_ID).is_empty());
    // preview_payload refuses the stranger too.
    let preview = sb
        .guard
        .view("preview_payload")
        .args_json(json!({"agent_id": STRANGER_ID, "proposal": proposal}))
        .await;
    let preview_error = format!("{:?}", preview.err().context("preview must fail")?);
    assert!(preview_error.contains("ERR_NOT_AGENT"), "{preview_error}");

    // Nothing stored and agent-1's counters untouched.
    assert_eq!(sb.status().await?["receipts_count"], "0");
    assert_eq!(sb.receipt("1").await?, Value::Null);
    assert_eq!(sb.sign_count().await?, 0);
    assert_eq!(sb.agent_state().await?["orders_today"], 0);
    assert_eq!(
        sb.view_guard("get_rules", json!({"agent_id": STRANGER_ID}))
            .await?,
        Value::Null
    );

    // A removed agent is unregistered as well.
    let result = sb
        .call_guard_as(
            &sb.owner,
            "remove_agent",
            json!({"agent_id": AGENT_ID}),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(event_names(&expect_success(result)?)?, ["agent_removed"]);
    let result = sb.propose(&proposal).await?;
    assert_contract_panic(&result, "ERR_NOT_AGENT")?;
    let status = sb.status().await?;
    assert_eq!(status["receipts_count"], "0");
    assert_eq!(status["agents_count"], 0);
    assert_eq!(sb.agent_state().await?, Value::Null);
    Ok(())
}

#[tokio::test]
async fn guardian_key_can_pause_but_not_unpause() -> Result<()> {
    let sb = setup().await?;
    let guardian_balance = sb.guardian.view_account().await?.balance;
    // The guardian key is for `pause` only.
    let proposal = hl_order("BTC", true, "1000", "0.001", sb.now_ms().await?);
    let refused: [(&str, Value); 4] = [
        ("unpause", json!({})),
        ("propose_order", json!({"proposal": proposal})),
        (
            "set_rules",
            json!({"agent_id": AGENT_ID, "rules": sb.agent_state().await?["rules"]}),
        ),
        ("set_guardian", json!({"guardian_id": null})),
    ];
    for (method, args) in &refused {
        assert_rejected_by_protocol(
            sb.call_guard_as(&sb.guardian, method, args.clone(), NO_DEPOSIT)
                .await,
            MethodNameMismatch(method),
        )
        .with_context(|| format!("guardian calling {method}"))?;
    }
    assert_rejected_by_protocol(
        sb.call_guard_as(&sb.guardian, "unpause", json!({}), ONE_YOCTO)
            .await,
        DepositWithFunctionCall,
    )?;
    assert_rejected_by_protocol(
        sb.guardian
            .transfer_near(sb.owner.id(), NearToken::from_millinear(100))
            .await,
        RequiresFullAccess,
    )?;
    assert_eq!(sb.guardian.view_account().await?.balance, guardian_balance);

    // Pause works with the function-call key alone (no deposit).
    let reason = "watch: new function-call key";
    let result = sb.guardian_pause(reason).await?;
    assert_eq!(
        events(&expect_success(result)?)?,
        [
            json!({"standard": "clawguard", "version": "1.0.0", "event": "paused",
                "data": [{"by": GUARDIAN_ID, "reason": reason}]})
        ]
    );
    let status = sb.status().await?;
    assert_eq!(status["paused"], true);
    assert_eq!(status["pause_reason"], reason);

    // Unpausing is still refused, so the pause holds and blocks the agent.
    assert_rejected_by_protocol(
        sb.call_guard_as(&sb.guardian, "unpause", json!({}), NO_DEPOSIT)
            .await,
        MethodNameMismatch("unpause"),
    )?;
    assert_eq!(sb.status().await?["paused"], true);
    expect_blocked(
        sb.propose(&proposal).await?,
        "PAUSED",
        &format!("Blocked by your rule: agent is paused ({reason})"),
    )?;
    assert_eq!(sb.sign_count().await?, 0);
    Ok(())
}
