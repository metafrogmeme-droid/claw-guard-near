//! The NEAR chain-signatures (MPC) `sign` call and its response.
//!
//! Request (verified against near/mpc `main`, 30 Oct 2026; deployed testnet value unverified):
//!
//! ```json
//! {"request":{"path":"hl-testnet-1","payload_v2":{"Ecdsa":"<64 lowercase hex>"},"domain_id":0}}
//! ```
//!
//! Response: `{"scheme":"Secp256k1","big_r":{"affine_point":"02|03 + 64 hex"},
//! "s":{"scalar":"<64 hex>"},"recovery_id":0|1}`. Parsing is lenient where deployments
//! differ (the `scheme` tag may be absent, hex may carry `0x` or upper case) and strict
//! everywhere else: anything that is not a usable secp256k1 signature is rejected, and the
//! contract records `SignFailed`.

use near_sdk::Gas;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, Value};

use crate::types::{Sig, Target};
use crate::util::{decode_hex_array, encode_hex, encode_hex_0x};

/// MPC domain 0 = secp256k1 (ECDSA).
pub const SECP256K1_DOMAIN_ID: u32 = 0;
/// Gas reserved for `on_signed` (fixed).
pub const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Gas `propose_order` keeps for itself on top of the sign and callback gas.
pub const GAS_MARGIN: Gas = Gas::from_tgas(10);
/// Largest MPC response `on_signed` reads; a real one is about 200 bytes.
pub const MAX_RESPONSE_BYTES: usize = 1024;
/// HL `v` = recovery id + 27.
const HL_V_OFFSET: u8 = 27;

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SignArgs<'a> {
    request: SignRequest<'a>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SignRequest<'a> {
    path: &'a str,
    payload_v2: PayloadV2,
    domain_id: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
enum PayloadV2 {
    /// 32-byte prehash as 64 lowercase hex digits, no `0x`.
    Ecdsa(String),
}

/// JSON arguments of `sign` for `payload_hash` on `path`.
pub fn sign_args(path: &str, payload_hash: &[u8; 32]) -> Vec<u8> {
    let args = SignArgs {
        request: SignRequest {
            path,
            payload_v2: PayloadV2::Ecdsa(encode_hex(payload_hash)),
            domain_id: SECP256K1_DOMAIN_ID,
        },
    };
    serde_json::to_vec(&args).expect("sign args serialize")
}

/// A secp256k1 signature from the MPC: `r` (x coordinate of `big_r`), `s`, recovery id 0/1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MpcSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub recovery_id: u8,
}

impl MpcSignature {
    /// Parses an MPC `sign` response; `None` if it is not a usable secp256k1 signature.
    pub fn from_response(response: &Value) -> Option<Self> {
        let object = response.as_object()?;
        if let Some(scheme) = object.get("scheme")
            && scheme.as_str() != Some("Secp256k1")
        {
            return None;
        }
        let big_r: [u8; 33] = hex_field(object.get("big_r")?, "affine_point")?;
        let s: [u8; 32] = hex_field(object.get("s")?, "scalar")?;
        let recovery_id = object.get("recovery_id")?.as_u64()?;

        let [prefix, r @ ..] = big_r;
        // 02/03: a compressed point; the x coordinate is r. Recovery ids 2/3 (x >= n) cannot be
        // expressed as an EVM y-parity or an HL v, so they are refused.
        if !matches!(prefix, 0x02 | 0x03) || recovery_id > 1 {
            return None;
        }
        if r == [0; 32] || s == [0; 32] {
            return None;
        }
        Some(Self {
            r,
            s,
            recovery_id: recovery_id as u8, // 0 or 1
        })
    }

    /// The receipt form: `v` = recovery id + 27 for HL, the y-parity for EIP-1559.
    pub fn to_sig(self, target: Target) -> Sig {
        let v = match target {
            Target::HlTestnet => self.recovery_id + HL_V_OFFSET,
            Target::BaseSepolia => self.recovery_id,
        };
        Sig {
            r: encode_hex_0x(&self.r),
            s: encode_hex_0x(&self.s),
            v,
        }
    }
}

/// `{"<key>": "<hex>"}` with exactly `N` bytes.
fn hex_field<const N: usize>(value: &Value, key: &str) -> Option<[u8; N]> {
    decode_hex_array(value.as_object()?.get(key)?.as_str()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;

    const R: &str = "9db86c1758bcc9235d0a38bac92817585d959fd8a5f867bd8d1da89ffe5a8d61";
    const S: &str = "2f466ddbac66b5f18ba942c53f493f845287493bb7e1e29928c7c854d2284938";

    fn response(scheme: Option<&str>, prefix: &str, recovery_id: u64) -> Value {
        let mut value = json!({
            "big_r": {"affine_point": format!("{prefix}{R}")},
            "s": {"scalar": S},
            "recovery_id": recovery_id,
        });
        if let Some(scheme) = scheme {
            value["scheme"] = json!(scheme);
        }
        value
    }

    #[test]
    fn request_json_shape() {
        let hash = [0xabu8; 32];
        let args: Value = serde_json::from_slice(&sign_args("hl-testnet-1", &hash)).unwrap();
        assert_eq!(
            args,
            json!({"request": {
                "path": "hl-testnet-1",
                "payload_v2": {"Ecdsa": "ab".repeat(32)},
                "domain_id": 0
            }})
        );
    }

    #[test]
    fn parses_with_and_without_scheme() {
        for scheme in [Some("Secp256k1"), None] {
            for (prefix, rid) in [("02", 0), ("03", 1)] {
                let sig = MpcSignature::from_response(&response(scheme, prefix, rid))
                    .unwrap_or_else(|| panic!("{scheme:?} {prefix}"));
                assert_eq!(encode_hex(&sig.r), R);
                assert_eq!(encode_hex(&sig.s), S);
                assert_eq!(sig.recovery_id, rid as u8);
            }
        }
    }

    #[test]
    fn accepts_0x_and_upper_case_hex() {
        let value = json!({
            "scheme": "Secp256k1",
            "big_r": {"affine_point": format!("0x03{}", R.to_uppercase())},
            "s": {"scalar": format!("0x{S}")},
            "recovery_id": 1,
        });
        let sig = MpcSignature::from_response(&value).expect("lenient hex");
        assert_eq!(encode_hex(&sig.r), R);
        assert_eq!(sig.recovery_id, 1);
    }

    #[test]
    fn rejects_anything_else() {
        let good = response(Some("Secp256k1"), "02", 0);
        let mut cases = vec![
            json!(null),
            json!("02abcd"),
            json!([1, 2, 3]),
            json!({"scheme": "Ed25519", "signature": vec![0u8; 64]}),
            response(Some("Ed25519"), "02", 0),
            response(Some("secp256k1"), "02", 0),
            response(None, "04", 0),
            response(None, "02", 2),
            response(None, "02", 3),
        ];
        // Wrong lengths, missing and mistyped fields.
        let mut short_r = good.clone();
        short_r["big_r"]["affine_point"] = json!(format!("02{}", &R[2..]));
        let mut no_prefix = good.clone();
        no_prefix["big_r"]["affine_point"] = json!(R);
        let mut long_s = good.clone();
        long_s["s"]["scalar"] = json!(format!("{S}00"));
        let mut bad_hex = good.clone();
        bad_hex["s"]["scalar"] = json!(format!("zz{}", &S[2..]));
        let mut no_rid = good.clone();
        no_rid.as_object_mut().unwrap().remove("recovery_id");
        let mut string_rid = good.clone();
        string_rid["recovery_id"] = json!("0");
        let mut flat = good.clone();
        flat["s"] = json!(S);
        let mut zero_s = good.clone();
        zero_s["s"]["scalar"] = json!("00".repeat(32));
        let mut scheme_number = good.clone();
        scheme_number["scheme"] = json!(0);
        cases.extend([
            short_r,
            no_prefix,
            long_s,
            bad_hex,
            no_rid,
            string_rid,
            flat,
            zero_s,
            scheme_number,
        ]);
        for case in cases {
            assert_eq!(MpcSignature::from_response(&case), None, "{case}");
        }
        assert!(MpcSignature::from_response(&good).is_some());
    }

    #[test]
    fn v_per_target() {
        let sig = MpcSignature::from_response(&response(None, "03", 1)).unwrap();
        let hl = sig.to_sig(Target::HlTestnet);
        assert_eq!(hl.v, 28);
        assert_eq!(hl.r, format!("0x{R}"));
        assert_eq!(hl.s, format!("0x{S}"));
        assert_eq!(sig.to_sig(Target::BaseSepolia).v, 1);
        let sig = MpcSignature::from_response(&response(None, "02", 0)).unwrap();
        assert_eq!(sig.to_sig(Target::HlTestnet).v, 27);
        assert_eq!(sig.to_sig(Target::BaseSepolia).v, 0);
    }
}
