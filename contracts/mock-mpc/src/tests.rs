//! Unit tests for the sandbox-only mock MPC. Sandbox test key, worthless, never
//! use anywhere else.

use std::panic::{AssertUnwindSafe, catch_unwind};

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey, signature::hazmat::PrehashVerifier};
use near_sdk::serde_json::{self, json};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, NearToken, testing_env};

use super::*;

const MOCK: &str = "mock-mpc.test.near";
const CLAWGUARD: &str = "clawguard.test.near";
const AGENT: &str = "agent-1.test.near";
const HL_PATH: &str = "hl-testnet-1";
const BASE_PATH: &str = "base-sepolia-1";
/// secp256k1 group order n, big-endian.
const ORDER_HEX: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
const ORDER_MINUS_ONE_HEX: &str =
    "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140";

fn account(id: &str) -> AccountId {
    id.parse().unwrap()
}

/// Sets the VM context: the mock at `MOCK`, called by `caller` with `deposit_yocto`.
fn context(caller: &str, deposit_yocto: u128) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(account(MOCK))
            .predecessor_account_id(account(caller))
            .signer_account_id(account(caller))
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .build()
    );
}

fn deployed() -> MockMpc {
    context(MOCK, 0);
    MockMpc::new()
}

fn request(path: &str, payload_hex: &str) -> SignRequest {
    SignRequest {
        path: path.to_owned(),
        payload_v2: Payload::Ecdsa(payload_hex.to_owned()),
        domain_id: SECP256K1_DOMAIN_ID,
    }
}

/// The panic message of `f`, or `None` if it returned normally.
fn panic_message(f: impl FnOnce()) -> Option<String> {
    let err = catch_unwind(AssertUnwindSafe(f)).err()?;
    Some(
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default(),
    )
}

fn assert_panics_with(expected: &str, f: impl FnOnce()) {
    match panic_message(f) {
        Some(message) => assert!(
            message.contains(expected),
            "expected panic {expected:?}, got {message:?}"
        ),
        None => panic!("expected panic {expected:?}, but the call returned"),
    }
}

fn decode(hex: &str) -> Vec<u8> {
    assert!(hex.len().is_multiple_of(2), "{hex}");
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// Recovers the signer of `prehash` from a `sign` response, the way claw-guard and the
/// off-chain verifier read it: r = big_r x coordinate, s, recovery id = y-parity.
fn recover(prehash: &[u8; 32], response: &SignatureResponse) -> VerifyingKey {
    let SignatureResponse::Secp256k1(sig) = response;
    let big_r = decode(&sig.big_r.affine_point);
    let r: [u8; 32] = big_r[1..].try_into().unwrap();
    let s: [u8; 32] = decode(&sig.s.scalar).try_into().unwrap();
    let signature = Signature::from_scalars(r, s).expect("r and s are scalars");
    let recovery_id = RecoveryId::from_byte(sig.recovery_id).unwrap();
    let key = VerifyingKey::recover_from_prehash(prehash, &signature, recovery_id).unwrap();
    key.verify_prehash(prehash, &signature)
        .expect("signature verifies under the recovered key");
    key
}

fn payloads() -> Vec<[u8; 32]> {
    let mut out = vec![[0u8; 32], [0x07; 32], [0xab; 32]];
    out.push(decode(ORDER_MINUS_ONE_HEX).try_into().unwrap());
    // Base Sepolia payload hash of "usdc_1_to_owner" (offchain/test/vectors/evm_transfers.json).
    out.push(
        decode("999b250800be67f6cab948a61c64a24863f18173316f885c61e8ba4cd6f1c392")
            .try_into()
            .unwrap(),
    );
    for seed in 0u8..16 {
        out.push(env::keccak256_array([seed]));
    }
    out
}

#[test]
fn derived_addresses_match_offchain_vectors() {
    // offchain/test/vectors/derive_sandbox.json (viem 2.57.7 privateKeyToAccount).
    let vectors = [
        (
            CLAWGUARD,
            HL_PATH,
            "0xb966992b0783f42b2f78a7a94c8f190f03758a96",
        ),
        (
            CLAWGUARD,
            BASE_PATH,
            "0x208293469e00a4e3775e131195b9a2e876202f60",
        ),
        (AGENT, HL_PATH, "0x6107927f45a1beed2ee29877f9f6f1d8861ae30c"),
        (
            "owner.test.near",
            HL_PATH,
            "0x371ec5c92e20d361d01c49aec2c1dba120a305d6",
        ),
    ];
    let contract = deployed();
    for (predecessor, path, address) in vectors {
        assert_eq!(
            contract.derived_address(account(predecessor), path.to_owned()),
            address,
            "{predecessor} {path}"
        );
    }
}

#[test]
fn key_depends_on_caller_and_path() {
    let contract = deployed();
    let address = |predecessor: &str, path: &str| {
        contract.derived_address(account(predecessor), path.to_owned())
    };
    assert_ne!(address(CLAWGUARD, HL_PATH), address(AGENT, HL_PATH));
    assert_ne!(address(CLAWGUARD, HL_PATH), address(CLAWGUARD, BASE_PATH));
    // The separator keeps (predecessor, path) unambiguous.
    assert_eq!(
        secret_key_bytes(CLAWGUARD, HL_PATH),
        env::keccak256_array(b"clawguard-sandbox-only:clawguard.test.near,hl-testnet-1")
    );
}

#[test]
fn sign_recovers_to_derived_address() {
    let mut contract = deployed();
    for path in [HL_PATH, BASE_PATH] {
        let expected = contract.derived_address(account(CLAWGUARD), path.to_owned());
        for prehash in payloads() {
            context(CLAWGUARD, 1);
            let response = contract.sign(request(path, &encode_hex(&prehash)));
            assert_eq!(evm_address(&recover(&prehash, &response)), expected);
        }
    }
    // The caller, not the path alone, picks the key.
    let prehash = [0x42; 32];
    context(AGENT, 1);
    let response = contract.sign(request(HL_PATH, &encode_hex(&prehash)));
    assert_eq!(
        evm_address(&recover(&prehash, &response)),
        contract.derived_address(account(AGENT), HL_PATH.to_owned())
    );
}

#[test]
fn response_json_has_the_mpc_shape() {
    let mut contract = deployed();
    for prehash in payloads() {
        context(CLAWGUARD, 1);
        let response = contract.sign(request(HL_PATH, &encode_hex(&prehash)));
        let value = serde_json::to_value(&response).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["big_r", "recovery_id", "s", "scheme"], "{value}");
        assert_eq!(value["scheme"], "Secp256k1");

        let big_r = value["big_r"]["affine_point"].as_str().unwrap();
        let scalar = value["s"]["scalar"].as_str().unwrap();
        let recovery_id = value["recovery_id"].as_u64().unwrap();
        let lower_hex = |s: &str| s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        assert_eq!(big_r.len(), 66, "{big_r}");
        assert_eq!(scalar.len(), 64, "{scalar}");
        assert!(lower_hex(big_r) && lower_hex(scalar), "{value}");
        // The prefix byte is R's y-parity, and recovery_id says the same.
        let expected_prefix = if recovery_id == 1 { "03" } else { "02" };
        assert!(recovery_id <= 1);
        assert_eq!(&big_r[..2], expected_prefix, "{value}");

        // Round trip through the JSON the claw-guard callback receives.
        let parsed: SignatureResponse = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, response);
    }
}

#[test]
fn signatures_are_low_s_and_deterministic() {
    let mut contract = deployed();
    let half_order = {
        // floor(n / 2), big-endian.
        let n = decode(ORDER_HEX);
        let mut half = vec![0u8; 32];
        let mut carry = 0u8;
        for (out, byte) in half.iter_mut().zip(n) {
            *out = (carry << 7) | (byte >> 1);
            carry = byte & 1;
        }
        half
    };
    for prehash in payloads() {
        context(CLAWGUARD, 1);
        let first = contract.sign(request(BASE_PATH, &encode_hex(&prehash)));
        context(CLAWGUARD, 1);
        let second = contract.sign(request(BASE_PATH, &encode_hex(&prehash)));
        assert_eq!(first, second, "RFC6979 nonces are deterministic");
        let SignatureResponse::Secp256k1(sig) = first;
        assert!(
            decode(&sig.s.scalar) <= half_order,
            "s must be low: {}",
            sig.s.scalar
        );
    }
}

#[test]
fn request_json_from_claw_guard_parses() {
    // Exactly what claw-guard sends (contracts/claw-guard/src/mpc.rs), plus an unknown field.
    let args = json!({"request": {
        "path": HL_PATH,
        "payload_v2": {"Ecdsa": "ab".repeat(32)},
        "domain_id": 0,
        "future_field": true
    }});
    let parsed: SignRequest = serde_json::from_value(args["request"].clone()).unwrap();
    assert_eq!(parsed, request(HL_PATH, &"ab".repeat(32)));
    // Anything but an Ecdsa payload does not parse.
    let eddsa = json!({"path": HL_PATH, "payload_v2": {"Eddsa": "ab"}, "domain_id": 1});
    assert!(serde_json::from_value::<SignRequest>(eddsa).is_err());
    let legacy = json!({"path": HL_PATH, "payload": vec![0u8; 32], "key_version": 0});
    assert!(serde_json::from_value::<SignRequest>(legacy).is_err());
}

#[test]
fn payload_at_or_above_curve_order_is_refused() {
    let mut contract = deployed();
    let not_scalars = [
        ORDER_HEX.to_owned(),
        "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142".to_owned(),
        "ff".repeat(32),
    ];
    for payload in not_scalars {
        context(CLAWGUARD, 1);
        assert_panics_with(ERR_PAYLOAD_SCALAR, || {
            contract.sign(request(HL_PATH, &payload));
        });
    }
    assert_eq!(contract.sign_count(), 0);
    // n - 1 is the largest scalar and is signed.
    context(CLAWGUARD, 1);
    contract.sign(request(HL_PATH, ORDER_MINUS_ONE_HEX));
    assert_eq!(contract.sign_count(), 1);
}

#[test]
fn malformed_payload_hex_is_refused() {
    let mut contract = deployed();
    let bad = [
        format!("0x{}", "ab".repeat(31)),
        format!("0x{}", "ab".repeat(32)),
        "ab".repeat(31),
        "ab".repeat(33),
        format!("zz{}", "ab".repeat(31)),
        format!("{} ", "ab".repeat(31)),
        String::new(),
    ];
    for payload in bad {
        context(CLAWGUARD, 1);
        assert_panics_with(ERR_PAYLOAD_HEX, || {
            contract.sign(request(HL_PATH, &payload));
        });
    }
    // Upper case is fine (the real contract decodes hex case-insensitively).
    context(CLAWGUARD, 1);
    contract.sign(request(HL_PATH, &"AB".repeat(32)));
    assert_eq!(contract.sign_count(), 1);
}

#[test]
fn sign_needs_a_deposit_and_domain_zero() {
    let mut contract = deployed();
    context(CLAWGUARD, 0);
    assert_panics_with(ERR_DEPOSIT, || {
        contract.sign(request(HL_PATH, &"07".repeat(32)));
    });
    context(CLAWGUARD, 1);
    let mut ed25519 = request(HL_PATH, &"07".repeat(32));
    ed25519.domain_id = 1;
    assert_panics_with(ERR_DOMAIN, || {
        contract.sign(ed25519);
    });
    assert_eq!(contract.sign_count(), 0);
    // More than 1 yocto is accepted (older deployments asked for more).
    context(CLAWGUARD, 10u128.pow(23));
    contract.sign(request(HL_PATH, &"07".repeat(32)));
    assert_eq!(contract.sign_count(), 1);
}

#[test]
fn set_fail_only_by_the_mock_itself() {
    let mut contract = deployed();
    for stranger in [CLAWGUARD, AGENT, "owner.test.near", "test.near"] {
        context(stranger, 0);
        assert_panics_with(ERR_NOT_SELF, || contract.set_fail(true));
        assert!(!contract.is_failing());
    }

    context(MOCK, 0);
    contract.set_fail(true);
    assert!(contract.is_failing());
    context(CLAWGUARD, 1);
    assert_panics_with(ERR_SET_TO_FAIL, || {
        contract.sign(request(HL_PATH, &"07".repeat(32)));
    });
    assert_eq!(contract.sign_count(), 0);

    // A stranger cannot switch it back either.
    context(CLAWGUARD, 0);
    assert_panics_with(ERR_NOT_SELF, || contract.set_fail(false));
    assert!(contract.is_failing());

    context(MOCK, 0);
    contract.set_fail(false);
    context(CLAWGUARD, 1);
    contract.sign(request(HL_PATH, &"07".repeat(32)));
    assert_eq!(contract.sign_count(), 1);
}

#[test]
fn sign_count_counts_successful_signs_only() {
    let mut contract = deployed();
    assert_eq!(contract.sign_count(), 0);
    for (i, prehash) in payloads().iter().enumerate() {
        context(CLAWGUARD, 1);
        contract.sign(request(HL_PATH, &encode_hex(prehash)));
        assert_eq!(contract.sign_count(), i as u64 + 1);
    }
    let before = contract.sign_count();
    context(CLAWGUARD, 0);
    assert!(
        panic_message(|| {
            contract.sign(request(HL_PATH, &"07".repeat(32)));
        })
        .is_some()
    );
    assert_eq!(contract.sign_count(), before);
}

#[test]
fn init_refuses_non_sandbox_accounts() {
    for id in [
        "mock-mpc.testnet",
        "v1.signer-prod.testnet",
        "v1.signer",
        "mock-mpc.near",
        "test.near",
        "mock-mpc.test.near.evil.testnet",
    ] {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(account(id))
                .predecessor_account_id(account(id))
                .build()
        );
        assert_panics_with(ERR_SANDBOX_ONLY, || {
            MockMpc::new();
        });
    }
    let contract = deployed();
    assert_eq!(contract.sign_count(), 0);
    assert!(!contract.is_failing());
}

#[test]
fn hex_helpers_round_trip() {
    let bytes: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(37));
    let hex = encode_hex(&bytes);
    assert_eq!(hex.len(), 64);
    assert_eq!(decode_hex32(&hex), Some(bytes));
    assert_eq!(decode_hex32(&hex.to_uppercase()), Some(bytes));
    assert_eq!(decode(&hex), bytes);
    assert_eq!(decode_hex32(&hex[..62]), None);
}

#[test]
fn derived_address_format() {
    let contract = deployed();
    let address = contract.derived_address(account(CLAWGUARD), HL_PATH.to_owned());
    assert_eq!(address.len(), 42);
    assert!(address.starts_with("0x"));
    assert!(
        address[2..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    );
}
