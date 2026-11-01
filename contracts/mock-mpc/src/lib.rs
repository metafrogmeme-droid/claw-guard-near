//! SANDBOX ONLY: a stand-in for the NEAR chain-signatures MPC contract
//! (`v1.signer-prod.testnet`) so the local sandbox can run the Claw Guard flow offline.
//! Not audited.
//!
//! ```text
//! +----------------------------------------------------------------------+
//! | SANDBOX TEST KEY, WORTHLESS, NEVER USE ANYWHERE ELSE.                |
//! | Every signing key here is computed from public strings, so anyone    |
//! | can reproduce it. It signs nothing outside the local sandbox.        |
//! +----------------------------------------------------------------------+
//! ```
//!
//! `sign` takes and returns the same JSON as the real MPC contract:
//!
//! ```text
//! in : {"request":{"path":"hl-testnet-1","payload_v2":{"Ecdsa":"<64 hex>"},"domain_id":0}}
//! out: {"scheme":"Secp256k1","big_r":{"affine_point":"<02|03 + 64 hex>"},
//!       "s":{"scalar":"<64 hex>"},"recovery_id":0|1}
//! ```
//!
//! Differences from the real contract: the answer comes back in the same receipt (the real
//! one yields until the MPC network responds), and only `payload_v2` + `domain_id` 0 are
//! accepted (no legacy `payload` / `key_version` fields, no Ed25519).
//!
//! The key for a request is
//! `sk = keccak256("clawguard-sandbox-only:" ‖ predecessor ‖ "," ‖ path)`. Like the real MPC,
//! it depends on the *caller*: only the claw-guard contract itself gets signatures for the
//! claw-guard addresses. `offchain/src/derive.ts` computes the same keys
//! (`offchain/test/vectors/derive_sandbox.json`).

use k256::FieldBytes;
use k256::Scalar;
use k256::ecdsa::{SigningKey, VerifyingKey};
use k256::elliptic_curve::PrimeField;
use near_sdk::{AccountId, NearToken, PanicOnDefault, env, near, require};

/// The only account suffix the mock accepts (the local sandbox root is `test.near`).
pub const SANDBOX_ACCOUNT_SUFFIX: &str = ".test.near";
/// Domain separator of the sandbox key derivation.
pub const KEY_PREFIX: &str = "clawguard-sandbox-only:";
/// MPC domain 0 = secp256k1 (ECDSA), the only one the mock signs for.
pub const SECP256K1_DOMAIN_ID: u64 = 0;
/// Smallest deposit `sign` accepts (the real contract's `SIGN_DEPOSIT_YOCTONEAR`).
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

pub const ERR_SANDBOX_ONLY: &str = "ERR_SANDBOX_ONLY: mock-mpc runs only on a .test.near account";
pub const ERR_NOT_SELF: &str = "ERR_NOT_SELF: only the mock-mpc account itself can call set_fail";
pub const ERR_SET_TO_FAIL: &str = "ERR_MOCK_FAIL: mock-mpc sign is set to fail";
pub const ERR_DEPOSIT: &str = "ERR_DEPOSIT: sign needs an attached deposit of at least 1 yoctoNEAR";
pub const ERR_DOMAIN: &str = "ERR_DOMAIN: mock-mpc signs only domain_id 0 (secp256k1)";
pub const ERR_PAYLOAD_HEX: &str = "ERR_PAYLOAD: payload_v2.Ecdsa must be 64 hex digits without 0x";
/// Same wording as the real contract, which refuses a payload that is not a scalar (>= n).
pub const ERR_PAYLOAD_SCALAR: &str = "Ecdsa payload cannot be converted to Scalar";
pub const ERR_BAD_KEY: &str = "ERR_BAD_KEY: sandbox key is not a valid secp256k1 scalar";
/// R.x >= n (probability about 2^-128): `r` alone would not identify R, so the mock refuses.
pub const ERR_X_REDUCED: &str = "ERR_X_REDUCED: signature nonce point has x >= n";

/// `sign` argument: `{"path":…,"payload_v2":{"Ecdsa":"<64 hex>"},"domain_id":0}`.
/// Unknown fields are ignored, as in the real contract.
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// The payload to sign. JSON: `{"Ecdsa":"<64 hex>"}` (externally tagged).
#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    /// 32-byte prehash as 64 hex digits, no `0x`.
    Ecdsa(String),
}

/// `sign` result, internally tagged like the real `SignatureResponse`:
/// `{"scheme":"Secp256k1","big_r":{…},"s":{…},"recovery_id":0|1}`.
#[near(serializers = [json])]
#[serde(tag = "scheme")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureResponse {
    Secp256k1(K256Signature),
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K256Signature {
    /// The nonce point R, compressed: `02|03` ‖ x. `r` of the ECDSA signature is x.
    pub big_r: K256AffinePoint,
    pub s: K256Scalar,
    /// Parity of R.y (0 or 1). The signature is low-s normalized and R matches that.
    pub recovery_id: u8,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K256AffinePoint {
    /// 66 lowercase hex digits.
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K256Scalar {
    /// 64 lowercase hex digits.
    pub scalar: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    /// Successful `sign` calls.
    sign_count: u64,
    /// When set, `sign` panics (lets tests exercise claw-guard's `SignFailed` path).
    fail: bool,
}

#[near]
impl MockMpc {
    /// Deploy + init in one batch from the mock's own account. Panics `ERR_SANDBOX_ONLY`
    /// unless the account id ends with `.test.near`.
    #[init]
    #[private]
    pub fn new() -> Self {
        require!(
            env::current_account_id()
                .as_str()
                .ends_with(SANDBOX_ACCOUNT_SUFFIX),
            ERR_SANDBOX_ONLY
        );
        Self {
            sign_count: 0,
            fail: false,
        }
    }

    /// Signs `request.payload_v2` with the sandbox key of (caller, `request.path`) and returns
    /// the signature at once. Needs a deposit of at least 1 yoctoNEAR (kept, like the real
    /// contract's fee). Panics on a non-zero domain, a payload that is not 64 hex digits or not
    /// a scalar below the curve order, or while `set_fail(true)` is on.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> SignatureResponse {
        require!(!self.fail, ERR_SET_TO_FAIL);
        require!(env::attached_deposit() >= SIGN_DEPOSIT, ERR_DEPOSIT);
        require!(request.domain_id == SECP256K1_DOMAIN_ID, ERR_DOMAIN);
        let Payload::Ecdsa(payload_hex) = &request.payload_v2;
        let prehash = parse_payload(payload_hex);
        let key = signing_key(env::predecessor_account_id().as_str(), &request.path);
        let response = sign_prehash(&key, &prehash);
        self.sign_count += 1;
        response
    }

    /// Makes every later `sign` panic (`true`) or work again (`false`). Only the mock's own
    /// account may call it (checked in the body so unit tests cover it, too).
    pub fn set_fail(&mut self, fail: bool) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            ERR_NOT_SELF
        );
        self.fail = fail;
    }

    /// Number of successful `sign` calls.
    pub fn sign_count(&self) -> u64 {
        self.sign_count
    }

    /// Whether `sign` is currently set to fail.
    pub fn is_failing(&self) -> bool {
        self.fail
    }

    /// EVM address (`0x` + 40 lowercase hex) of the sandbox key for (`predecessor`, `path`):
    /// the address a signature from `sign` recovers to when `predecessor` called it.
    pub fn derived_address(&self, predecessor: AccountId, path: String) -> String {
        evm_address(signing_key(predecessor.as_str(), &path).verifying_key())
    }
}

/// `keccak256("clawguard-sandbox-only:" ‖ predecessor ‖ "," ‖ path)`.
pub fn secret_key_bytes(predecessor: &str, path: &str) -> [u8; 32] {
    let preimage = [KEY_PREFIX, predecessor, ",", path].concat();
    env::keccak256_array(preimage.as_bytes())
}

/// The sandbox signing key for (`predecessor`, `path`). Panics `ERR_BAD_KEY` if the hash is
/// zero or not below the curve order (practically never).
pub fn signing_key(predecessor: &str, path: &str) -> SigningKey {
    let secret = FieldBytes::from(secret_key_bytes(predecessor, path));
    SigningKey::from_bytes(&secret).unwrap_or_else(|_| env::panic_str(ERR_BAD_KEY))
}

/// `0x` + last 20 bytes of `keccak256(x ‖ y)`, lowercase.
pub fn evm_address(key: &VerifyingKey) -> String {
    let point = key.to_sec1_point(false);
    // Uncompressed SEC1: 0x04 ‖ x (32) ‖ y (32).
    let hash = env::keccak256_array(&point.as_bytes()[1..]);
    format!("0x{}", encode_hex(&hash[12..]))
}

/// Decodes the 64-hex-digit prehash and checks that it is a secp256k1 scalar (< n), the same
/// check the real contract makes before it queues a request.
pub fn parse_payload(payload_hex: &str) -> [u8; 32] {
    let prehash = decode_hex32(payload_hex).unwrap_or_else(|| env::panic_str(ERR_PAYLOAD_HEX));
    let is_scalar = Scalar::from_repr(FieldBytes::from(prehash))
        .into_option()
        .is_some();
    require!(is_scalar, ERR_PAYLOAD_SCALAR);
    prehash
}

/// RFC6979 deterministic, low-s ECDSA over the prehash, in the MPC response shape.
pub fn sign_prehash(key: &SigningKey, prehash: &[u8; 32]) -> SignatureResponse {
    let (signature, recovery_id) = key.sign_prehash_recoverable(prehash);
    require!(!recovery_id.is_x_reduced(), ERR_X_REDUCED);
    let (r, s) = signature.split_bytes();
    let y_is_odd = recovery_id.is_y_odd();
    let mut big_r = [0u8; 33];
    big_r[0] = if y_is_odd { 0x03 } else { 0x02 };
    big_r[1..].copy_from_slice(&r);
    SignatureResponse::Secp256k1(K256Signature {
        big_r: K256AffinePoint {
            affine_point: encode_hex(&big_r),
        },
        s: K256Scalar {
            scalar: encode_hex(&s),
        },
        recovery_id: u8::from(y_is_odd),
    })
}

/// Lowercase hex, no prefix.
fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// Exactly 64 hex digits (either case, no `0x`) into 32 bytes.
fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    fn nibble(digit: u8) -> Option<u8> {
        match digit {
            b'0'..=b'9' => Some(digit - b'0'),
            b'a'..=b'f' => Some(digit - b'a' + 10),
            b'A'..=b'F' => Some(digit - b'A' + 10),
            _ => None,
        }
    }
    let digits = hex.as_bytes();
    if digits.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (byte, pair) in out.iter_mut().zip(digits.chunks_exact(2)) {
        *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

#[cfg(test)]
mod tests;
