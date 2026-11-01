//! Canonical Hyperliquid L1 actions and their signing digest (testnet only).
//!
//! The contract builds the action itself from checked fields, then derives everything from one
//! value tree so the JSON it stores and the bytes it hashes cannot drift apart:
//!
//! * `action_json`: the action as compact JSON (key order of the SDK, no spaces), identical to
//!   `json.dumps(action, separators=(",", ":"))`. The relayer posts it as `action`.
//! * `action_msgpack`: `msgpack.packb(action)`.
//! * `connection_id = keccak256(action_msgpack ‖ nonce_ms as u64 BE ‖ 0x00)`: no vault address
//!   (`0x00`) and no `expiresAfter`, as in the SDK's `action_hash` with both unset.
//! * `digest`: the EIP-712 phantom-agent digest with testnet source `"b"` ([`eip712::l1_digest`]).
//!
//! Shapes match hyperliquid-python-sdk 0.24.0 `order_wires_to_order_action` and
//! `update_leverage`; they are checked against the vectors in `offchain/test/vectors/`.

use core::num::NonZeroU8;

use near_sdk::env;

use crate::eip712;
use crate::msgpack::{self, Value};
use crate::order::{CheckedHlOrder, Field, Malformed};
use crate::util::push_hex;

/// The `0x00` byte that `action_hash` appends when there is no vault address.
const NO_VAULT_ADDRESS: u8 = 0x00;

/// Everything needed to request and record a signature for one HL action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlPayload {
    /// Canonical action JSON; stored as the receipt's `signed_body`.
    pub action_json: String,
    /// msgpack encoding of the action.
    pub action_msgpack: Vec<u8>,
    /// `keccak256(action_msgpack ‖ nonce ‖ 0x00)`.
    pub connection_id: [u8; 32],
    /// EIP-712 digest that the MPC signs; the receipt's `payload_hash`.
    pub digest: [u8; 32],
}

/// One HL limit order: the owner-set asset index plus the agent's checked fields.
#[derive(Debug, Clone, Copy)]
pub struct LimitOrder<'a> {
    /// HL asset index from the owner's market rule (never taken from the agent).
    pub asset: u32,
    pub is_buy: bool,
    pub reduce_only: bool,
    /// Price, size and tif after [`crate::order::check_hl_order`].
    pub checked: &'a CheckedHlOrder,
}

/// Builds `{"type":"order","orders":[{"a","b","p","s","r","t":{"limit":{"tif"}}}],"grouping":"na"}`
/// for a single limit order, and its testnet digest for `nonce_ms`.
pub fn build_order(order: &LimitOrder<'_>, nonce_ms: u64) -> Result<HlPayload, Malformed> {
    let checked = order.checked;
    let wire = Value::Map(vec![
        ("a", Value::UInt(u64::from(order.asset))),
        ("b", Value::Bool(order.is_buy)),
        ("p", Value::Str(checked.limit_px().as_str())),
        ("s", Value::Str(checked.sz().as_str())),
        ("r", Value::Bool(order.reduce_only)),
        (
            "t",
            Value::Map(vec![(
                "limit",
                Value::Map(vec![("tif", Value::Str(checked.tif().as_str()))]),
            )]),
        ),
    ]);
    let action = Value::Map(vec![
        ("type", Value::Str("order")),
        ("orders", Value::Array(vec![wire])),
        ("grouping", Value::Str("na")),
    ]);
    payload(&action, nonce_ms)
}

/// Builds `{"type":"updateLeverage","asset","isCross","leverage"}` and its testnet digest.
/// `leverage` comes from [`crate::order::check_leverage`] (never 0).
pub fn build_update_leverage(
    asset: u32,
    is_cross: bool,
    leverage: NonZeroU8,
    nonce_ms: u64,
) -> Result<HlPayload, Malformed> {
    let action = Value::Map(vec![
        ("type", Value::Str("updateLeverage")),
        ("asset", Value::UInt(u64::from(asset))),
        ("isCross", Value::Bool(is_cross)),
        ("leverage", Value::UInt(u64::from(leverage.get()))),
    ]);
    payload(&action, nonce_ms)
}

/// `keccak256(action_msgpack ‖ nonce_ms (8 bytes BE) ‖ 0x00)`: SDK `action_hash` with no vault
/// address and no `expiresAfter`.
pub fn connection_id(action_msgpack: &[u8], nonce_ms: u64) -> [u8; 32] {
    let mut data = Vec::with_capacity(action_msgpack.len() + 9);
    data.extend_from_slice(action_msgpack);
    data.extend_from_slice(&nonce_ms.to_be_bytes());
    data.push(NO_VAULT_ADDRESS);
    env::keccak256_array(&data)
}

fn payload(action: &Value<'_>, nonce_ms: u64) -> Result<HlPayload, Malformed> {
    // Unreachable for the bounded actions above; refused rather than encoded differently.
    let action_msgpack = msgpack::encode(action).map_err(|_| Malformed(Field::Order))?;
    let mut action_json = String::new();
    write_json(&mut action_json, action);
    let connection_id = connection_id(&action_msgpack, nonce_ms);
    let digest = eip712::l1_digest(&connection_id);
    Ok(HlPayload {
        action_json,
        action_msgpack,
        connection_id,
        digest,
    })
}

/// Compact JSON (no whitespace), keys in tree order.
fn write_json(out: &mut String, value: &Value<'_>) {
    match value {
        Value::Nil => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::UInt(n) => out.push_str(&n.to_string()),
        Value::Str(s) => write_json_str(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Map(entries) => {
            out.push('{');
            for (i, (key, item)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_str(out, key);
                out.push(':');
                write_json(out, item);
            }
            out.push('}');
        }
    }
}

/// JSON string with RFC 8259 escaping (`"`, `\` and control characters), so that parsing the
/// JSON always gives back exactly the hashed string. Action strings are checked decimals and
/// constants, so in practice nothing needs escaping.
fn write_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0}'..='\u{1f}' => {
                out.push_str("\\u00");
                push_hex(out, &[c as u8]); // c <= 0x1f, fits in one byte
            }
            _ => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::order::{check_hl_order, check_leverage};
    use crate::util::testing::{recover_evm_address, word};
    use crate::util::{encode_hex, encode_hex_0x};
    use serde_json::Value as Json;

    const ORDER_VECTORS: &str = include_str!("../../../offchain/test/vectors/hl_orders.json");
    const LEVERAGE_VECTORS: &str =
        include_str!("../../../offchain/test/vectors/hl_update_leverage.json");

    fn vectors(json: &str) -> Vec<Json> {
        let doc: Json = serde_json::from_str(json).expect("vector file is JSON");
        assert_eq!(doc["meta"]["is_mainnet"], Json::Bool(false));
        doc["vectors"].as_array().expect("vectors array").clone()
    }

    fn str_of<'a>(v: &'a Json, key: &str) -> &'a str {
        v[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} is a string"))
    }

    fn bool_of(v: &Json, key: &str) -> bool {
        v[key]
            .as_bool()
            .unwrap_or_else(|| panic!("{key} is a bool"))
    }

    fn asset_of(request: &Json) -> u32 {
        let asset = request["coin_asset"].as_u64().expect("coin_asset");
        u32::try_from(asset).expect("asset fits u32")
    }

    /// Compares one payload with its vector, then checks that the vector's reference signature
    /// (made by the SDK over its own digest) recovers to the vector signer from *our* digest.
    fn assert_matches_vector(v: &Json, payload: &HlPayload) {
        let name = str_of(v, "name");
        assert_eq!(str_of(v, "source"), "b", "{name}: testnet source");
        assert_eq!(
            payload.action_json,
            str_of(v, "action_json"),
            "{name}: action_json"
        );
        assert_eq!(
            encode_hex(&payload.action_msgpack),
            str_of(v, "msgpack_hex"),
            "{name}: msgpack"
        );
        assert_eq!(
            encode_hex_0x(&payload.connection_id),
            str_of(v, "connection_id"),
            "{name}: connection_id"
        );
        assert_eq!(
            encode_hex_0x(&payload.digest),
            str_of(v, "digest"),
            "{name}: digest"
        );

        // The vector's structured `action` parses to the same JSON as ours.
        let ours: Json = serde_json::from_str(&payload.action_json).expect("our JSON parses");
        assert_eq!(ours, v["action"], "{name}: action object");

        let sig = &v["signature"];
        let hl_v = u8::try_from(sig["v"].as_u64().expect("v")).expect("v fits u8");
        assert!(hl_v == 27 || hl_v == 28, "{name}: HL v is 27/28");
        let signer = recover_evm_address(
            &payload.digest,
            &word(str_of(sig, "r")),
            &word(str_of(sig, "s")),
            hl_v - 27,
        );
        assert_eq!(signer, str_of(v, "signer"), "{name}: signature recovers");
    }

    #[test]
    fn order_vectors_match_sdk() {
        let vectors = vectors(ORDER_VECTORS);
        assert_eq!(vectors.len(), 10);
        for v in &vectors {
            let request = &v["request"];
            // Format checks only: the encoder must match the SDK for every vector, including
            // sizes finer than any market's `sz_decimals` (those are refused by the rules).
            let checked = check_hl_order(
                str_of(request, "limit_px"),
                str_of(request, "sz"),
                str_of(request, "tif"),
                None,
            )
            .unwrap_or_else(|e| panic!("{}: rejected {e}", str_of(v, "name")));
            let order = LimitOrder {
                asset: asset_of(request),
                is_buy: bool_of(request, "is_buy"),
                reduce_only: bool_of(request, "reduce_only"),
                checked: &checked,
            };
            let nonce_ms = v["nonce_ms"].as_u64().expect("nonce_ms fits u64");
            let payload = build_order(&order, nonce_ms).expect("encodable");
            assert_matches_vector(v, &payload);
        }
    }

    #[test]
    fn update_leverage_vectors_match_sdk() {
        let vectors = vectors(LEVERAGE_VECTORS);
        assert_eq!(vectors.len(), 4);
        for v in &vectors {
            let request = &v["request"];
            let leverage = u8::try_from(request["leverage"].as_u64().expect("leverage"))
                .expect("leverage fits u8");
            let payload = build_update_leverage(
                asset_of(request),
                bool_of(request, "is_cross"),
                check_leverage(leverage).expect("non-zero"),
                v["nonce_ms"].as_u64().expect("nonce_ms"),
            )
            .expect("encodable");
            assert_matches_vector(v, &payload);
        }
    }

    #[test]
    fn every_field_changes_the_digest() {
        let base_fields = check_hl_order("1000", "0.001", "Gtc", None).unwrap();
        let base = LimitOrder {
            asset: 3,
            is_buy: true,
            reduce_only: false,
            checked: &base_fields,
        };
        let nonce = 1_793_318_400_000;
        let reference = build_order(&base, nonce).unwrap().digest;

        let other_px = check_hl_order("1001", "0.001", "Gtc", None).unwrap();
        let other_sz = check_hl_order("1000", "0.002", "Gtc", None).unwrap();
        let other_tif = check_hl_order("1000", "0.001", "Ioc", None).unwrap();
        let variants = [
            LimitOrder { asset: 4, ..base },
            LimitOrder {
                is_buy: false,
                ..base
            },
            LimitOrder {
                reduce_only: true,
                ..base
            },
            LimitOrder {
                checked: &other_px,
                ..base
            },
            LimitOrder {
                checked: &other_sz,
                ..base
            },
            LimitOrder {
                checked: &other_tif,
                ..base
            },
        ];
        for variant in &variants {
            assert_ne!(build_order(variant, nonce).unwrap().digest, reference);
        }
        assert_ne!(build_order(&base, nonce + 1).unwrap().digest, reference);
    }

    #[test]
    fn connection_id_layout() {
        // keccak256(msgpack ‖ nonce BE ‖ 0x00), checked against a direct hash.
        let msgpack = [0x80u8];
        let mut data = vec![0x80u8];
        data.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0x01, 0x02]);
        data.push(0x00);
        assert_eq!(connection_id(&msgpack, 0x0102), env::keccak256_array(&data));
    }

    #[test]
    fn json_strings_are_escaped() {
        let mut out = String::new();
        write_json_str(&mut out, "a\"b\\c\n\u{1}é");
        assert_eq!(out, r#""a\"b\\c\u000a\u0001é""#);
        let parsed: String = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed, "a\"b\\c\n\u{1}é");
    }

    #[test]
    fn json_writer_covers_all_kinds() {
        let value = Value::Map(vec![
            ("n", Value::Nil),
            ("t", Value::Bool(true)),
            ("u", Value::UInt(u64::MAX)),
            ("a", Value::Array(vec![Value::Bool(false), Value::Str("x")])),
            ("e", Value::Map(vec![])),
        ]);
        let mut out = String::new();
        write_json(&mut out, &value);
        assert_eq!(
            out,
            r#"{"n":null,"t":true,"u":18446744073709551615,"a":[false,"x"],"e":{}}"#
        );
    }
}
