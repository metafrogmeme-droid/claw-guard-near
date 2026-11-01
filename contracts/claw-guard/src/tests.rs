//! Contract-level unit tests on the near-sdk mocked blockchain: init guards, access
//! control, the propose → sign → on_signed flow, receipts, events, views, the HL/EVM vectors
//! through the contract, tamper resistance and a 2000-case property test.
//!
//! Note: on the mocked blockchain a panic does not roll back storage the way a real receipt
//! failure does, so "nothing stored" tests rely on the contract panicking before it writes.

use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};

use k256::ecdsa::SigningKey;
use near_sdk::json_types::{U64, U128};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::{AccountId, Gas, NearToken, PromiseOrValue, PromiseResult, env};

use crate::ClawGuard;
use crate::errors::{self, RuleCode};
use crate::events::logged_events;
use crate::mpc;
use crate::order::{
    MAX_EVM_NONCE, MAX_FEE_PER_GAS_WEI, MAX_GAS_LIMIT, MAX_MEMO_BYTES, MAX_PERP_DECIMALS,
};
use crate::rules::{NS_PER_DAY, RECEIPT_STORAGE_RESERVE_BYTES, day_of};
use crate::test_fixtures::*;
use crate::types::*;
use crate::util::testing::recover_evm_address;
use crate::util::{encode_hex, encode_hex_0x};

const CONTRACT: &str = "clawguard.test.near";
const MPC: &str = "mock-mpc.test.near";
const OWNER: &str = "owner.test.near";
const AGENT: &str = "agent-1.test.near";
const GUARDIAN: &str = "guardian.test.near";
const STRANGER: &str = "stranger.test.near";
const SIGN_DEPOSIT: u128 = 1;
const SIGN_GAS_TGAS: u64 = 100;
const LOOSEN_DELAY_SEC: u64 = 600;
const ONE_YOCTO_PANIC: &str = "Requires attached deposit of exactly 1 yoctoNEAR";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

// ---- mocked environment ----------------------------------------------------------------------

/// One call's context; `apply` installs it (storage carries over between calls).
#[derive(Clone)]
struct Call {
    predecessor: &'static str,
    deposit: u128,
    now_ns: u64,
    balance: Option<u128>,
    storage_usage: Option<u64>,
    prepaid_tgas: Option<u64>,
}

impl Call {
    fn by(predecessor: &'static str) -> Self {
        Self {
            predecessor,
            deposit: 0,
            now_ns: NOW_NS,
            balance: None,
            storage_usage: None,
            prepaid_tgas: None,
        }
    }

    fn deposit(mut self, yocto: u128) -> Self {
        self.deposit = yocto;
        self
    }

    fn at(mut self, now_ns: u64) -> Self {
        self.now_ns = now_ns;
        self
    }

    fn balance(mut self, yocto: u128) -> Self {
        self.balance = Some(yocto);
        self
    }

    fn storage_usage(mut self, bytes: u64) -> Self {
        self.storage_usage = Some(bytes);
        self
    }

    fn gas(mut self, tgas: u64) -> Self {
        self.prepaid_tgas = Some(tgas);
        self
    }

    fn context(&self) -> near_sdk::VMContext {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id(CONTRACT))
            .signer_account_id(id(self.predecessor))
            .predecessor_account_id(id(self.predecessor))
            .attached_deposit(NearToken::from_yoctonear(self.deposit))
            .block_timestamp(self.now_ns)
            .block_height(1_000);
        if let Some(balance) = self.balance {
            b.account_balance(NearToken::from_yoctonear(balance));
        }
        if let Some(bytes) = self.storage_usage {
            b.storage_usage(bytes);
        }
        if let Some(tgas) = self.prepaid_tgas {
            b.prepaid_gas(Gas::from_tgas(tgas));
        }
        b.build()
    }

    fn apply(&self) {
        near_sdk::testing_env!(self.context(), cached(near_sdk::test_vm_config));
    }

    /// Installs the context with promise results, as for a callback.
    fn apply_with_results(&self, results: Vec<PromiseResult>) {
        near_sdk::testing_env!(
            self.context(),
            cached(near_sdk::test_vm_config),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }
}

/// `make()`, computed once per test thread. `test_vm_config()` parses the runtime config on
/// every call (~16 ms), which dominates the property tests; its type is not exported, hence
/// the `Any` box.
fn cached<T: Clone + 'static>(make: fn() -> T) -> T {
    thread_local! {
        static CACHE: std::cell::RefCell<Option<Box<dyn std::any::Any>>> =
            const { std::cell::RefCell::new(None) };
    }
    CACHE.with(|cache| {
        cache
            .borrow_mut()
            .get_or_insert_with(|| Box::new(make()))
            .downcast_ref::<T>()
            .expect("one cached type per thread")
            .clone()
    })
}

fn clear_storage() {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
}

/// The panic message of `f`, which must panic.
#[track_caller]
fn panic_message(f: impl FnOnce()) -> String {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_default()
}

#[track_caller]
fn expect_panic(expected: &str, f: impl FnOnce()) {
    let message = panic_message(f);
    assert!(
        message.contains(expected),
        "panic {message:?} does not contain {expected:?}"
    );
}

// ---- contract fixtures -----------------------------------------------------------------------

fn new_guard() -> ClawGuard {
    Call::by(CONTRACT).apply();
    clear_storage();
    ClawGuard::new(
        id(OWNER),
        Some(id(GUARDIAN)),
        id(MPC),
        U128(SIGN_DEPOSIT),
        SIGN_GAS_TGAS,
        LOOSEN_DELAY_SEC,
    )
}

fn setup_with(rules: Rules) -> ClawGuard {
    let mut c = new_guard();
    Call::by(OWNER).deposit(1).apply();
    c.register_agent(id(AGENT), rules);
    c
}

fn setup() -> ClawGuard {
    setup_with(rules())
}

fn agent_state(c: &ClawGuard) -> AgentState {
    c.agents.get(&id(AGENT)).expect("registered").state.clone()
}

fn propose_with(c: &mut ClawGuard, call: Call, proposal: Proposal) -> PromiseOrValue<Decision> {
    call.apply();
    c.propose_order(proposal)
}

/// Proposes as the agent at `NOW_NS`; the order must be blocked with `code`.
#[track_caller]
fn propose_blocked(c: &mut ClawGuard, proposal: Proposal, code: RuleCode) -> Decision {
    blocked_with(c, Call::by(AGENT), proposal, code)
}

#[track_caller]
fn blocked_with(c: &mut ClawGuard, call: Call, proposal: Proposal, code: RuleCode) -> Decision {
    match propose_with(c, call, proposal) {
        PromiseOrValue::Value(decision) => {
            assert!(!decision.allowed);
            assert_eq!(decision.rule_code, Some(code), "{}", decision.message);
            assert!(decision.signature.is_none());
            assert!(get_created_receipts().is_empty(), "no promise for a block");
            decision
        }
        PromiseOrValue::Promise(_) => panic!("expected {code:?}, got a signature request"),
    }
}

/// A `sign` call the contract scheduled.
#[derive(Debug)]
struct SignCall {
    args: Value,
    deposit: NearToken,
    gas: Gas,
    /// Share of the unused gas this call gets.
    weight: u64,
}

/// The `sign` calls and `on_signed` callbacks scheduled by the last call.
fn scheduled() -> (Vec<SignCall>, Vec<(Value, Gas)>) {
    let mut signs = Vec::new();
    let mut callbacks = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                gas_weight,
                ..
            } = action
            {
                let args: Value = serde_json::from_slice(&args).unwrap();
                match (receipt.receiver_id.as_str(), method_name.as_slice()) {
                    (MPC, b"sign") => signs.push(SignCall {
                        args,
                        deposit: attached_deposit,
                        gas: prepaid_gas,
                        weight: gas_weight.0,
                    }),
                    (CONTRACT, b"on_signed") => callbacks.push((args, prepaid_gas)),
                    other => panic!("unexpected call {other:?}"),
                }
            }
        }
    }
    (signs, callbacks)
}

/// Proposes; the order must pass every rule. Returns the new receipt id after checking that
/// exactly one `sign` call (and its callback) was scheduled for the receipt's payload hash.
#[track_caller]
fn propose_allowed_with(c: &mut ClawGuard, call: Call, proposal: Proposal) -> u64 {
    match propose_with(c, call, proposal) {
        PromiseOrValue::Promise(promise) => drop(promise), // scheduled on drop
        PromiseOrValue::Value(decision) => panic!("expected allowed, got {decision:?}"),
    }
    let receipt_id = c.receipts.total();
    let receipt = c.get_receipt(U64(receipt_id)).expect("receipt stored");
    assert_eq!(receipt.status, Status::PendingSignature);
    let (signs, callbacks) = scheduled();
    assert_eq!(signs.len(), 1, "exactly one sign call");
    let hash = receipt.payload_hash.as_deref().unwrap();
    assert_eq!(
        signs[0].args["request"]["payload_v2"]["Ecdsa"],
        json!(&hash[2..]),
        "MPC signs exactly the receipt's payload hash"
    );
    assert_eq!(
        callbacks,
        vec![(
            json!({"receipt_id": receipt_id.to_string()}),
            mpc::CALLBACK_GAS
        )]
    );
    receipt_id
}

#[track_caller]
fn propose_allowed(c: &mut ClawGuard, proposal: Proposal) -> u64 {
    propose_allowed_with(c, Call::by(AGENT), proposal)
}

/// Runs `on_signed` the way the generated wasm entry point does: the MPC promise result is
/// read from the environment (`#[callback_result(max_bytes = ..)]`) and JSON-decoded.
fn finish_at(c: &mut ClawGuard, receipt_id: u64, result: PromiseResult, now_ns: u64) -> Decision {
    Call::by(CONTRACT)
        .at(now_ns)
        .apply_with_results(vec![result]);
    let result = env::promise_result_checked(0, mpc::MAX_RESPONSE_BYTES)
        .map(|data| serde_json::from_slice::<Value>(&data).expect("MPC returns JSON"));
    c.on_signed(U64(receipt_id), result)
}

fn finish(c: &mut ClawGuard, receipt_id: u64, result: PromiseResult) -> Decision {
    finish_at(c, receipt_id, result, NOW_NS)
}

/// A worthless unit-test signing key standing in for the MPC network.
fn test_signer() -> SigningKey {
    SigningKey::from_slice(&env::keccak256_array(b"clawguard-unit-test-only")).unwrap()
}

fn test_signer_address() -> String {
    let key = test_signer();
    let point = key.verifying_key().to_sec1_point(false);
    encode_hex_0x(&env::keccak256_array(&point.as_bytes()[1..])[12..])
}

/// A real MPC-shaped response: `test_signer` signs `payload_hash` (`0x…`).
fn mpc_response(payload_hash: &str, with_scheme: bool) -> PromiseResult {
    let hash: [u8; 32] = crate::util::decode_hex_array(payload_hash).unwrap();
    let (signature, recovery_id) = test_signer().sign_prehash_recoverable(&hash);
    let (r, s) = signature.split_bytes();
    let prefix = if recovery_id.is_y_odd() { "03" } else { "02" };
    let mut response = json!({
        "big_r": {"affine_point": format!("{prefix}{}", encode_hex(&r))},
        "s": {"scalar": encode_hex(&s)},
        "recovery_id": recovery_id.to_byte(),
    });
    if with_scheme {
        response["scheme"] = json!("Secp256k1");
    }
    PromiseResult::Successful(serde_json::to_vec(&response).unwrap())
}

fn payload_hash_of(c: &ClawGuard, receipt_id: u64) -> String {
    c.get_receipt(U64(receipt_id))
        .unwrap()
        .payload_hash
        .expect("payload hash")
}

// ---- init ------------------------------------------------------------------------------------

#[test]
fn init_refuses_anything_but_testnet_or_sandbox() {
    // ("clawguard.near", "v1.signer") is the one mainnet pair: refused here only in the default
    // build (`init_mainnet_pair_depends_on_the_mainnet_feature`).
    let refused = [
        ("clawguard.owner.testnet", "v1.signer"),
        ("clawguard.near", "v1.signer-prod.testnet"),
        ("clawguard.test.near", "v1.signer-prod.testnet"), // no mixing
        ("clawguard.owner.testnet", "mock-mpc.test.near"),
        ("testnet", "v1.signer-prod.testnet"),
        ("clawguard.testnet.near", "v1.signer.near"),
        ("clawguard.owner.testnet", "testnet"),
    ];
    for (contract, mpc_id) in refused {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id(contract))
            .predecessor_account_id(id(contract));
        near_sdk::testing_env!(b.build());
        expect_panic(errors::ERR_MAINNET_REFUSED, || {
            ClawGuard::new(id(OWNER), None, id(mpc_id), U128(1), 100, 600);
        });
    }
    let accepted = [
        ("clawguard.owner.testnet", "v1.signer-prod.testnet"),
        ("clawguard.test.near", "mock-mpc.test.near"),
    ];
    for (contract, mpc_id) in accepted {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id(contract))
            .predecessor_account_id(id(contract));
        near_sdk::testing_env!(b.build());
        let c = ClawGuard::new(id(OWNER), None, id(mpc_id), U128(1), 100, 600);
        assert_eq!(c.get_status().mpc_contract_id, id(mpc_id));
    }
}

#[test]
fn mainnet_pair_is_exactly_a_near_account_with_v1_signer() {
    let pairs = [
        ("clawguard.near", "v1.signer", true),
        ("claw-guard.owner.near", "v1.signer", true),
        ("a.b.c.near", "v1.signer", true),
        ("clawguard.near", "v1.signer-prod.testnet", false),
        ("clawguard.near", "v1.signer.near", false),
        ("clawguard.near", "signer", false),
        ("clawguard.near", "x.v1.signer", false),
        ("clawguard.test.near", "v1.signer", false), // sandbox suffix
        ("clawguard.owner.testnet", "v1.signer", false),
        ("clawguard.testnet.near", "v1.signer", true), // a mainnet name, despite the word
        ("near", "v1.signer", false),                  // the registrar itself
        ("v1.signer", "v1.signer", false),             // not a .near account
        (
            "abc123def4567890abc123def4567890abc123def4567890abc123def4567890",
            "v1.signer",
            false,
        ),
    ];
    for (contract, mpc_id, expected) in pairs {
        assert_eq!(
            crate::is_mainnet_pair(&id(contract), &id(mpc_id)),
            expected,
            "{contract} + {mpc_id}"
        );
    }
    assert_eq!(crate::MAINNET_MPC_CONTRACT_ID, "v1.signer");
}

#[test]
fn testnet_and_sandbox_pairs_are_never_mainnet_pairs() {
    let pairs = [
        ("clawguard.owner.testnet", "v1.signer-prod.testnet"),
        ("clawguard.test.near", "mock-mpc.test.near"),
    ];
    for (contract, mpc_id) in pairs {
        assert!(crate::is_allowed_network(&id(contract), &id(mpc_id)));
        assert!(!crate::is_mainnet_pair(&id(contract), &id(mpc_id)));
    }
}

#[test]
fn init_mainnet_pair_depends_on_the_mainnet_feature() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("clawguard.near"))
        .predecessor_account_id(id("clawguard.near"));
    near_sdk::testing_env!(b.build());
    if cfg!(feature = "mainnet") {
        let c = ClawGuard::new(id(OWNER), None, id("v1.signer"), U128(1), 100, 600);
        assert_eq!(c.get_status().mpc_contract_id, id("v1.signer"));
    } else {
        expect_panic(errors::ERR_MAINNET_REFUSED, || {
            ClawGuard::new(id(OWNER), None, id("v1.signer"), U128(1), 100, 600);
        });
    }
    assert_eq!(crate::MAINNET_ENABLED, cfg!(feature = "mainnet"));
}

#[test]
fn mainnet_build_still_refuses_mixed_and_wrong_pairs() {
    let refused = [
        ("clawguard.near", "v1.signer-prod.testnet"),
        ("clawguard.near", "mock-mpc.test.near"),
        ("clawguard.near", "v1.signer.near"),
        ("clawguard.test.near", "v1.signer"),
        ("clawguard.owner.testnet", "v1.signer"),
    ];
    for (contract, mpc_id) in refused {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id(contract))
            .predecessor_account_id(id(contract));
        near_sdk::testing_env!(b.build());
        expect_panic(errors::ERR_MAINNET_REFUSED, || {
            ClawGuard::new(id(OWNER), None, id(mpc_id), U128(1), 100, 600);
        });
    }
}

#[test]
fn status_after_init() {
    let c = setup();
    assert_eq!(
        c.get_status(),
        GuardStatus {
            owner: id(OWNER),
            guardian: Some(id(GUARDIAN)),
            paused: false,
            pause_reason: None,
            mpc_contract_id: id(MPC),
            agents_count: 1,
            receipts_count: U64(0),
        }
    );
    assert_eq!(
        serde_json::to_value(c.get_paths()).unwrap(),
        json!([
            ["HlTestnet", "hl-testnet-1"],
            ["BaseSepolia", "base-sepolia-1"]
        ])
    );
}

// ---- access control --------------------------------------------------------------------------

type AdminCall = fn(&mut ClawGuard);

/// Every owner-only method, with what must exist before it can succeed.
fn owner_methods() -> Vec<(&'static str, AdminCall, AdminCall)> {
    let nothing: AdminCall = |_| {};
    vec![
        ("register_agent", nothing, |c| {
            c.register_agent(id("agent-2.test.near"), rules())
        }),
        ("remove_agent", nothing, |c| c.remove_agent(id(AGENT))),
        ("set_rules", nothing, |c| c.set_rules(id(AGENT), rules())),
        (
            "confirm_rules",
            |c| {
                // A loosening made long enough ago.
                let mut looser = rules();
                looser.max_leverage = 5;
                Call::by(OWNER)
                    .deposit(1)
                    .at(NOW_NS - (LOOSEN_DELAY_SEC + 1) * 1_000_000_000)
                    .apply();
                c.set_rules(id(AGENT), looser);
            },
            |c| c.confirm_rules(id(AGENT)),
        ),
        (
            "cancel_pending_rules",
            |c| {
                let mut looser = rules();
                looser.max_leverage = 5;
                Call::by(OWNER).deposit(1).apply();
                c.set_rules(id(AGENT), looser);
            },
            |c| c.cancel_pending_rules(id(AGENT)),
        ),
        ("unpause", nothing, |c| c.unpause()),
        ("set_guardian", nothing, |c| c.set_guardian(None)),
        ("set_sign_config", nothing, |c| {
            c.set_sign_config(U128(2), 120)
        }),
    ]
}

#[test]
fn owner_methods_need_the_owner_and_exactly_one_yocto() {
    for (name, prepare, call) in owner_methods() {
        // Wrong caller: refused before the deposit is even looked at.
        for (caller, deposit) in [(STRANGER, 1), (AGENT, 0), (AGENT, 1), (MPC, 1)] {
            let mut c = setup();
            prepare(&mut c);
            Call::by(caller).deposit(deposit).apply();
            let expected = if name == "cancel_pending_rules" {
                errors::ERR_NOT_OWNER_OR_GUARDIAN
            } else {
                errors::ERR_NOT_OWNER
            };
            expect_panic(expected, || call(&mut c));
        }
        if name != "cancel_pending_rules" {
            // The guardian is not the owner either.
            let mut c = setup();
            prepare(&mut c);
            Call::by(GUARDIAN).deposit(1).apply();
            expect_panic(errors::ERR_NOT_OWNER, || call(&mut c));
        }
        // Owner without exactly 1 yocto (a function-call key cannot attach any).
        for deposit in [0, 2] {
            let mut c = setup();
            prepare(&mut c);
            Call::by(OWNER).deposit(deposit).apply();
            expect_panic(ONE_YOCTO_PANIC, || call(&mut c));
        }
        // Owner with 1 yocto: works.
        let mut c = setup();
        prepare(&mut c);
        Call::by(OWNER).deposit(1).apply();
        call(&mut c);
    }
}

#[test]
fn guardian_can_pause_and_cancel_but_not_unpause() {
    let mut c = setup();
    // pause: no deposit needed.
    Call::by(GUARDIAN).apply();
    c.pause("watch: new full-access key".into());
    let status = c.get_status();
    assert!(status.paused);
    assert_eq!(
        status.pause_reason.as_deref(),
        Some("watch: new full-access key")
    );
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "paused",
            "data": [{"by": GUARDIAN, "reason": "watch: new full-access key"}]
        })]
    );
    // unpause: owner only.
    Call::by(GUARDIAN).deposit(1).apply();
    expect_panic(errors::ERR_NOT_OWNER, || c.unpause());
    assert!(c.get_status().paused);

    // cancel_pending_rules without a deposit.
    let mut looser = rules();
    looser.daily_cap = U128(DAILY_CAP * 2);
    Call::by(OWNER).deposit(1).apply();
    c.set_rules(id(AGENT), looser);
    assert!(agent_state(&c).pending.is_some());
    Call::by(GUARDIAN).apply();
    c.cancel_pending_rules(id(AGENT));
    assert!(agent_state(&c).pending.is_none());
    Call::by(GUARDIAN).apply();
    expect_panic(errors::ERR_NO_PENDING_RULES, || {
        c.cancel_pending_rules(id(AGENT))
    });
    // The guardian cannot loosen, tighten or confirm.
    Call::by(GUARDIAN).deposit(1).apply();
    expect_panic(errors::ERR_NOT_OWNER, || c.set_rules(id(AGENT), rules()));
    Call::by(GUARDIAN).deposit(1).apply();
    expect_panic(errors::ERR_NOT_OWNER, || c.confirm_rules(id(AGENT)));

    // The owner unpauses with 1 yocto.
    Call::by(OWNER).deposit(1).apply();
    c.unpause();
    assert!(!c.get_status().paused);
    assert_eq!(c.get_status().pause_reason, None);
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "unpaused",
            "data": [{"by": OWNER, "reason": "watch: new full-access key"}]
        })]
    );
}

#[test]
fn pause_rules() {
    let mut c = setup();
    for caller in [STRANGER, AGENT, MPC] {
        Call::by(caller).apply();
        expect_panic(errors::ERR_NOT_OWNER_OR_GUARDIAN, || c.pause("x".into()));
    }
    Call::by(OWNER).apply();
    expect_panic(errors::ERR_REASON_TOO_LONG, || c.pause("r".repeat(141)));
    assert!(!c.get_status().paused);
    // 140 bytes (not characters) is the limit.
    Call::by(OWNER).apply();
    expect_panic(errors::ERR_REASON_TOO_LONG, || c.pause("é".repeat(71)));
    Call::by(OWNER).apply();
    c.pause("é".repeat(70));
    // Pausing again replaces the reason.
    Call::by(GUARDIAN).apply();
    c.pause("second".into());
    assert_eq!(c.get_status().pause_reason.as_deref(), Some("second"));
    // Without a guardian, only the owner can pause.
    Call::by(OWNER).deposit(1).apply();
    c.set_guardian(None);
    Call::by(GUARDIAN).apply();
    expect_panic(errors::ERR_NOT_OWNER_OR_GUARDIAN, || c.pause("x".into()));
}

#[test]
fn register_and_remove_agents() {
    let mut c = setup();
    Call::by(OWNER).deposit(1).apply();
    expect_panic(errors::ERR_AGENT_EXISTS, || {
        c.register_agent(id(AGENT), rules())
    });
    let mut bad = rules();
    bad.tokens[0].decimals = 18;
    Call::by(OWNER).deposit(1).apply();
    expect_panic("ERR_INVALID_RULES (tokens)", || {
        c.register_agent(id("agent-2.test.near"), bad)
    });
    assert_eq!(c.get_status().agents_count, 1);

    Call::by(OWNER).deposit(1).apply();
    c.register_agent(id("agent-2.test.near"), rules());
    assert_eq!(c.get_status().agents_count, 2);
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "agent_registered",
            "data": [{"agent_id": "agent-2.test.near", "rules_version": 1}]
        })]
    );

    Call::by(OWNER).deposit(1).apply();
    c.remove_agent(id(AGENT));
    assert_eq!(c.get_status().agents_count, 1);
    assert_eq!(c.get_rules(id(AGENT)), None);
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "agent_removed",
            "data": [{"agent_id": AGENT, "rules_version": 1}]
        })]
    );
    Call::by(OWNER).deposit(1).apply();
    expect_panic(errors::ERR_NOT_AGENT, || c.remove_agent(id(AGENT)));
    // A removed agent is a stranger again.
    Call::by(AGENT).apply();
    expect_panic(errors::ERR_NOT_AGENT, || {
        let _ = c.propose_order(small_btc(NOW_MS));
    });
}

#[test]
fn unregistered_caller_is_refused_and_nothing_is_stored() {
    let mut c = setup();
    for caller in [STRANGER, OWNER, GUARDIAN, CONTRACT] {
        Call::by(caller).apply();
        expect_panic(errors::ERR_NOT_AGENT, || {
            let _ = c.propose_order(small_btc(NOW_MS));
        });
    }
    assert_eq!(c.get_status().receipts_count, U64(0));
    assert!(get_created_receipts().is_empty());
}

// ---- propose_order: blocked ------------------------------------------------------------------

#[test]
fn blocked_order_stores_receipt_and_event_and_never_calls_mpc() {
    let mut c = setup();
    let mut proposal = hl_order("DOGE", "0.1", "100", NOW_MS);
    proposal.memo = Some("move everything".into());
    let decision = propose_blocked(&mut c, proposal.clone(), RuleCode::MarketNotAllowed);
    assert_eq!(
        decision,
        Decision {
            allowed: false,
            receipt_id: U64(1),
            rule_code: Some(RuleCode::MarketNotAllowed),
            message: "Blocked by your rule: market DOGE is not on your list".into(),
            signature: None,
        }
    );
    let receipt = c.get_receipt(U64(1)).unwrap();
    assert_eq!(
        receipt,
        Receipt {
            id: U64(1),
            agent_id: id(AGENT),
            target: Target::HlTestnet,
            proposal,
            status: Status::Blocked,
            rule_code: Some(RuleCode::MarketNotAllowed),
            message: decision.message.clone(),
            payload_hash: None,
            signed_body: None,
            derivation_path: None,
            signature: None,
            rules_version: 1,
            block_height: U64(1_000),
            timestamp_ns: U64(NOW_NS),
        }
    );
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "order_blocked",
            "data": [{
                "receipt_id": "1",
                "agent_id": AGENT,
                "target": "HlTestnet",
                "rule_code": "MARKET_NOT_ALLOWED",
                "message": "Blocked by your rule: market DOGE is not on your list",
            }]
        })]
    );
    // Counters and nonce untouched, nothing in flight.
    let state = agent_state(&c);
    assert_eq!((state.spent_today.0, state.orders_today), (0, 0));
    assert_eq!(state.last_hl_nonce_ms, None);
    assert!(c.pending_signs.get(&1).is_none());
}

#[test]
fn every_rule_code_through_the_contract() {
    // Rules that need their own agent setup run first, each on its own contract.
    {
        let mut hl_only = rules();
        hl_only.targets = vec![Target::HlTestnet];
        let mut c = setup_with(hl_only);
        propose_blocked(
            &mut c,
            transfer(OWNER_ADDR, 1, 0),
            RuleCode::TargetNotEnabled,
        );
    }
    {
        let mut reduce = rules();
        reduce.reduce_only_required = true;
        let mut c = setup_with(reduce);
        propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::ReduceOnlyRequired);
    }

    let mut c = setup();
    Call::by(GUARDIAN).apply();
    c.pause("drill".into());
    propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::Paused);
    Call::by(OWNER).deposit(1).apply();
    c.unpause();

    let late = Call::by(AGENT).at(NOW_NS + 7 * NS_PER_DAY + 1);
    blocked_with(
        &mut c,
        late.clone(),
        small_btc((NOW_NS + 7 * NS_PER_DAY + 1) / 1_000_000),
        RuleCode::Expired,
    );

    propose_blocked(
        &mut c,
        hl_order("BTC", "1e3", "0.001", NOW_MS),
        RuleCode::Malformed,
    );
    propose_blocked(&mut c, small_btc(NOW_MS - 300_001), RuleCode::StaleNonce);
    propose_blocked(
        &mut c,
        hl_order("DOGE", "0.1", "100", NOW_MS),
        RuleCode::MarketNotAllowed,
    );
    let mut weth = transfer(OWNER_ADDR, 1, 0);
    if let OrderRequest::EvmTransfer { token, .. } = &mut weth.order {
        *token = "WETH".into();
    }
    propose_blocked(&mut c, weth, RuleCode::TokenNotAllowed);
    propose_blocked(
        &mut c,
        transfer(BAD_ADDR, 1, 0),
        RuleCode::ReceiverNotAllowed,
    );
    propose_blocked(
        &mut c,
        hl_leverage("BTC", 50, NOW_MS),
        RuleCode::LeverageAboveLimit,
    );
    propose_blocked(
        &mut c,
        hl_order("BTC", "1000", "5", NOW_MS),
        RuleCode::OrderAboveCap,
    );
    c.agents.get_mut(&id(AGENT)).unwrap().state.orders_today = MAX_ORDERS;
    propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::DailyOrderCount);
    {
        let state = &mut c.agents.get_mut(&id(AGENT)).unwrap().state;
        state.orders_today = 0;
        state.spent_today = U128(DAILY_CAP);
    }
    propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::DailyCap);
    c.agents.get_mut(&id(AGENT)).unwrap().state.spent_today = U128(0);
    // One yoctoNEAR short of the sign deposit; the receipt's storage reserve is still covered.
    let storage = 400_000;
    let floor = u128::from(storage + RECEIPT_STORAGE_RESERVE_BYTES)
        * env::storage_byte_cost().as_yoctonear();
    blocked_with(
        &mut c,
        Call::by(AGENT)
            .storage_usage(storage)
            .balance(floor + SIGN_DEPOSIT - 1),
        small_btc(NOW_MS),
        RuleCode::InsufficientContractBalance,
    );
    // Every block above made a receipt and nothing else.
    assert_eq!(c.get_status().receipts_count, U64(12));
    assert!((1..=12).all(|i| c.get_receipt(U64(i)).unwrap().status == Status::Blocked));
}

#[test]
fn paused_beats_daily_cap_through_the_contract() {
    let mut c = setup();
    c.agents.get_mut(&id(AGENT)).unwrap().state.spent_today = U128(DAILY_CAP);
    Call::by(OWNER).apply();
    c.pause("owner".into());
    let decision = propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::Paused);
    assert_eq!(
        decision.message,
        "Blocked by your rule: agent is paused (owner)"
    );
}

#[test]
fn contract_balance_boundary_through_the_contract() {
    let storage = 400_000;
    let needed = u128::from(storage + RECEIPT_STORAGE_RESERVE_BYTES)
        * env::storage_byte_cost().as_yoctonear()
        + SIGN_DEPOSIT;
    let mut c = setup();
    blocked_with(
        &mut c,
        Call::by(AGENT).storage_usage(storage).balance(needed - 1),
        small_btc(NOW_MS),
        RuleCode::InsufficientContractBalance,
    );
    propose_allowed_with(
        &mut c,
        Call::by(AGENT).storage_usage(storage).balance(needed),
        small_btc(NOW_MS),
    );
}

#[test]
fn blocked_receipts_cut_long_agent_strings() {
    let mut c = setup();
    let mut proposal = hl_order("BTC", &"1".repeat(10_000), "0.001", NOW_MS);
    proposal.memo = Some("m".repeat(1_000));
    propose_blocked(&mut c, proposal, RuleCode::Malformed);
    let stored = c.get_receipt(U64(1)).unwrap().proposal;
    let OrderRequest::HlOrder { limit_px, sz, .. } = &stored.order else {
        panic!("kind kept")
    };
    assert_eq!(limit_px.len(), crate::receipts::MAX_STORED_FIELD_BYTES);
    assert_eq!(sz, "0.001");
    assert_eq!(stored.memo.unwrap().len(), MAX_MEMO_BYTES);
}

// ---- storage bounds (Q-44): bytes, not characters ----------------------------------------------

/// A 4-byte (U+1F600), a 3-byte (U+20AC) and a 2-byte (U+00E9) UTF-8 character.
const FOUR: char = '\u{1F600}';
const THREE: char = '\u{20AC}';
const TWO: char = '\u{E9}';
/// The longest NEAR account id: 64 characters.
const LONG_AGENT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.test.near";
/// Storage NEAR charges per record on top of its key and value (`num_extra_bytes_record`).
const STORAGE_RECORD_OVERHEAD: u64 = 40;
/// Key of a receipt or pending-sign record: one prefix byte plus the `u64` id.
const RECORD_KEY_BYTES: u64 = 9;

fn repeat(c: char, n: usize) -> String {
    std::iter::repeat_n(c, n).collect()
}

fn borsh_len<T: near_sdk::borsh::BorshSerialize>(value: &T) -> u64 {
    near_sdk::borsh::to_vec(value).unwrap().len() as u64
}

#[test]
fn memo_and_pause_reason_are_bounded_in_bytes() {
    let bad_memo = "Blocked by your rule: orders must be well-formed (memo)";
    let mut c = setup();
    let with_memo = |memo: String| Proposal {
        memo: Some(memo),
        ..small_btc(NOW_MS)
    };
    for ok in ["m".repeat(140), repeat(FOUR, 35)] {
        assert_eq!(ok.len(), MAX_MEMO_BYTES);
        let preview = c.preview_payload(id(AGENT), with_memo(ok));
        assert!(matches!(preview, PreviewResult::Ok(_)), "{preview:?}");
    }
    // 36 characters, 144 bytes.
    let long = repeat(FOUR, 36);
    assert_eq!(
        c.preview_payload(id(AGENT), with_memo(long.clone())),
        PreviewResult::Err(bad_memo.into())
    );
    let decision = propose_blocked(&mut c, with_memo(long), RuleCode::Malformed);
    assert_eq!(decision.message, bad_memo);

    // The pause reason has the same 140-byte bound.
    for ok in ["r".repeat(140), repeat(FOUR, 35)] {
        Call::by(GUARDIAN).apply();
        c.pause(ok.clone());
        assert_eq!(c.get_status().pause_reason, Some(ok));
    }
    Call::by(GUARDIAN).apply();
    expect_panic(errors::ERR_REASON_TOO_LONG, || c.pause(repeat(FOUR, 36)));
    assert_eq!(c.get_status().pause_reason, Some(repeat(FOUR, 35)));
}

#[test]
fn stored_proposal_cuts_agent_strings_in_bytes_at_char_boundaries() {
    use crate::receipts::{MAX_STORED_FIELD_BYTES, stored_proposal};
    use crate::util::truncate_utf8;
    assert_eq!((MAX_STORED_FIELD_BYTES, MAX_MEMO_BYTES), (48, 140));
    // 13 four-byte characters (52 bytes) keep 12 (48 bytes); 17 three-byte ones keep 16.
    let mut proposal = hl_order(&repeat(FOUR, 13), &repeat(THREE, 17), "0.001", NOW_MS);
    proposal.memo = Some(repeat(FOUR, 36));
    let stored = stored_proposal(&proposal);
    let OrderRequest::HlOrder {
        market,
        limit_px,
        sz,
        tif,
        ..
    } = &stored.order
    else {
        panic!("kind kept")
    };
    assert_eq!(market, &repeat(FOUR, 12));
    assert_eq!(limit_px, &repeat(THREE, 16));
    // ASCII under the limit is unchanged.
    assert_eq!((sz.as_str(), tif.as_str()), ("0.001", "Gtc"));
    assert_eq!(stored.memo, Some(repeat(FOUR, 35)));
    // EVM token and a malformed `to`: 1 + 11 x 4 = 45 bytes (a 12th character would make 49).
    let mut evm = transfer(&repeat(TWO, 30), 1, 0);
    if let OrderRequest::EvmTransfer { token, .. } = &mut evm.order {
        *token = format!("a{}", repeat(FOUR, 20));
    }
    let OrderRequest::EvmTransfer { token, to, .. } = stored_proposal(&evm).order else {
        panic!("kind kept")
    };
    assert_eq!(token, format!("a{}", repeat(FOUR, 11)));
    assert_eq!(to, repeat(TWO, 24));
    // Mixed widths at every offset: the longest prefix that fits, never a split character.
    let widths = ['a', TWO, THREE, FOUR];
    for start in 0..widths.len() {
        for len in 0..80 {
            let s: String = widths.iter().cycle().skip(start).take(len).collect();
            for max in [0, 1, 2, 3, 4, 47, 48, 49, 139, 140, 141] {
                let cut = truncate_utf8(&s, max);
                assert!(cut.len() <= max && s.starts_with(cut), "{s:?} {max}");
                let next = s[cut.len()..].chars().next();
                assert!(
                    next.is_none_or(|c| cut.len() + c.len_utf8() > max),
                    "{s:?} {max}"
                );
            }
        }
    }
}

#[test]
fn worst_case_blocked_receipt_fits_the_pinned_size() {
    use crate::receipts::MAX_BLOCKED_RECEIPT_BYTES;
    assert_eq!(LONG_AGENT.len(), 64);
    let mut c = setup();
    Call::by(OWNER).deposit(1).apply();
    c.register_agent(id(LONG_AGENT), rules());
    // The longest decision message is PAUSED with a 140-byte reason; PAUSED is checked first, so
    // no format check shortens the agent's strings before they are cut.
    Call::by(GUARDIAN).apply();
    c.pause(repeat(FOUR, 35));
    let long = repeat(FOUR, 1_000);
    let memo = Some(long.clone());
    let orders = [
        (
            Target::HlTestnet,
            OrderRequest::HlOrder {
                market: long.clone(),
                is_buy: true,
                limit_px: long.clone(),
                sz: long.clone(),
                reduce_only: true,
                tif: long.clone(),
                nonce_ms: U64(u64::MAX),
            },
        ),
        (
            Target::HlTestnet,
            OrderRequest::HlUpdateLeverage {
                market: long.clone(),
                is_cross: true,
                leverage: u8::MAX,
                nonce_ms: U64(u64::MAX),
            },
        ),
        (
            Target::BaseSepolia,
            OrderRequest::EvmTransfer {
                token: long.clone(),
                to: long.clone(),
                amount: U128(u128::MAX),
                nonce: U64(u64::MAX),
                gas_limit: U64(u64::MAX),
                max_fee_per_gas: U128(u128::MAX),
                max_priority_fee_per_gas: U128(u128::MAX),
            },
        ),
    ];
    let mut largest = 0;
    for (target, order) in orders {
        let proposal = Proposal {
            target,
            order,
            memo: memo.clone(),
        };
        let decision = blocked_with(&mut c, Call::by(LONG_AGENT), proposal, RuleCode::Paused);
        let receipt = c.get_receipt(decision.receipt_id).expect("stored");
        assert_eq!(receipt.message.len(), 180, "the longest message");
        largest = largest.max(borsh_len(&receipt));
    }
    println!("worst-case blocked receipt: {largest} bytes (borsh)");
    assert!(largest <= MAX_BLOCKED_RECEIPT_BYTES, "{largest}");
    // Pinned close to the measurement, so a change that grows receipts shows up here.
    assert!(MAX_BLOCKED_RECEIPT_BYTES - largest < 100, "{largest}");
}

#[test]
fn largest_allowed_receipt_fits_well_inside_the_storage_reserve() {
    let mut r = rules();
    r.markets = vec![market(&"M".repeat(16), u32::MAX, "1", 6)];
    r.tokens = vec![token(&"T".repeat(16), USDC_ADDR, u128::MAX)];
    r.max_order_notional = U128(u128::MAX);
    r.daily_cap = U128(u128::MAX);
    let mut c = setup_with(r.clone());
    Call::by(OWNER).deposit(1).apply();
    c.register_agent(id(LONG_AGENT), r);
    let memo = Some(repeat(FOUR, 35));
    let (px, sz) = (format!("1{}", "0".repeat(28)), "0.000001");
    let hl = Proposal {
        target: Target::HlTestnet,
        order: OrderRequest::HlOrder {
            market: "M".repeat(16),
            is_buy: false,
            limit_px: px.clone(),
            sz: sz.to_owned(),
            reduce_only: false,
            tif: "Alo".to_owned(),
            nonce_ms: U64(NOW_MS),
        },
        memo: memo.clone(),
    };
    let evm = Proposal {
        target: Target::BaseSepolia,
        order: OrderRequest::EvmTransfer {
            token: "T".repeat(16),
            to: OWNER_ADDR.to_owned(),
            amount: U128(1),
            nonce: U64(MAX_EVM_NONCE),
            gas_limit: U64(MAX_GAS_LIMIT),
            max_fee_per_gas: U128(MAX_FEE_PER_GAS_WEI),
            max_priority_fee_per_gas: U128(MAX_FEE_PER_GAS_WEI),
        },
        memo,
    };
    // A canonical decimal is at most 40 bytes (the 39 digits of a u128 in 1e-8 units plus the
    // point). The price and size above are shorter, so the HL total adds the difference twice
    // (once in the proposal, once in the signed body).
    let hl_slack = 2 * (80 - px.len() - sz.len()) as u64;
    let mut largest = 0;
    for (proposal, slack) in [(hl, hl_slack), (evm, 0)] {
        let receipt_id = propose_allowed_with(&mut c, Call::by(LONG_AGENT), proposal);
        let pending = borsh_len(c.pending_signs.get(&receipt_id).expect("in flight"));
        let hash = payload_hash_of(&c, receipt_id);
        assert!(finish(&mut c, receipt_id, mpc_response(&hash, true)).allowed);
        let receipt = borsh_len(&c.get_receipt(U64(receipt_id)).unwrap());
        let records = 2 * (RECORD_KEY_BYTES + STORAGE_RECORD_OVERHEAD);
        largest = largest.max(receipt + pending + slack + records);
    }
    // What pause() can add to the contract state: a 140-byte reason where there was none.
    let pause_growth = borsh_len(&Some(repeat(FOUR, 35))) - borsh_len(&None::<String>);
    assert_eq!(pause_growth, 144);
    println!("largest allowed receipt + pending sign: {largest} bytes of storage");
    assert!(
        largest <= (RECEIPT_STORAGE_RESERVE_BYTES - pause_growth) / 2,
        "{largest}"
    );
}

#[test]
fn blocked_receipt_is_stored_only_while_the_storage_reserve_is_kept() {
    let storage = 400_000;
    let floor = u128::from(storage + RECEIPT_STORAGE_RESERVE_BYTES)
        * env::storage_byte_cost().as_yoctonear();
    let message = "Blocked by your rule: market DOGE is not on your list";
    let doge = || hl_order("DOGE", "0.1", "100", NOW_MS);
    let mut c = setup();
    // Exactly at (storage + 4096 bytes) x byte cost: stored as usual.
    let decision = blocked_with(
        &mut c,
        Call::by(AGENT).storage_usage(storage).balance(floor),
        doge(),
        RuleCode::MarketNotAllowed,
    );
    assert_eq!(
        (decision.receipt_id, decision.message.as_str()),
        (U64(1), message)
    );
    assert_eq!(c.get_receipt(U64(1)).unwrap().status, Status::Blocked);

    // One yoctoNEAR below: the same decision with receipt id 0, nothing stored, event logged.
    let decision = blocked_with(
        &mut c,
        Call::by(AGENT).storage_usage(storage).balance(floor - 1),
        doge(),
        RuleCode::MarketNotAllowed,
    );
    assert_eq!(
        decision,
        Decision {
            allowed: false,
            receipt_id: U64(0),
            rule_code: Some(RuleCode::MarketNotAllowed),
            message: message.into(),
            signature: None,
        }
    );
    assert_eq!(c.get_status().receipts_count, U64(1));
    assert_eq!(c.get_receipt(U64(0)), None);
    assert_eq!(c.get_receipt(U64(2)), None);
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "order_blocked",
            "data": [{
                "receipt_id": "0",
                "agent_id": AGENT,
                "target": "HlTestnet",
                "rule_code": "MARKET_NOT_ALLOWED",
                "message": message,
            }]
        })]
    );
    // Paused below the reserve: blocked with the pause reason, still not stored.
    Call::by(GUARDIAN).apply();
    c.pause("watch: new full-access key".into());
    let decision = blocked_with(
        &mut c,
        Call::by(AGENT).storage_usage(storage).balance(floor - 1),
        small_btc(NOW_MS),
        RuleCode::Paused,
    );
    assert_eq!(decision.receipt_id, U64(0));
    assert_eq!(
        decision.message,
        "Blocked by your rule: agent is paused (watch: new full-access key)"
    );
    assert_eq!(c.get_status().receipts_count, U64(1));
}

// ---- propose_order: allowed -> sign -> on_signed ---------------------------------------------

#[test]
fn allowed_order_requests_exactly_one_signature() {
    let mut c = setup();
    let receipt_id = propose_allowed(&mut c, small_btc(NOW_MS));
    assert_eq!(receipt_id, 1);

    let (signs, _) = scheduled();
    let receipt = c.get_receipt(U64(1)).unwrap();
    let hash = receipt.payload_hash.clone().unwrap();
    assert_eq!(
        signs[0].args,
        json!({"request": {"path": "hl-testnet-1", "payload_v2": {"Ecdsa": &hash[2..]}, "domain_id": 0}})
    );
    assert_eq!(signs[0].deposit, NearToken::from_yoctonear(SIGN_DEPOSIT));
    assert_eq!(signs[0].gas, Gas::from_tgas(SIGN_GAS_TGAS));
    assert_eq!(signs[0].weight, 1);

    assert_eq!(receipt.status, Status::PendingSignature);
    assert_eq!(receipt.rule_code, None);
    assert_eq!(receipt.message, "Allowed: within your limits");
    assert_eq!(receipt.derivation_path.as_deref(), Some("hl-testnet-1"));
    assert_eq!(
        receipt.signed_body.as_deref(),
        Some(
            r#"{"type":"order","orders":[{"a":3,"b":true,"p":"1000","s":"0.001","r":false,"t":{"limit":{"tif":"Gtc"}}}],"grouping":"na"}"#
        )
    );
    assert!(receipt.signature.is_none());

    // Spend and one order reserved, nonce consumed, reservation recorded.
    let state = agent_state(&c);
    assert_eq!((state.spent_today.0, state.orders_today), (1_000_000, 1));
    assert_eq!(state.last_hl_nonce_ms, Some(U64(NOW_MS)));
    let pending = c.pending_signs.get(&1).expect("in flight");
    assert_eq!(
        (pending.day, pending.spend, pending.target),
        (day_of(NOW_NS), 1_000_000, Target::HlTestnet)
    );

    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "order_allowed",
            "data": [{
                "receipt_id": "1",
                "agent_id": AGENT,
                "target": "HlTestnet",
                "payload_hash": hash,
                "derivation_path": "hl-testnet-1",
            }]
        })]
    );
}

#[test]
fn signature_lands_in_the_receipt_and_recovers() {
    for with_scheme in [true, false] {
        let mut c = setup();
        let receipt_id = propose_allowed(&mut c, small_btc(NOW_MS));
        let hash = payload_hash_of(&c, receipt_id);
        let decision = finish(&mut c, receipt_id, mpc_response(&hash, with_scheme));

        assert!(decision.allowed);
        assert_eq!(decision.message, "Allowed: within your limits");
        assert_eq!(decision.rule_code, None);
        let sig = decision.signature.clone().expect("signature");
        assert!(sig.v == 27 || sig.v == 28, "HL v");
        assert_eq!(sig.r.len(), 66);
        assert_eq!(sig.s.len(), 66);

        let receipt = c.get_receipt(U64(receipt_id)).unwrap();
        assert_eq!(receipt.status, Status::Signed);
        assert_eq!(receipt.signature, Some(sig.clone()));
        // The stored (payload_hash, signature) verify against the signer.
        let word = |h: &str| crate::util::decode_hex_array::<32>(h).unwrap();
        assert_eq!(
            recover_evm_address(&word(&hash), &word(&sig.r), &word(&sig.s), sig.v - 27),
            test_signer_address()
        );
        // The reservation is kept.
        let state = agent_state(&c);
        assert_eq!((state.spent_today.0, state.orders_today), (1_000_000, 1));
        assert!(c.pending_signs.get(&receipt_id).is_none());
        assert_eq!(
            logged_events(),
            vec![json!({
                "standard": "clawguard", "version": "1.0.0", "event": "signature_ready",
                "data": [{"receipt_id": "1", "payload_hash": hash}]
            })]
        );
    }
}

#[test]
fn evm_signature_uses_y_parity() {
    let mut c = setup();
    let receipt_id = propose_allowed(&mut c, transfer(OWNER_ADDR, 1_000_000, 0));
    let receipt = c.get_receipt(U64(receipt_id)).unwrap();
    assert_eq!(receipt.derivation_path.as_deref(), Some("base-sepolia-1"));
    assert!(receipt.signed_body.as_deref().unwrap().starts_with("0x02"));
    let hash = receipt.payload_hash.unwrap();
    let sig = finish(&mut c, receipt_id, mpc_response(&hash, true))
        .signature
        .unwrap();
    assert!(sig.v <= 1, "EIP-1559 y-parity");
    let word = |h: &str| crate::util::decode_hex_array::<32>(h).unwrap();
    assert_eq!(
        recover_evm_address(&word(&hash), &word(&sig.r), &word(&sig.s), sig.v),
        test_signer_address()
    );
    assert_eq!(agent_state(&c).last_evm_nonce, Some(U64(0)));
}

#[test]
fn failed_signature_releases_the_reservation() {
    let mut c = setup();
    let first = propose_allowed(&mut c, small_btc(NOW_MS));
    let second = propose_allowed(&mut c, transfer(OWNER_ADDR, 2_000_000, 9));
    let state = agent_state(&c);
    assert_eq!((state.spent_today.0, state.orders_today), (3_000_000, 2));

    let decision = finish(&mut c, first, PromiseResult::Failed);
    assert_eq!(
        decision,
        Decision {
            allowed: false,
            receipt_id: U64(first),
            rule_code: None,
            message: "Not signed: the signature request failed".into(),
            signature: None,
        }
    );
    let receipt = c.get_receipt(U64(first)).unwrap();
    assert_eq!(receipt.status, Status::SignFailed);
    assert_eq!(receipt.rule_code, None);
    assert_eq!(receipt.message, "Not signed: the signature request failed");
    // Only the failed order's spend and count come back; its nonce stays used.
    let state = agent_state(&c);
    assert_eq!((state.spent_today.0, state.orders_today), (2_000_000, 1));
    assert_eq!(state.last_hl_nonce_ms, Some(U64(NOW_MS)));
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "signature_failed",
            "data": [{"receipt_id": "1", "reason": "the signature request did not complete"}]
        })]
    );
    propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::StaleNonce);

    // A response that is not a usable signature fails the same way.
    let unusable = json!({"scheme": "Ed25519", "signature": vec![0u8; 64]});
    let decision = finish(
        &mut c,
        second,
        PromiseResult::Successful(serde_json::to_vec(&unusable).unwrap()),
    );
    assert!(!decision.allowed);
    assert_eq!(
        c.get_receipt(U64(second)).unwrap().status,
        Status::SignFailed
    );
    let state = agent_state(&c);
    assert_eq!((state.spent_today.0, state.orders_today), (0, 0));
    assert_eq!(
        logged_events()[0]["data"][0]["reason"],
        json!("the signature response could not be read")
    );
}

#[test]
fn oversized_mpc_response_is_a_failure() {
    let mut c = setup();
    let receipt_id = propose_allowed(&mut c, small_btc(NOW_MS));
    let big = serde_json::to_vec(&json!({"padding": "x".repeat(2_000)})).unwrap();
    let decision = finish(&mut c, receipt_id, PromiseResult::Successful(big));
    assert!(!decision.allowed);
    assert_eq!(agent_state(&c).orders_today, 0);
}

#[test]
fn failure_after_midnight_does_not_touch_the_new_day() {
    let mut c = setup();
    let last_ns = DAY_START_NS + NS_PER_DAY - 1;
    let receipt_id = propose_allowed_with(
        &mut c,
        Call::by(AGENT).at(last_ns),
        small_btc(last_ns / 1_000_000),
    );
    // Next day: a new order is reserved, then yesterday's request fails.
    let midnight = DAY_START_NS + NS_PER_DAY;
    propose_allowed_with(
        &mut c,
        Call::by(AGENT).at(midnight),
        small_btc(midnight / 1_000_000),
    );
    finish_at(&mut c, receipt_id, PromiseResult::Failed, midnight + 1);
    let state = agent_state(&c);
    assert_eq!(state.day, day_of(midnight));
    assert_eq!((state.spent_today.0, state.orders_today), (1_000_000, 1));
}

#[test]
fn late_failure_does_not_touch_a_new_registration() {
    let mut c = setup();
    let old = propose_allowed(&mut c, small_btc(NOW_MS));
    Call::by(OWNER).deposit(1).apply();
    c.remove_agent(id(AGENT));
    Call::by(OWNER).deposit(1).apply();
    c.register_agent(id(AGENT), rules());
    propose_allowed(&mut c, small_btc(NOW_MS + 1));
    finish(&mut c, old, PromiseResult::Failed);
    let state = agent_state(&c);
    assert_eq!((state.spent_today.0, state.orders_today), (1_000_000, 1));
}

#[test]
fn callback_still_works_after_the_receipt_left_the_ring_buffer() {
    let mut c = new_guard();
    c.receipts.set_max_receipts(1);
    Call::by(OWNER).deposit(1).apply();
    c.register_agent(id(AGENT), rules());
    let first = propose_allowed(&mut c, small_btc(NOW_MS));
    let hash = payload_hash_of(&c, first);
    propose_blocked(
        &mut c,
        hl_leverage("DOGE", 1, NOW_MS + 1),
        RuleCode::MarketNotAllowed,
    );
    assert!(c.get_receipt(U64(first)).is_none(), "evicted");
    let decision = finish(&mut c, first, mpc_response(&hash, true));
    assert!(decision.allowed);
    assert_eq!(logged_events()[0]["event"], json!("signature_ready"));
}

#[test]
fn not_enough_gas_fails_closed_before_anything_is_written() {
    let mut c = setup();
    // 100 (sign) + 20 (callback) + 10 (margin) Tgas needed.
    Call::by(AGENT).gas(125).apply();
    expect_panic(errors::ERR_NOT_ENOUGH_GAS, || {
        let _ = c.propose_order(small_btc(NOW_MS));
    });
    assert_eq!(c.get_status().receipts_count, U64(0));
    assert_eq!(agent_state(&c).orders_today, 0);
    assert_eq!(agent_state(&c).last_hl_nonce_ms, None);
    // Blocked orders need no signature gas.
    blocked_with(
        &mut c,
        Call::by(AGENT).gas(125),
        hl_order("DOGE", "1", "1", NOW_MS),
        RuleCode::MarketNotAllowed,
    );
    propose_allowed_with(&mut c, Call::by(AGENT).gas(140), small_btc(NOW_MS));

    // A sign gas that overflows is refused the same way.
    Call::by(OWNER).deposit(1).apply();
    c.set_sign_config(U128(1), u64::MAX);
    Call::by(AGENT).apply();
    expect_panic(errors::ERR_NOT_ENOUGH_GAS, || {
        let _ = c.propose_order(small_btc(NOW_MS + 1));
    });
}

#[test]
fn sign_config_is_used_for_the_next_request() {
    let mut c = setup();
    Call::by(OWNER).deposit(1).apply();
    c.set_sign_config(U128(50_000_000_000_000_000_000_000), 150);
    propose_allowed(&mut c, small_btc(NOW_MS));
    let (signs, _) = scheduled();
    assert_eq!(
        signs[0].deposit,
        NearToken::from_yoctonear(50_000_000_000_000_000_000_000)
    );
    assert_eq!(signs[0].gas, Gas::from_tgas(150));
}

#[test]
fn nonces_are_monotonic_and_windowed_through_the_contract() {
    let mut c = setup();
    propose_allowed(&mut c, small_btc(NOW_MS));
    propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::StaleNonce);
    propose_blocked(&mut c, small_btc(NOW_MS - 1), RuleCode::StaleNonce);
    propose_allowed(&mut c, hl_leverage("BTC", 2, NOW_MS + 1));
    propose_blocked(&mut c, small_btc(NOW_MS + 300_001), RuleCode::StaleNonce);
    propose_allowed(&mut c, small_btc(NOW_MS + 300_000));

    propose_allowed(&mut c, transfer(OWNER_ADDR, 1, 5));
    propose_blocked(&mut c, transfer(OWNER_ADDR, 1, 5), RuleCode::StaleNonce);
    propose_blocked(&mut c, transfer(OWNER_ADDR, 1, 4), RuleCode::StaleNonce);
    propose_allowed(&mut c, transfer(OWNER_ADDR, 1, 6));
    let state = agent_state(&c);
    assert_eq!(state.last_hl_nonce_ms, Some(U64(NOW_MS + 300_000)));
    assert_eq!(state.last_evm_nonce, Some(U64(6)));
}

#[test]
fn daily_counters_roll_over_at_utc_midnight() {
    let mut r = rules();
    r.max_orders_per_day = 2;
    let mut c = setup_with(r);
    let late = DAY_START_NS + NS_PER_DAY - 2_000_000;
    propose_allowed_with(
        &mut c,
        Call::by(AGENT).at(late),
        small_btc(late / 1_000_000),
    );
    propose_allowed_with(
        &mut c,
        Call::by(AGENT).at(late),
        small_btc(late / 1_000_000 + 1),
    );
    blocked_with(
        &mut c,
        Call::by(AGENT).at(late),
        small_btc(late / 1_000_000 + 2),
        RuleCode::DailyOrderCount,
    );
    let midnight = DAY_START_NS + NS_PER_DAY;
    Call::by(AGENT).at(midnight).apply();
    let view = c.get_rules(id(AGENT)).unwrap();
    assert_eq!(
        (view.day, view.spent_today.0, view.orders_today),
        (day_of(midnight), 0, 0)
    );
    propose_allowed_with(
        &mut c,
        Call::by(AGENT).at(midnight),
        small_btc(midnight / 1_000_000),
    );
    assert_eq!(agent_state(&c).orders_today, 1);
}

// ---- rules lifecycle -------------------------------------------------------------------------

#[test]
fn tighten_applies_now_and_loosen_waits() {
    let mut c = setup();
    // Tighten: applies at once.
    let mut tighter = rules();
    tighter.max_leverage = 2;
    Call::by(OWNER).deposit(1).apply();
    c.set_rules(id(AGENT), tighter.clone());
    let state = agent_state(&c);
    assert_eq!(
        (state.rules.clone(), state.rules_version),
        (tighter.clone(), 2)
    );
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "rules_updated",
            "data": [{"agent_id": AGENT, "rules_version": 2, "tightened": true}]
        })]
    );
    propose_blocked(
        &mut c,
        hl_leverage("BTC", 3, NOW_MS),
        RuleCode::LeverageAboveLimit,
    );

    // Loosen: pending, the old rules still apply.
    let mut looser = tighter.clone();
    looser.max_leverage = 10;
    Call::by(OWNER).deposit(1).apply();
    c.set_rules(id(AGENT), looser.clone());
    let eta = NOW_NS + LOOSEN_DELAY_SEC * 1_000_000_000;
    let state = agent_state(&c);
    assert_eq!(state.rules, tighter);
    assert_eq!(state.rules_version, 2);
    assert_eq!(state.pending, Some((looser.clone(), U64(eta))));
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "rules_pending",
            "data": [{"agent_id": AGENT, "eta_ns": eta.to_string()}]
        })]
    );
    propose_blocked(
        &mut c,
        hl_leverage("BTC", 5, NOW_MS + 1),
        RuleCode::LeverageAboveLimit,
    );

    // Too early, then exactly at the eta.
    Call::by(OWNER).deposit(1).at(eta - 1).apply();
    expect_panic(errors::ERR_TOO_EARLY, || c.confirm_rules(id(AGENT)));
    Call::by(OWNER).deposit(1).at(eta).apply();
    c.confirm_rules(id(AGENT));
    let state = agent_state(&c);
    assert_eq!((state.rules.clone(), state.rules_version), (looser, 3));
    assert_eq!(state.pending, None);
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "rules_updated",
            "data": [{"agent_id": AGENT, "rules_version": 3, "tightened": false}]
        })]
    );
    propose_allowed_with(
        &mut c,
        Call::by(AGENT).at(eta),
        hl_leverage("BTC", 5, eta / 1_000_000),
    );
    Call::by(OWNER).deposit(1).at(eta).apply();
    expect_panic(errors::ERR_NO_PENDING_RULES, || c.confirm_rules(id(AGENT)));
}

#[test]
fn newer_set_rules_replace_or_clear_the_pending_change() {
    let mut c = setup();
    let mut looser = rules();
    looser.daily_cap = U128(DAILY_CAP * 2);
    Call::by(OWNER).deposit(1).apply();
    c.set_rules(id(AGENT), looser);
    // A second loosening replaces the first and restarts the delay.
    let mut other = rules();
    other.max_orders_per_day = 50;
    let later = NOW_NS + 100 * 1_000_000_000;
    Call::by(OWNER).deposit(1).at(later).apply();
    c.set_rules(id(AGENT), other.clone());
    assert_eq!(
        agent_state(&c).pending,
        Some((other, U64(later + LOOSEN_DELAY_SEC * 1_000_000_000)))
    );
    // A tightening applies now and drops the pending loosening.
    let mut tighter = rules();
    tighter.max_orders_per_day = 1;
    Call::by(OWNER).deposit(1).at(later).apply();
    c.set_rules(id(AGENT), tighter.clone());
    let state = agent_state(&c);
    assert_eq!(state.pending, None);
    assert_eq!(state.rules, tighter);
    // Invalid rules are refused outright.
    let mut invalid = rules();
    invalid.max_leverage = 0;
    Call::by(OWNER).deposit(1).apply();
    expect_panic("ERR_INVALID_RULES (max_leverage)", || {
        c.set_rules(id(AGENT), invalid)
    });
    Call::by(OWNER).deposit(1).apply();
    expect_panic(errors::ERR_NOT_AGENT, || c.set_rules(id(STRANGER), rules()));
}

#[test]
fn set_rules_tightens_or_loosens_per_field() {
    // Contract-level spot checks; every field is covered in rules::tests.
    type Edit = fn(&mut Rules);
    let loosenings: &[Edit] = &[
        |r| r.markets.push(market("SOL", 5, "1", 2)),
        |r| r.markets[0].max_order_sz = "0.02".into(),
        |r| r.max_order_notional = U128(MAX_NOTIONAL + 1),
        |r| r.max_leverage = MAX_LEVERAGE + 1,
        |r| r.tokens.push(token("EURC", BAD_ADDR, 1)),
        |r| r.receivers.push(BAD_ADDR.into()),
        |r| r.daily_cap = U128(DAILY_CAP + 1),
        |r| r.max_orders_per_day = MAX_ORDERS + 1,
        |r| r.expires_at_ns = U64(NOW_NS + 30 * NS_PER_DAY),
    ];
    for edit in loosenings {
        let mut c = setup();
        let mut new = rules();
        edit(&mut new);
        Call::by(OWNER).deposit(1).apply();
        c.set_rules(id(AGENT), new);
        let state = agent_state(&c);
        assert!(state.pending.is_some(), "{:?}", state.pending);
        assert_eq!(state.rules, rules());
        assert_eq!(state.rules_version, 1);
    }
    let tightenings: &[Edit] = &[
        |r| r.targets = vec![Target::HlTestnet],
        |r| {
            r.markets.pop();
        },
        |r| r.max_order_notional = U128(1),
        |r| r.tokens[0].max_per_order = U128(1),
        |r| r.receivers.clear(),
        |r| r.reduce_only_required = true,
        |r| r.expires_at_ns = U64(NOW_NS + 1),
    ];
    for edit in tightenings {
        let mut c = setup();
        let mut new = rules();
        edit(&mut new);
        Call::by(OWNER).deposit(1).apply();
        c.set_rules(id(AGENT), new.clone());
        let state = agent_state(&c);
        assert_eq!(state.pending, None);
        assert_eq!(state.rules, new);
        assert_eq!(state.rules_version, 2);
    }
}

// ---- receipts --------------------------------------------------------------------------------

#[test]
fn ring_buffer_evicts_the_oldest_receipt() {
    let mut c = new_guard();
    c.receipts.set_max_receipts(3);
    Call::by(OWNER).deposit(1).apply();
    c.register_agent(id(AGENT), rules());
    for _ in 0..5 {
        propose_blocked(
            &mut c,
            hl_order("DOGE", "1", "1", NOW_MS),
            RuleCode::MarketNotAllowed,
        );
    }
    assert_eq!(c.get_status().receipts_count, U64(5));
    assert!(c.get_receipt(U64(1)).is_none());
    assert!(c.get_receipt(U64(2)).is_none());
    let ids = |v: Vec<Receipt>| v.into_iter().map(|r| r.id.0).collect::<Vec<_>>();
    assert_eq!(ids(c.get_receipts(U64(0), 50)), vec![3, 4, 5]);
    assert_eq!(ids(c.get_receipts(U64(1), 2)), vec![3, 4]);
    assert_eq!(ids(c.get_receipts(U64(5), 50)), vec![5]);
    assert!(c.get_receipts(U64(6), 50).is_empty());
    assert!(c.get_receipt(U64(0)).is_none());
}

#[test]
fn default_ring_buffer_holds_1000_receipts() {
    let mut c = setup();
    for _ in 0..1001 {
        propose_blocked(
            &mut c,
            hl_order("DOGE", "1", "1", NOW_MS),
            RuleCode::MarketNotAllowed,
        );
    }
    assert!(c.get_receipt(U64(1)).is_none());
    assert!(c.get_receipt(U64(2)).is_some());
    assert!(c.get_receipt(U64(1001)).is_some());
    assert_eq!(c.get_status().receipts_count, U64(1001));
}

#[test]
fn get_receipts_pages_and_clamps_the_limit() {
    let mut c = setup();
    for _ in 0..60 {
        propose_blocked(
            &mut c,
            hl_order("DOGE", "1", "1", NOW_MS),
            RuleCode::MarketNotAllowed,
        );
    }
    let page = c.get_receipts(U64(1), 1_000);
    assert_eq!(page.len(), 50);
    assert_eq!(page.first().unwrap().id, U64(1));
    assert_eq!(page.last().unwrap().id, U64(50));
    let rest = c.get_receipts(U64(51), 50);
    assert_eq!(rest.len(), 10);
    assert_eq!(rest.last().unwrap().id, U64(60));
    assert!(c.get_receipts(U64(1), 0).is_empty());
}

// ---- views -----------------------------------------------------------------------------------

#[test]
fn preview_matches_propose_and_changes_nothing() {
    let mut c = setup();
    Call::by(STRANGER).apply();
    let preview = c.preview_payload(id(AGENT), small_btc(NOW_MS));
    let PreviewResult::Ok(hash) = preview else {
        panic!("{preview:?}")
    };
    assert_eq!(c.get_status().receipts_count, U64(0));
    assert_eq!(agent_state(&c).last_hl_nonce_ms, None);

    let receipt_id = propose_allowed(&mut c, small_btc(NOW_MS));
    assert_eq!(payload_hash_of(&c, receipt_id), hash);

    Call::by(STRANGER).apply();
    assert_eq!(
        c.preview_payload(id(AGENT), hl_order("DOGE", "1", "1", NOW_MS + 1)),
        PreviewResult::Err("Blocked by your rule: market DOGE is not on your list".into())
    );
    assert_eq!(
        serde_json::to_value(c.preview_payload(id(AGENT), small_btc(NOW_MS))).unwrap(),
        json!({"Err": "Blocked by your rule: order time is outside the allowed window"})
    );
    expect_panic(errors::ERR_NOT_AGENT, || {
        c.preview_payload(id(STRANGER), small_btc(NOW_MS + 1));
    });
}

#[test]
fn get_rules_shows_todays_counters() {
    let mut c = setup();
    assert_eq!(c.get_rules(id(STRANGER)), None);
    propose_allowed(&mut c, small_btc(NOW_MS));
    Call::by(STRANGER).apply();
    let view = c.get_rules(id(AGENT)).unwrap();
    assert_eq!((view.spent_today.0, view.orders_today), (1_000_000, 1));
    assert_eq!(view.last_hl_nonce_ms, Some(U64(NOW_MS)));
    Call::by(STRANGER).at(NOW_NS + NS_PER_DAY).apply();
    let tomorrow = c.get_rules(id(AGENT)).unwrap();
    assert_eq!(
        (tomorrow.day, tomorrow.spent_today.0, tomorrow.orders_today),
        (day_of(NOW_NS) + 1, 0, 0)
    );
}

#[test]
fn json_wire_format() {
    // What an agent sends (wire interface; numbers above 2^53 are strings).
    let sent = json!({
        "target": "HlTestnet",
        "order": {"HlOrder": {
            "market": "BTC", "is_buy": true, "limit_px": "1000", "sz": "0.001",
            "reduce_only": false, "tif": "Gtc", "nonce_ms": NOW_MS.to_string()
        }}
    });
    let proposal: Proposal = serde_json::from_value(sent).unwrap();
    assert_eq!(proposal, small_btc(NOW_MS));
    let transfer_json = json!({
        "target": "BaseSepolia",
        "order": {"EvmTransfer": {
            "token": "USDC", "to": OWNER_ADDR, "amount": "1000000", "nonce": "0",
            "gas_limit": "65000", "max_fee_per_gas": "1000000000",
            "max_priority_fee_per_gas": "1000000"
        }},
        "memo": null
    });
    let parsed: Proposal = serde_json::from_value(transfer_json.clone()).unwrap();
    assert_eq!(parsed, transfer(OWNER_ADDR, 1_000_000, 0));
    assert_eq!(serde_json::to_value(&parsed).unwrap(), transfer_json);

    // Rules: reduce_only_required may be omitted.
    let mut rules_json = serde_json::to_value(rules()).unwrap();
    assert_eq!(rules_json["daily_cap"], json!(DAILY_CAP.to_string()));
    assert_eq!(rules_json["targets"], json!(["HlTestnet", "BaseSepolia"]));
    // MarketRule: `sz_decimals` is a plain number and required.
    assert_eq!(
        serde_json::to_string(&rules().markets[0]).unwrap(),
        r#"{"name":"BTC","asset":3,"max_order_sz":"0.01","sz_decimals":5}"#
    );
    assert_eq!(
        serde_json::from_value::<MarketRule>(
            json!({"name": "ETH", "asset": 4, "max_order_sz": "0.1", "sz_decimals": 4})
        )
        .unwrap(),
        rules().markets[1]
    );
    // Owner decision D-11: a missing `sz_decimals` parses, as the marker that rules validation
    // refuses (see `sz_decimals_300_and_minus_1_are_invalid_rules_not_json_errors`).
    let mut without_sz_decimals = rules_json.clone();
    without_sz_decimals["markets"][0]
        .as_object_mut()
        .unwrap()
        .remove("sz_decimals");
    let missing = serde_json::from_value::<Rules>(without_sz_decimals).unwrap();
    assert_eq!(missing.markets[0].sz_decimals, INVALID_SZ_DECIMALS);
    rules_json
        .as_object_mut()
        .unwrap()
        .remove("reduce_only_required");
    let parsed: Rules = serde_json::from_value(rules_json).unwrap();
    assert_eq!(parsed, rules());

    // Receipt and decision field names.
    let mut c = setup();
    let receipt_id = propose_allowed(&mut c, small_btc(NOW_MS));
    let hash = payload_hash_of(&c, receipt_id);
    let decision = finish(&mut c, receipt_id, mpc_response(&hash, true));
    let receipt = serde_json::to_value(c.get_receipt(U64(receipt_id))).unwrap();
    let keys: Vec<&str> = receipt
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut expected = vec![
        "id",
        "agent_id",
        "target",
        "proposal",
        "status",
        "rule_code",
        "message",
        "payload_hash",
        "signed_body",
        "derivation_path",
        "signature",
        "rules_version",
        "block_height",
        "timestamp_ns",
    ];
    let mut sorted_keys = keys.clone();
    sorted_keys.sort_unstable();
    expected.sort_unstable();
    assert_eq!(sorted_keys, expected);
    assert_eq!(receipt["id"], json!("1"));
    assert_eq!(receipt["status"], json!("Signed"));
    assert_eq!(receipt["timestamp_ns"], json!(NOW_NS.to_string()));
    let decision = serde_json::to_value(decision).unwrap();
    assert_eq!(decision["receipt_id"], json!("1"));
    assert_eq!(decision["rule_code"], Value::Null);
    let sig = &decision["signature"];
    assert!(sig["r"].as_str().unwrap().starts_with("0x"));
    assert!(sig["v"].is_u64());

    let state = serde_json::to_value(c.get_rules(id(AGENT))).unwrap();
    for key in [
        "rules",
        "rules_version",
        "pending",
        "day",
        "spent_today",
        "orders_today",
        "last_hl_nonce_ms",
        "last_evm_nonce",
    ] {
        assert!(state.get(key).is_some(), "{key}");
    }
    assert_eq!(state["spent_today"], json!("1000000"));
}

// ---- owner decisions: sz_decimals, EVM address forms ------------------------

/// EIP-55 test address from the specification, and its lowercase form.
const SPEC_ADDR: &str = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SPEC_ADDR_LOWER: &str = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
/// The same with one letter's case flipped: not a valid checksum.
const SPEC_ADDR_TYPO: &str = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
/// Base Sepolia USDC with its EIP-55 checksum (eth_utils).
const USDC_ADDR_CHECKSUM: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/// The fixture rules as an owner might type them: checksummed and upper-case addresses.
fn rules_with_checksummed_addresses() -> Rules {
    let mut r = rules();
    r.tokens[0].address = USDC_ADDR_CHECKSUM.into();
    r.receivers = vec![OWNER_ADDR.replace("0x", "0X"), SPEC_ADDR.into()];
    r
}

#[test]
fn rules_are_stored_with_lowercase_addresses() {
    let c = setup_with(rules_with_checksummed_addresses());
    Call::by(STRANGER).apply();
    let stored = c.get_rules(id(AGENT)).unwrap().rules;
    assert_eq!(stored.tokens[0].address, USDC_ADDR);
    assert_eq!(stored.receivers, vec![OWNER_ADDR, SPEC_ADDR_LOWER]);
    let view = serde_json::to_value(c.get_rules(id(AGENT))).unwrap();
    assert_eq!(view["rules"]["tokens"][0]["address"], json!(USDC_ADDR));
    assert_eq!(
        view["rules"]["receivers"],
        json!([OWNER_ADDR, SPEC_ADDR_LOWER])
    );
    assert_eq!(view["rules"]["markets"][0]["sz_decimals"], json!(5));

    // set_rules stores the normalized form too (here a tightening: one receiver fewer).
    let mut c = setup();
    let mut tighter = rules();
    tighter.tokens[0].address = USDC_ADDR.to_uppercase();
    tighter.receivers.clear();
    Call::by(OWNER).deposit(1).apply();
    c.set_rules(id(AGENT), tighter);
    let state = agent_state(&c);
    assert_eq!(state.rules_version, 2);
    assert_eq!(state.rules.tokens[0].address, USDC_ADDR);
    // And a pending loosening is stored normalized as well.
    let mut looser = rules();
    looser.receivers.push(SPEC_ADDR.into());
    Call::by(OWNER).deposit(1).apply();
    c.set_rules(id(AGENT), looser);
    let (pending, _) = agent_state(&c).pending.unwrap();
    assert_eq!(pending.receivers, vec![OWNER_ADDR, SPEC_ADDR_LOWER]);
}

#[test]
fn invalid_sz_decimals_and_addresses_are_refused() {
    type Edit = fn(&mut Rules);
    let cases: &[(Edit, &str)] = &[
        (|r| r.markets[0].sz_decimals = 7, "markets"),
        (|r| r.markets[0].sz_decimals = 1, "markets"), // cap 0.01 has 2 decimals
        (|r| r.markets[1].max_order_sz = "0.00001".into(), "markets"), // ETH: 4
        (|r| r.tokens[0].address = SPEC_ADDR_TYPO.into(), "tokens"),
        (|r| r.receivers.push(SPEC_ADDR_TYPO.into()), "receivers"),
        (
            |r| r.receivers.push("0x5aaeb6053f3e94c9b9a09f".into()),
            "receivers",
        ),
        (
            |r| r.receivers.push(SPEC_ADDR_LOWER.replace('a', "z")),
            "receivers",
        ),
        (
            |r| r.receivers = vec![SPEC_ADDR.into(), SPEC_ADDR_LOWER.into()],
            "receivers",
        ),
    ];
    for (edit, field) in cases {
        let mut bad = rules();
        edit(&mut bad);
        let mut c = new_guard();
        Call::by(OWNER).deposit(1).apply();
        expect_panic(&format!("ERR_INVALID_RULES ({field})"), || {
            c.register_agent(id(AGENT), bad.clone())
        });
        assert_eq!(c.get_status().agents_count, 0);
        let mut c = setup();
        Call::by(OWNER).deposit(1).apply();
        expect_panic(&format!("ERR_INVALID_RULES ({field})"), || {
            c.set_rules(id(AGENT), bad)
        });
        let state = agent_state(&c);
        assert_eq!((state.rules_version, state.pending), (1, None));
    }
}

// ---- owner decision D-11: unreadable sz_decimals are ERR_INVALID_RULES, not a JSON error ------

/// The arguments of `register_agent` and `set_rules`, read the way near-sdk's generated method
/// wrapper reads them: `serde_json::from_slice` of the raw call input into `{agent_id, rules}`.
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RulesArgs {
    agent_id: AccountId,
    rules: Rules,
}

/// The raw call input `{"agent_id": AGENT, "rules": <fixture rules>}` with BTC's cap set to `1`
/// (valid with every `sz_decimals` from 0 to 6) and BTC's `sz_decimals` written as the JSON
/// text `raw` (`300`, `-1`, `"5"`, ...), or left out for `None`.
fn rules_args_text(raw: Option<&str>) -> String {
    const MARKER: &str = "<sz_decimals>";
    let mut args = json!({"agent_id": AGENT, "rules": rules()});
    let btc = args["rules"]["markets"][0].as_object_mut().unwrap();
    btc.insert("max_order_sz".into(), json!("1"));
    btc.insert("sz_decimals".into(), json!(MARKER));
    if raw.is_none() {
        btc.remove("sz_decimals");
    }
    let text = args.to_string();
    let Some(raw) = raw else { return text };
    let quoted = format!("\"{MARKER}\"");
    assert_eq!(text.matches(&quoted).count(), 1);
    let text = text.replace(&quoted, raw);
    assert!(text.contains(&format!(r#""sz_decimals":{raw}"#)), "{text}");
    text
}

/// Parses the raw call input as the wasm does; panics with near-sdk's message if it cannot.
#[track_caller]
fn parse_rules_args(text: &str) -> RulesArgs {
    serde_json::from_slice(text.as_bytes())
        .unwrap_or_else(|e| panic!("Failed to deserialize input from JSON. Error: `{e}`"))
}

/// `register_agent` and `set_rules` (owner, 1 yocto) with the raw input `text` both panic with
/// `ERR_INVALID_RULES (markets)`, and nothing is stored.
#[track_caller]
fn assert_invalid_markets(text: &str) {
    const EXPECTED: &str = "ERR_INVALID_RULES (markets)";
    let mut c = new_guard();
    let args = parse_rules_args(text);
    Call::by(OWNER).deposit(1).apply();
    let message = panic_message(|| c.register_agent(args.agent_id, args.rules));
    assert!(message.contains(EXPECTED), "{text}: {message}");
    assert_eq!(c.get_status().agents_count, 0, "{text}");
    assert_eq!(c.get_rules(id(AGENT)), None, "{text}");

    let mut c = setup();
    let args = parse_rules_args(text);
    Call::by(OWNER).deposit(1).apply();
    let message = panic_message(|| c.set_rules(args.agent_id, args.rules));
    assert!(message.contains(EXPECTED), "{text}: {message}");
    let state = agent_state(&c);
    assert_eq!(state.rules, rules(), "{text}");
    assert_eq!((state.rules_version, state.pending), (1, None), "{text}");
}

#[test]
fn sz_decimals_300_and_minus_1_are_invalid_rules_not_json_errors() {
    for raw in ["300", "-1"] {
        let text = rules_args_text(Some(raw));
        // The input parses (no "Failed to deserialize input from JSON"); the value reads as
        // the marker, which rules validation refuses.
        let args = parse_rules_args(&text);
        assert_eq!(args.agent_id, id(AGENT));
        assert_eq!(
            args.rules.markets[0].sz_decimals, INVALID_SZ_DECIMALS,
            "{raw}"
        );
        assert_eq!(args.rules.markets[1], rules().markets[1]);
        assert_invalid_markets(&text);
    }
}

#[test]
fn every_unreadable_sz_decimals_is_an_invalid_rules_error() {
    for raw in [
        "1.5",
        "1e2",
        "5.0",
        "-0",
        "256",
        "18446744073709551616",
        r#""5""#,
        "true",
        "null",
        "[5]",
        r#"{"value":5}"#,
    ] {
        let text = rules_args_text(Some(raw));
        let args = parse_rules_args(&text);
        assert_eq!(
            args.rules.markets[0].sz_decimals, INVALID_SZ_DECIMALS,
            "{raw}"
        );
        assert_invalid_markets(&text);
    }
    let missing = rules_args_text(None);
    assert_eq!(
        missing.matches("sz_decimals").count(),
        1,
        "only ETH's: {missing}"
    );
    let args = parse_rules_args(&missing);
    assert_eq!(args.rules.markets[0].sz_decimals, INVALID_SZ_DECIMALS);
    assert_invalid_markets(&missing);
    // An integer from 7 to 255 reads as itself and is refused the same way.
    for raw in ["7", "255"] {
        let text = rules_args_text(Some(raw));
        assert_eq!(
            parse_rules_args(&text).rules.markets[0].sz_decimals,
            raw.parse::<u8>().unwrap()
        );
        assert_invalid_markets(&text);
    }
}

#[test]
fn sz_decimals_that_a_json_value_cannot_hold_are_invalid_rules_errors() {
    // Valid JSON that `serde_json::Value` cannot be built from ("number out of range",
    // "recursion limit exceeded", unpaired surrogate): still ERR_INVALID_RULES, not a JSON error.
    let nested = format!("{}{}", "[".repeat(200), "]".repeat(200));
    let long_integer = format!("1{}", "0".repeat(400));
    for raw in [
        "1e400",
        "-1e400",
        "1E400",
        &long_integer,
        &nested,
        r#""\uD800""#,
        "1e-400",
        "0e99999999999",
        "261",
    ] {
        let text = rules_args_text(Some(raw));
        let args = parse_rules_args(&text);
        assert_eq!(
            args.rules.markets[0].sz_decimals, INVALID_SZ_DECIMALS,
            "{raw}"
        );
        assert_invalid_markets(&text);
    }
    // JSON that does not parse at all is still near-sdk's JSON error.
    for raw in ["05", "+5", "5,", "[5", "0x5"] {
        let text = rules_args_text(Some(raw));
        assert!(
            serde_json::from_slice::<RulesArgs>(text.as_bytes()).is_err(),
            "{raw}"
        );
    }
}

#[test]
fn sz_decimals_reads_the_same_with_spaces_and_from_a_json_value() {
    // Pretty-printed input: whitespace around the integer is not part of the value.
    for raw in [" 5", "\n\t5 \r\n", " 300 "] {
        let text = rules_args_text(Some(raw));
        let expected = raw.trim().parse::<u8>().unwrap_or(INVALID_SZ_DECIMALS);
        assert_eq!(
            parse_rules_args(&text).rules.markets[0].sz_decimals,
            expected,
            "{raw:?}"
        );
    }
    let pretty =
        serde_json::to_string_pretty(&json!({"agent_id": AGENT, "rules": rules()})).unwrap();
    assert!(pretty.contains("\"sz_decimals\": 5"), "{pretty}");
    assert_eq!(parse_rules_args(&pretty).rules, rules());
    // Read from an already parsed `serde_json::Value` (not the wasm path) the same way.
    for (value, expected) in [
        (json!(0), 0),
        (json!(5), 5),
        (json!(255), 255),
        (json!(256), INVALID_SZ_DECIMALS),
        (json!(-1), INVALID_SZ_DECIMALS),
        (json!(5.0), INVALID_SZ_DECIMALS),
        (json!("5"), INVALID_SZ_DECIMALS),
        (json!(null), INVALID_SZ_DECIMALS),
    ] {
        let mut rules_json = serde_json::to_value(rules()).unwrap();
        rules_json["markets"][0]["sz_decimals"] = value.clone();
        let read = serde_json::from_value::<Rules>(rules_json).unwrap();
        assert_eq!(read.markets[0].sz_decimals, expected, "{value}");
    }
}

#[test]
fn sz_decimals_0_and_6_are_accepted_through_the_json_input() {
    for sz_decimals in [0, MAX_PERP_DECIMALS] {
        let text = rules_args_text(Some(&sz_decimals.to_string()));
        let mut c = new_guard();
        let args = parse_rules_args(&text);
        Call::by(OWNER).deposit(1).apply();
        c.register_agent(args.agent_id, args.rules);
        Call::by(STRANGER).apply();
        let view = serde_json::to_value(c.get_rules(id(AGENT))).unwrap();
        assert_eq!(
            view["rules"]["markets"][0]["sz_decimals"],
            json!(sz_decimals)
        );
        assert_eq!(view["rules"]["markets"][1]["sz_decimals"], json!(4));

        // Through set_rules: a changed `sz_decimals` is a loosening, so it waits as pending.
        let mut c = setup();
        let args = parse_rules_args(&text);
        Call::by(OWNER).deposit(1).apply();
        c.set_rules(args.agent_id, args.rules);
        let (pending, _) = agent_state(&c).pending.expect("stored as pending");
        assert_eq!(pending.markets[0].sz_decimals, sz_decimals);
    }
}

#[test]
fn market_rule_serialization_is_unchanged() {
    let btc = market("BTC", BTC_ASSET, "0.01", BTC_SZ_DECIMALS);
    let text = r#"{"name":"BTC","asset":3,"max_order_sz":"0.01","sz_decimals":5}"#;
    assert_eq!(serde_json::to_string(&btc).unwrap(), text);
    assert_eq!(serde_json::from_str::<MarketRule>(text).unwrap(), btc);
    // Unknown fields are still ignored; a bare MarketRule reads `sz_decimals` like Rules does.
    let extra = r#"{"name":"BTC","asset":3,"max_order_sz":"0.01","sz_decimals":5,"x":1}"#;
    assert_eq!(serde_json::from_str::<MarketRule>(extra).unwrap(), btc);
    let bad = r#"{"name":"BTC","asset":3,"max_order_sz":"0.01","sz_decimals":-1}"#;
    assert_eq!(
        serde_json::from_str::<MarketRule>(bad).unwrap().sz_decimals,
        INVALID_SZ_DECIMALS
    );
    // Stored as Borsh with a one-byte `sz_decimals`, as before.
    let borsh = near_sdk::borsh::to_vec(&btc).unwrap();
    assert_eq!(borsh.len(), (4 + 3) + 4 + (4 + 4) + 1);
    assert_eq!(borsh.last(), Some(&BTC_SZ_DECIMALS));

    // `get_rules` output keeps `"sz_decimals": <integer>` and reads back as the same state.
    let c = setup();
    Call::by(STRANGER).apply();
    let state = c.get_rules(id(AGENT)).unwrap();
    let json = serde_json::to_string(&state).unwrap();
    assert!(json.contains(r#""sz_decimals":5"#) && json.contains(r#""sz_decimals":4"#));
    assert_eq!(serde_json::from_str::<AgentState>(&json).unwrap(), state);

    // Only `MarketRule::sz_decimals` reads leniently: other fields still fail to parse.
    let mut rules_json = serde_json::to_value(rules()).unwrap();
    rules_json["tokens"][0]["decimals"] = json!(300);
    assert!(serde_json::from_value::<Rules>(rules_json).is_err());
    let mut rules_json = serde_json::to_value(rules()).unwrap();
    rules_json["markets"][0]["asset"] = json!(-1);
    assert!(serde_json::from_value::<Rules>(rules_json).is_err());
    let mut leverage = serde_json::to_value(hl_leverage("BTC", 2, NOW_MS)).unwrap();
    leverage["order"]["HlUpdateLeverage"]["leverage"] = json!(300);
    assert!(serde_json::from_value::<Proposal>(leverage).is_err());
}

#[test]
fn confirm_rules_refuses_pending_rules_that_are_not_valid() {
    // Unreachable through set_rules (it validates first); planted directly to check that
    // confirm_rules validates again before anything takes effect.
    let mut c = setup();
    let mut bad = rules();
    bad.markets[0].sz_decimals = INVALID_SZ_DECIMALS;
    c.agents.get_mut(&id(AGENT)).unwrap().state.pending = Some((bad.clone(), U64(NOW_NS)));
    Call::by(OWNER).deposit(1).apply();
    expect_panic("ERR_INVALID_RULES (markets)", || c.confirm_rules(id(AGENT)));
    let state = agent_state(&c);
    assert_eq!((state.rules, state.rules_version), (rules(), 1));
    // A valid pending change still confirms.
    let mut looser = rules();
    looser.max_leverage = MAX_LEVERAGE + 1;
    c.agents.get_mut(&id(AGENT)).unwrap().state.pending = Some((looser.clone(), U64(NOW_NS)));
    Call::by(OWNER).deposit(1).apply();
    c.confirm_rules(id(AGENT));
    let state = agent_state(&c);
    assert_eq!((state.rules, state.rules_version), (looser, 2));
}

#[test]
fn resending_rules_with_checksummed_addresses_is_not_a_loosening() {
    let mut registered = rules();
    registered.receivers.push(SPEC_ADDR_LOWER.into());
    let mut c = setup_with(registered.clone());
    Call::by(OWNER).deposit(1).apply();
    c.set_rules(id(AGENT), rules_with_checksummed_addresses());
    let state = agent_state(&c);
    assert_eq!(state.pending, None);
    assert_eq!(state.rules_version, 2);
    assert_eq!(state.rules, registered);
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "rules_updated",
            "data": [{"agent_id": AGENT, "rules_version": 2, "tightened": true}]
        })]
    );
}

#[test]
fn changing_sz_decimals_waits_for_the_delay() {
    for sz_decimals in [BTC_SZ_DECIMALS - 1, BTC_SZ_DECIMALS + 1] {
        let mut c = setup();
        let mut changed = rules();
        changed.markets[0].sz_decimals = sz_decimals;
        Call::by(OWNER).deposit(1).apply();
        c.set_rules(id(AGENT), changed.clone());
        let state = agent_state(&c);
        assert_eq!(state.rules, rules());
        assert_eq!(state.rules_version, 1);
        let eta = NOW_NS + LOOSEN_DELAY_SEC * 1_000_000_000;
        assert_eq!(state.pending, Some((changed, U64(eta))));
        // The old precision still applies until confirmed: 6 size decimals stay refused.
        let decision = propose_blocked(
            &mut c,
            hl_order("BTC", "1000", "0.000001", NOW_MS),
            RuleCode::Malformed,
        );
        assert_eq!(
            decision.message,
            "Blocked by your rule: orders must be well-formed (sz)"
        );
    }
}

#[test]
fn checksummed_receiver_in_rules_matches_a_lowercase_to() {
    let mut c = setup_with(rules_with_checksummed_addresses());
    for (nonce, to) in [
        (0, SPEC_ADDR_LOWER),
        (1, SPEC_ADDR),
        (2, &*format!("0X{}", SPEC_ADDR_LOWER[2..].to_uppercase())),
    ] {
        let receipt_id = propose_allowed(&mut c, transfer(to, 1, nonce));
        let receipt = c.get_receipt(U64(receipt_id)).unwrap();
        // The receipt shows the lowercase form whatever the agent sent.
        let OrderRequest::EvmTransfer { to: stored, .. } = &receipt.proposal.order else {
            panic!("kind kept")
        };
        assert_eq!(stored, SPEC_ADDR_LOWER, "{to}");
        assert!(receipt.signed_body.unwrap().contains(&SPEC_ADDR_LOWER[2..]));
    }
}

#[test]
fn blocked_receivers_show_in_lowercase() {
    let mut c = setup();
    let sent = "0xBAd0000000000000000000000000000000000Bad"; // EIP-55 of BAD_ADDR
    let decision = propose_blocked(&mut c, transfer(sent, 1, 0), RuleCode::ReceiverNotAllowed);
    let message = "Blocked by your rule: receiver 0xbad0000000000000000000000000000000000bad is not on your list";
    assert_eq!(decision.message, message);
    let receipt = c.get_receipt(decision.receipt_id).unwrap();
    assert_eq!(receipt.message, message);
    assert_eq!(receipt.proposal, transfer(BAD_ADDR, 1, 0));
    assert_eq!(
        logged_events(),
        vec![json!({
            "standard": "clawguard", "version": "1.0.0", "event": "order_blocked",
            "data": [{
                "receipt_id": "1",
                "agent_id": AGENT,
                "target": "BaseSepolia",
                "rule_code": "RECEIVER_NOT_ALLOWED",
                "message": message,
            }]
        })]
    );

    // A wrong checksum is malformed; the receipt keeps the text as sent.
    let decision = propose_blocked(&mut c, transfer(SPEC_ADDR_TYPO, 1, 0), RuleCode::Malformed);
    assert_eq!(
        decision.message,
        "Blocked by your rule: orders must be well-formed (to)"
    );
    let receipt = c.get_receipt(decision.receipt_id).unwrap();
    assert_eq!(receipt.proposal, transfer(SPEC_ADDR_TYPO, 1, 0));
}

#[test]
fn too_fine_orders_are_malformed_through_the_contract() {
    let mut c = setup();
    propose_allowed(&mut c, hl_order("BTC", "1000.5", "0.00001", NOW_MS));
    // The nonce NOW_MS is now consumed: an order that is also too fine reports MALFORMED.
    for (proposal, field) in [
        (hl_order("BTC", "1000", "0.000001", NOW_MS), "sz"),
        (hl_order("BTC", "100.25", "0.001", NOW_MS), "limit_px"),
        (hl_order("ETH", "1000", "0.00001", NOW_MS), "sz"),
    ] {
        let decision = propose_blocked(&mut c, proposal, RuleCode::Malformed);
        assert_eq!(
            decision.message,
            format!("Blocked by your rule: orders must be well-formed ({field})")
        );
    }
    propose_blocked(&mut c, small_btc(NOW_MS), RuleCode::StaleNonce);
    // An unlisted market is MARKET_NOT_ALLOWED whatever its decimals.
    propose_blocked(
        &mut c,
        hl_order("DOGE", "0.0012345", "0.12345678", NOW_MS + 1),
        RuleCode::MarketNotAllowed,
    );
    Call::by(STRANGER).apply();
    assert_eq!(
        c.preview_payload(id(AGENT), hl_order("BTC", "1000", "0.000001", NOW_MS + 1)),
        PreviewResult::Err("Blocked by your rule: orders must be well-formed (sz)".into())
    );
}

// ---- vectors through the contract --------------------------------------------------------------

const HL_ORDER_VECTORS: &str = include_str!("../../../offchain/test/vectors/hl_orders.json");
const HL_LEVERAGE_VECTORS: &str =
    include_str!("../../../offchain/test/vectors/hl_update_leverage.json");
const EVM_VECTORS: &str = include_str!("../../../offchain/test/vectors/evm_transfers.json");

fn vectors(json: &str) -> Vec<Value> {
    let doc: Value = serde_json::from_str(json).unwrap();
    doc["vectors"].as_array().unwrap().clone()
}

/// Rules that map the vector's asset index to a market `M<asset>` with `sz_decimals` and allow
/// it generously.
fn rules_for_asset(asset: u32, sz_decimals: u8) -> Rules {
    Rules {
        markets: vec![market(&format!("M{asset}"), asset, "1000", sz_decimals)],
        max_order_notional: U128(u128::MAX),
        max_leverage: 50,
        daily_cap: U128(u128::MAX),
        ..rules()
    }
}

/// Decimals of a canonical decimal string (`"0.001"` -> 3).
fn decimals_of(s: &str) -> u8 {
    s.split_once('.').map_or(0, |(_, frac)| frac.len() as u8)
}

/// Vectors whose sizes or prices are finer than any HL market allows (`sz_decimals <= 6`): the
/// SDK encodes them (`hl.rs` checks the encoder against all ten), but the contract refuses to
/// sign them. Each is asserted to be `MALFORMED(<field>)` below.
const VECTORS_FINER_THAN_ANY_MARKET: [(&str, &str); 3] = [
    ("asset0_tiny", "sz"),           // sz 0.00000001: 8 decimals
    ("asset255_uint8_max", "sz"),    // sz 0.12345678: 8 decimals
    ("asset256_uint16", "limit_px"), // px 0.0001234: 7 decimals, even with sz_decimals 0
];

#[test]
fn allowed_hl_orders_sign_the_vector_digests() {
    let mut checked = 0;
    let mut refused = Vec::new();
    for v in vectors(HL_ORDER_VECTORS) {
        let request = &v["request"];
        let asset = request["coin_asset"].as_u64().unwrap() as u32;
        let nonce_ms = v["nonce_ms"].as_u64().unwrap();
        let name = v["name"].as_str().unwrap();
        // A market precision that fits the vector's size and price where one exists
        // (`sz decimals <= sz_decimals <= 6 - px decimals`). For the three vectors finer than
        // any market it leaves exactly the too-fine field failing.
        let px_decimals = decimals_of(request["limit_px"].as_str().unwrap());
        let sz_decimals = decimals_of(request["sz"].as_str().unwrap())
            .min(MAX_PERP_DECIMALS.saturating_sub(px_decimals));
        let proposal = Proposal {
            target: Target::HlTestnet,
            order: OrderRequest::HlOrder {
                market: format!("M{asset}"),
                is_buy: request["is_buy"].as_bool().unwrap(),
                limit_px: request["limit_px"].as_str().unwrap().into(),
                sz: request["sz"].as_str().unwrap().into(),
                reduce_only: request["reduce_only"].as_bool().unwrap(),
                tif: request["tif"].as_str().unwrap().into(),
                nonce_ms: U64(nonce_ms),
            },
            memo: None,
        };
        let mut c = setup_with(rules_for_asset(asset, sz_decimals));
        let Some(now_ns) = nonce_ms.checked_mul(1_000_000) else {
            // `big_nonce` (u64::MAX ms) can never be inside the ±5 min window.
            propose_blocked(&mut c, proposal, RuleCode::StaleNonce);
            continue;
        };
        if let Some((_, field)) = VECTORS_FINER_THAN_ANY_MARKET
            .iter()
            .find(|(excluded, _)| *excluded == name)
        {
            let decision = blocked_with(
                &mut c,
                Call::by(AGENT).at(now_ns),
                proposal,
                RuleCode::Malformed,
            );
            assert_eq!(
                decision.message,
                format!("Blocked by your rule: orders must be well-formed ({field})"),
                "{name}"
            );
            refused.push(name.to_owned());
            continue;
        }
        let receipt_id = propose_allowed_with(&mut c, Call::by(AGENT).at(now_ns), proposal);
        let receipt = c.get_receipt(U64(receipt_id)).unwrap();
        assert_eq!(
            receipt.payload_hash.as_deref(),
            v["digest"].as_str(),
            "{name}"
        );
        assert_eq!(
            receipt.signed_body.as_deref(),
            v["action_json"].as_str(),
            "{name}"
        );
        checked += 1;
    }
    assert_eq!(checked, 6);
    let expected: Vec<String> = VECTORS_FINER_THAN_ANY_MARKET
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect();
    assert_eq!(refused, expected);
}

#[test]
fn allowed_leverage_updates_sign_the_vector_digests() {
    for v in vectors(HL_LEVERAGE_VECTORS) {
        let request = &v["request"];
        let asset = request["coin_asset"].as_u64().unwrap() as u32;
        let nonce_ms = v["nonce_ms"].as_u64().unwrap();
        let proposal = Proposal {
            target: Target::HlTestnet,
            order: OrderRequest::HlUpdateLeverage {
                market: format!("M{asset}"),
                is_cross: request["is_cross"].as_bool().unwrap(),
                leverage: request["leverage"].as_u64().unwrap() as u8,
                nonce_ms: U64(nonce_ms),
            },
            memo: None,
        };
        // A leverage update has no size: any `sz_decimals` works.
        let mut c = setup_with(rules_for_asset(asset, 0));
        let receipt_id =
            propose_allowed_with(&mut c, Call::by(AGENT).at(nonce_ms * 1_000_000), proposal);
        let receipt = c.get_receipt(U64(receipt_id)).unwrap();
        assert_eq!(receipt.payload_hash.as_deref(), v["digest"].as_str());
        assert_eq!(receipt.signed_body.as_deref(), v["action_json"].as_str());
    }
}

#[test]
fn allowed_transfers_sign_the_vector_hashes() {
    for v in vectors(EVM_VECTORS) {
        let request = &v["request"];
        let num = |key: &str| request[key].as_str().unwrap().parse::<u128>().unwrap();
        let to = request["to"].as_str().unwrap();
        let mut r = rules();
        r.tokens = vec![token(
            "USDC",
            v["token_address"].as_str().unwrap(),
            u128::MAX,
        )];
        r.receivers = vec![to.to_owned()];
        r.daily_cap = U128(u128::MAX);
        let mut c = setup_with(r);
        let proposal = Proposal {
            target: Target::BaseSepolia,
            order: OrderRequest::EvmTransfer {
                token: "USDC".into(),
                to: to.into(),
                amount: U128(num("amount")),
                nonce: U64(num("nonce") as u64),
                gas_limit: U64(num("gas_limit") as u64),
                max_fee_per_gas: U128(num("max_fee_per_gas")),
                max_priority_fee_per_gas: U128(num("max_priority_fee_per_gas")),
            },
            memo: None,
        };
        let receipt_id = propose_allowed(&mut c, proposal);
        let receipt = c.get_receipt(U64(receipt_id)).unwrap();
        assert_eq!(receipt.payload_hash.as_deref(), v["payload_hash"].as_str());
        assert_eq!(receipt.signed_body.as_deref(), v["unsigned_tx"].as_str());
        assert_eq!(receipt.derivation_path.as_deref(), Some("base-sepolia-1"));
    }
}

// ---- tamper resistance -----------------------------------------------------------------------

/// One change to an order's fields.
type OrderEdit = Box<dyn Fn(&mut OrderRequest)>;

fn preview_hash(c: &ClawGuard, proposal: Proposal) -> String {
    Call::by(STRANGER).apply();
    match c.preview_payload(id(AGENT), proposal) {
        PreviewResult::Ok(hash) => hash,
        PreviewResult::Err(message) => panic!("{message}"),
    }
}

#[test]
fn agent_cannot_supply_asset_index_or_token_address() {
    let c = setup();
    // Extra fields an agent might add are ignored by the parser.
    let tampered = json!({
        "target": "HlTestnet",
        "order": {"HlOrder": {
            "market": "BTC", "is_buy": true, "limit_px": "1000", "sz": "0.001",
            "reduce_only": false, "tif": "Gtc", "nonce_ms": NOW_MS.to_string(),
            "a": 0, "asset": 0, "coin_asset": 0, "vaultAddress": BAD_ADDR, "source": "a"
        }},
        "asset": 0, "chain_id": 1, "derivation_path": "other"
    });
    let tampered: Proposal = serde_json::from_value(tampered).unwrap();
    assert_eq!(tampered, small_btc(NOW_MS));
    assert_eq!(
        preview_hash(&c, tampered),
        preview_hash(&c, small_btc(NOW_MS))
    );

    let tampered = json!({
        "target": "BaseSepolia",
        "order": {"EvmTransfer": {
            "token": "USDC", "to": OWNER_ADDR, "amount": "1", "nonce": "0",
            "gas_limit": "65000", "max_fee_per_gas": "1000000000",
            "max_priority_fee_per_gas": "1000000",
            "token_address": BAD_ADDR, "address": BAD_ADDR, "chain_id": "1", "value": "5"
        }}
    });
    let tampered: Proposal = serde_json::from_value(tampered).unwrap();
    assert_eq!(tampered, transfer(OWNER_ADDR, 1, 0));
    // The token is a symbol from the owner's list; an address in its place is refused.
    let mut by_address = transfer(OWNER_ADDR, 1, 0);
    if let OrderRequest::EvmTransfer { token, .. } = &mut by_address.order {
        *token = USDC_ADDR.into();
    }
    Call::by(STRANGER).apply();
    assert_eq!(
        c.preview_payload(id(AGENT), by_address),
        PreviewResult::Err("Blocked by your rule: orders must be well-formed (token)".into())
    );
    let original = preview_hash(&c, small_btc(NOW_MS));
    drop(c);
    // The owner's asset index decides the payload: same agent order, other owner mapping.
    let mut moved = rules();
    moved.markets[0].asset = 42;
    let c = setup_with(moved);
    assert_ne!(preview_hash(&c, small_btc(NOW_MS)), original);
}

#[test]
fn every_order_field_changes_the_payload_hash() {
    let c = setup();
    let base = small_btc(NOW_MS);
    let edits: Vec<OrderEdit> = vec![
        Box::new(|o| {
            if let OrderRequest::HlOrder { market, .. } = o {
                *market = "ETH".into()
            }
        }),
        Box::new(|o| {
            if let OrderRequest::HlOrder { is_buy, .. } = o {
                *is_buy = false
            }
        }),
        Box::new(|o| {
            if let OrderRequest::HlOrder { limit_px, .. } = o {
                *limit_px = "1001".into()
            }
        }),
        Box::new(|o| {
            if let OrderRequest::HlOrder { sz, .. } = o {
                *sz = "0.002".into()
            }
        }),
        Box::new(|o| {
            if let OrderRequest::HlOrder { reduce_only, .. } = o {
                *reduce_only = true
            }
        }),
        Box::new(|o| {
            if let OrderRequest::HlOrder { tif, .. } = o {
                *tif = "Ioc".into()
            }
        }),
        Box::new(|o| {
            if let OrderRequest::HlOrder { nonce_ms, .. } = o {
                *nonce_ms = U64(NOW_MS + 1)
            }
        }),
    ];
    let mut hashes = HashSet::from([preview_hash(&c, base.clone())]);
    for edit in &edits {
        let mut p = base.clone();
        edit(&mut p.order);
        assert!(
            hashes.insert(preview_hash(&c, p)),
            "a field did not change the hash"
        );
    }
    // The memo is recorded, never signed.
    let mut with_memo = base.clone();
    with_memo.memo = Some("note".into());
    assert!(hashes.contains(&preview_hash(&c, with_memo)));

    drop(c);
    let base = transfer(OWNER_ADDR, 1_000_000, 3);
    let mut r = rules();
    r.receivers.push(BAD_ADDR.into());
    let c = setup_with(r);
    let edits: Vec<OrderEdit> = vec![
        Box::new(|o| {
            if let OrderRequest::EvmTransfer { to, .. } = o {
                *to = BAD_ADDR.into()
            }
        }),
        Box::new(|o| {
            if let OrderRequest::EvmTransfer { amount, .. } = o {
                *amount = U128(1_000_001)
            }
        }),
        Box::new(|o| {
            if let OrderRequest::EvmTransfer { nonce, .. } = o {
                *nonce = U64(4)
            }
        }),
        Box::new(|o| {
            if let OrderRequest::EvmTransfer { gas_limit, .. } = o {
                *gas_limit = U64(65_001)
            }
        }),
        Box::new(|o| {
            if let OrderRequest::EvmTransfer {
                max_fee_per_gas, ..
            } = o
            {
                *max_fee_per_gas = U128(1_000_000_001)
            }
        }),
        Box::new(|o| {
            if let OrderRequest::EvmTransfer {
                max_priority_fee_per_gas,
                ..
            } = o
            {
                *max_priority_fee_per_gas = U128(1_000_001)
            }
        }),
    ];
    let mut hashes = HashSet::from([preview_hash(&c, base.clone())]);
    for edit in &edits {
        let mut p = base.clone();
        edit(&mut p.order);
        assert!(
            hashes.insert(preview_hash(&c, p)),
            "a field did not change the hash"
        );
    }
}

// ---- property test ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Order,
    Leverage,
    Transfer,
}

/// One way to break exactly one rule, starting from a fully valid case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Violation {
    Paused,
    Expired,
    TargetOff,
    Malformed,
    Stale,
    NotListed,
    Receiver,
    Leverage,
    ReduceOnly,
    OverCap,
    DailyCount,
    DailyCap,
    NoBalance,
}

impl Violation {
    const ALL: [Self; 13] = [
        Self::Paused,
        Self::Expired,
        Self::TargetOff,
        Self::Malformed,
        Self::Stale,
        Self::NotListed,
        Self::Receiver,
        Self::Leverage,
        Self::ReduceOnly,
        Self::OverCap,
        Self::DailyCount,
        Self::DailyCap,
        Self::NoBalance,
    ];

    fn code(self, kind: Kind) -> RuleCode {
        match self {
            Self::Paused => RuleCode::Paused,
            Self::Expired => RuleCode::Expired,
            Self::TargetOff => RuleCode::TargetNotEnabled,
            Self::Malformed => RuleCode::Malformed,
            Self::Stale => RuleCode::StaleNonce,
            Self::NotListed if kind == Kind::Transfer => RuleCode::TokenNotAllowed,
            Self::NotListed => RuleCode::MarketNotAllowed,
            Self::Receiver => RuleCode::ReceiverNotAllowed,
            Self::Leverage => RuleCode::LeverageAboveLimit,
            Self::ReduceOnly => RuleCode::ReduceOnlyRequired,
            Self::OverCap => RuleCode::OrderAboveCap,
            Self::DailyCount => RuleCode::DailyOrderCount,
            Self::DailyCap => RuleCode::DailyCap,
            Self::NoBalance => RuleCode::InsufficientContractBalance,
        }
    }

    fn applies_to(self, kind: Kind) -> bool {
        match self {
            Self::Receiver => kind == Kind::Transfer,
            Self::Leverage => kind == Kind::Leverage,
            Self::ReduceOnly => kind == Kind::Order,
            // A leverage update has no size and spends nothing.
            Self::OverCap | Self::DailyCap => kind != Kind::Leverage,
            _ => true,
        }
    }
}

/// Everything a property case controls.
#[derive(Debug, Clone)]
struct Case {
    kind: Kind,
    rules: Rules,
    proposal: Proposal,
    paused: bool,
    orders_today: u32,
    spent_today: u128,
    last_hl_nonce_ms: Option<u64>,
    last_evm_nonce: Option<u64>,
    balance: Option<u128>,
}

/// One size step of a market with `sz_decimals`, in 1e-8 units (`5` -> `1_000` = 0.00001).
fn size_step(sz_decimals: u8) -> u64 {
    10u64.pow(8 - u32::from(sz_decimals))
}

fn random_valid_case(rng: &mut SplitMix64) -> Case {
    let kind = *rng.pick(&[Kind::Order, Kind::Leverage, Kind::Transfer]);
    let hl_nonce = NOW_MS - 300_000 + rng.range(0, 600_000);
    let mut proposal = match kind {
        Kind::Order => {
            let (name, cap_units, sz_decimals) = *rng.pick(&[
                ("BTC", 1_000_000u64, BTC_SZ_DECIMALS),
                ("ETH", 10_000_000, ETH_SZ_DECIMALS),
            ]);
            // Price: up to 5 significant figures and `6 - sz_decimals` decimals; size a whole
            // number of the market's size steps within its cap; notional within the per-order
            // cap.
            let sz_step = size_step(sz_decimals);
            let (px, sz) = loop {
                let mantissa = u128::from(rng.range(1, 99_999));
                let decimals = rng.range(0, u64::from(MAX_PERP_DECIMALS - sz_decimals)) as u32;
                let px_units = mantissa * 10u128.pow(8 - decimals);
                let sz_units = u128::from(rng.range(1, cap_units / sz_step) * sz_step);
                if (px_units * sz_units).div_ceil(10_000_000_000) <= MAX_NOTIONAL {
                    break (decimal_from_units(px_units), decimal_from_units(sz_units));
                }
            };
            Proposal {
                target: Target::HlTestnet,
                order: OrderRequest::HlOrder {
                    market: name.into(),
                    is_buy: rng.coin(),
                    limit_px: px,
                    sz,
                    reduce_only: rng.coin(),
                    tif: rng.pick(&["Gtc", "Ioc", "Alo"]).to_string(),
                    nonce_ms: U64(hl_nonce),
                },
                memo: None,
            }
        }
        Kind::Leverage => Proposal {
            target: Target::HlTestnet,
            order: OrderRequest::HlUpdateLeverage {
                market: rng.pick(&["BTC", "ETH"]).to_string(),
                is_cross: rng.coin(),
                leverage: rng.range(1, u64::from(MAX_LEVERAGE)) as u8,
                nonce_ms: U64(hl_nonce),
            },
            memo: None,
        },
        Kind::Transfer => {
            let max_fee = u128::from(rng.range(0, 100_000_000_000));
            // Any accepted spelling of the listed receiver.
            let to = match rng.range(0, 2) {
                0 => OWNER_ADDR.to_owned(),
                1 => format!("0x{}", OWNER_ADDR[2..].to_uppercase()),
                _ => OWNER_ADDR.replace("0x", "0X"),
            };
            Proposal {
                target: Target::BaseSepolia,
                order: OrderRequest::EvmTransfer {
                    token: "USDC".into(),
                    to,
                    amount: U128(u128::from(rng.range(1, USDC_CAP as u64))),
                    nonce: U64(rng.range(0, MAX_EVM_NONCE)),
                    gas_limit: U64(rng.range(21_000, 200_000)),
                    max_fee_per_gas: U128(max_fee),
                    max_priority_fee_per_gas: U128(u128::from(rng.range(0, max_fee as u64))),
                },
                memo: None,
            }
        }
    };
    if rng.coin() {
        proposal.memo = Some("m".repeat(rng.range(0, 140) as usize));
    }
    Case {
        kind,
        rules: rules(),
        proposal,
        paused: false,
        orders_today: rng.range(0, u64::from(MAX_ORDERS) - 1) as u32,
        spent_today: u128::from(rng.range(0, 900_000_000)),
        last_hl_nonce_ms: None,
        last_evm_nonce: None,
        balance: None,
    }
}

fn break_rule(case: &mut Case, violation: Violation, rng: &mut SplitMix64) {
    let order = &mut case.proposal.order;
    match violation {
        Violation::Paused => case.paused = true,
        Violation::Expired => case.rules.expires_at_ns = U64(NOW_NS - 1 - rng.range(0, 1 << 40)),
        Violation::TargetOff => {
            case.rules.targets = vec![match case.proposal.target {
                Target::HlTestnet => Target::BaseSepolia,
                Target::BaseSepolia => Target::HlTestnet,
            }]
        }
        Violation::Malformed => {
            if rng.range(0, 5) == 0 {
                case.proposal.memo = Some("m".repeat(rng.range(141, 400) as usize));
                return;
            }
            match order {
                OrderRequest::HlOrder {
                    market,
                    limit_px,
                    sz,
                    tif,
                    ..
                } => match rng.range(0, 6) {
                    0 => {
                        *limit_px = rng
                            .pick(&["01", "0.010", "1e3", "-1", "123.456", ""])
                            .to_string()
                    }
                    1 => {
                        *sz = rng
                            .pick(&["0", ".5", "0.000000001", "1.", " 1"])
                            .to_string()
                    }
                    2 => *tif = rng.pick(&["GTC", "gtc", "", "FrontendMarket"]).to_string(),
                    3 => *market = rng.pick(&["BTC-PERP", "", "B T C"]).to_string(),
                    4 => {
                        *limit_px = "100000000000000000000".into();
                        *sz = "100000000000".into(); // notional overflow
                    }
                    // Finer than the market allows: one decimal more than its `sz_decimals`
                    // (size) or `6 - sz_decimals` (price). Only a listed market has a
                    // precision; an unlisted one (NotListed applied first) gets a bad tif.
                    _ => match case.rules.markets.iter().find(|m| m.name == *market) {
                        Some(m) if rng.coin() => {
                            *sz = format!("0.{}1", "0".repeat(usize::from(m.sz_decimals)))
                        }
                        Some(m) => {
                            let px_decimals = MAX_PERP_DECIMALS - m.sz_decimals;
                            *limit_px = format!("0.{}1", "0".repeat(usize::from(px_decimals)))
                        }
                        None => *tif = "GTC".into(),
                    },
                },
                OrderRequest::HlUpdateLeverage {
                    market, leverage, ..
                } => {
                    if rng.coin() {
                        *leverage = 0;
                    } else {
                        *market = "X Y".into();
                    }
                }
                OrderRequest::EvmTransfer {
                    token,
                    to,
                    amount,
                    nonce,
                    gas_limit,
                    max_fee_per_gas,
                    max_priority_fee_per_gas,
                } => match rng.range(0, 6) {
                    0 => *token = "US-DC".into(),
                    1 => {
                        *to = rng
                            .pick(&[
                                "0x123",
                                "",
                                "1111111111111111111111111111111111111111",
                                // EIP-55 spec address with one letter's case flipped.
                                "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
                            ])
                            .to_string()
                    }
                    2 => *amount = U128(0),
                    3 => *gas_limit = U64(*rng.pick(&[0, 20_999, 200_001, u64::MAX])),
                    4 => *max_fee_per_gas = U128(100_000_000_001 + u128::from(rng.next_u64())),
                    5 => *nonce = U64(rng.range(MAX_EVM_NONCE + 1, u64::MAX)),
                    _ => *max_priority_fee_per_gas = U128(max_fee_per_gas.0 + 1),
                },
            }
        }
        Violation::Stale => match order {
            OrderRequest::HlOrder { nonce_ms, .. }
            | OrderRequest::HlUpdateLeverage { nonce_ms, .. } => match rng.range(0, 2) {
                0 => *nonce_ms = U64(NOW_MS - 300_001 - rng.range(0, 1 << 30)),
                1 => *nonce_ms = U64(NOW_MS + 300_001 + rng.range(0, 1 << 30)),
                _ => case.last_hl_nonce_ms = Some(nonce_ms.0 + rng.range(0, 1_000)),
            },
            OrderRequest::EvmTransfer { nonce, .. } => {
                case.last_evm_nonce = Some(nonce.0.saturating_add(rng.range(0, 1_000)))
            }
        },
        Violation::NotListed => match order {
            OrderRequest::HlOrder { market, .. }
            | OrderRequest::HlUpdateLeverage { market, .. } => {
                *market = rng.pick(&["DOGE", "SOL", "btc", "BTC2"]).to_string()
            }
            OrderRequest::EvmTransfer { token, .. } => {
                *token = rng.pick(&["WETH", "EURC", "usdc"]).to_string()
            }
        },
        Violation::Receiver => {
            if let OrderRequest::EvmTransfer { to, .. } = order {
                *to = format!("0x{:040x}", u128::from(rng.next_u64()) + 2);
            }
        }
        Violation::Leverage => {
            if let OrderRequest::HlUpdateLeverage { leverage, .. } = order {
                *leverage = rng.range(u64::from(MAX_LEVERAGE) + 1, 255) as u8;
            }
        }
        Violation::ReduceOnly => {
            case.rules.reduce_only_required = true;
            if let OrderRequest::HlOrder { reduce_only, .. } = order {
                *reduce_only = false;
            }
        }
        Violation::OverCap => match order {
            OrderRequest::HlOrder {
                market,
                sz,
                limit_px,
                ..
            } => {
                if rng.coin() {
                    // Size above the market cap, in whole size steps of the market.
                    let (cap, sz_decimals): (u128, u8) = if market == "BTC" {
                        (1_000_000, BTC_SZ_DECIMALS)
                    } else {
                        (10_000_000, ETH_SZ_DECIMALS)
                    };
                    let steps = u128::from(rng.range(1, 1 << 10));
                    *sz = decimal_from_units(cap + steps * u128::from(size_step(sz_decimals)));
                } else {
                    // Notional above the cap: 99999 × size ≥ 1000 quote units needs ≥ 0.0100001.
                    *limit_px = "99999".into();
                    *sz = decimal_from_units(1_100_000);
                    *market = "ETH".into();
                }
            }
            OrderRequest::EvmTransfer { amount, .. } => {
                *amount = U128(USDC_CAP + u128::from(rng.range(1, u64::MAX)));
            }
            OrderRequest::HlUpdateLeverage { .. } => unreachable!(),
        },
        Violation::DailyCount => case.orders_today = MAX_ORDERS,
        Violation::DailyCap => case.spent_today = DAILY_CAP,
        Violation::NoBalance => case.balance = Some(u128::from(rng.range(0, 1 << 40))),
    }
}

/// Runs one case on a fresh contract.
fn run_case(case: &Case) -> (ClawGuard, PromiseOrValue<Decision>) {
    let mut c = setup_with(case.rules.clone());
    {
        let state = &mut c.agents.get_mut(&id(AGENT)).unwrap().state;
        state.orders_today = case.orders_today;
        state.spent_today = U128(case.spent_today);
        state.last_hl_nonce_ms = case.last_hl_nonce_ms.map(U64);
        state.last_evm_nonce = case.last_evm_nonce.map(U64);
    }
    if case.paused {
        c.paused = true;
        c.pause_reason = Some("property".into());
    }
    let mut call = Call::by(AGENT);
    if let Some(balance) = case.balance {
        call = call.balance(balance);
    }
    let outcome = propose_with(&mut c, call, case.proposal.clone());
    (c, outcome)
}

#[test]
fn property_violating_orders_never_reach_the_mpc() {
    let mut rng = SplitMix64(0xC1A9_6A2D);
    let mut seen = HashSet::new();
    for i in 0..1_000 {
        let mut case = random_valid_case(&mut rng);
        let applicable: Vec<Violation> = Violation::ALL
            .into_iter()
            .filter(|v| v.applies_to(case.kind))
            .collect();
        // 1 to 4 distinct violations, applied from the last rule to the first so a later
        // (earlier-checked) one is never undone.
        let mut chosen: Vec<Violation> = Vec::new();
        for _ in 0..rng.range(1, 4) {
            let v = *rng.pick(&applicable);
            if !chosen.contains(&v) {
                chosen.push(v);
            }
        }
        chosen.sort_by_key(|v| core::cmp::Reverse(v.code(case.kind).step()));
        for v in &chosen {
            break_rule(&mut case, *v, &mut rng);
        }
        let expected = chosen.last().unwrap().code(case.kind);
        seen.insert(expected);

        let (c, outcome) = run_case(&case);
        let PromiseOrValue::Value(decision) = outcome else {
            panic!("case {i} reached the MPC: {chosen:?} {case:?}");
        };
        assert!(!decision.allowed, "case {i}");
        assert_eq!(
            decision.rule_code,
            Some(expected),
            "case {i}: {chosen:?} -> {} {case:?}",
            decision.message
        );
        assert!(
            get_created_receipts().is_empty(),
            "case {i}: promise created"
        );
        if decision.receipt_id == U64(0) {
            // A balance this low no longer covers the storage reserve: nothing stored.
            assert!(
                case.balance.is_some(),
                "case {i}: receipt 0 with the default balance"
            );
            assert_eq!(c.get_status().receipts_count, U64(0), "case {i}");
        } else {
            let receipt = c.get_receipt(decision.receipt_id).unwrap();
            assert_eq!(receipt.status, Status::Blocked, "case {i}");
            assert!(receipt.payload_hash.is_none() && receipt.signature.is_none());
        }
        assert!(c.pending_signs.get(&decision.receipt_id.0).is_none());
        let state = agent_state(&c);
        assert_eq!(
            state.orders_today, case.orders_today,
            "case {i}: no reservation"
        );
        assert_eq!(state.last_hl_nonce_ms, case.last_hl_nonce_ms.map(U64));
        assert_eq!(state.last_evm_nonce, case.last_evm_nonce.map(U64));
    }
    // Every rule code was hit as the first failure at least once.
    for code in RuleCode::ALL {
        assert!(seen.contains(&code), "{code:?} never came first");
    }
}

#[test]
fn property_valid_orders_always_reach_the_mpc() {
    let mut rng = SplitMix64(0x005E_ED0F_C1A3);
    for i in 0..1_000 {
        let case = random_valid_case(&mut rng);
        let (c, outcome) = run_case(&case);
        match outcome {
            PromiseOrValue::Promise(promise) => drop(promise),
            PromiseOrValue::Value(decision) => {
                panic!("case {i} blocked: {} {case:?}", decision.message)
            }
        }
        let receipt = c.get_receipt(U64(1)).unwrap();
        assert_eq!(receipt.status, Status::PendingSignature, "case {i}");
        let (signs, callbacks) = scheduled();
        assert_eq!((signs.len(), callbacks.len()), (1, 1), "case {i}");
        assert_eq!(
            signs[0].args["request"]["payload_v2"]["Ecdsa"],
            json!(&receipt.payload_hash.as_deref().unwrap()[2..])
        );
        assert_eq!(
            signs[0].args["request"]["path"],
            json!(receipt.derivation_path.as_deref().unwrap())
        );
        assert_eq!(agent_state(&c).orders_today, case.orders_today + 1);
    }
}
