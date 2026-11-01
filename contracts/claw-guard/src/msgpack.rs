//! Minimal MessagePack encoder for Hyperliquid L1 actions.
//!
//! Hyperliquid hashes `msgpack.packb(action)` (Python `msgpack` >= 1.0 defaults), so the bytes
//! must match that encoder exactly. This module covers only the value kinds HL actions use and
//! always picks the smallest representation, as Python does:
//!
//! | kind          | encodings                                              |
//! |---------------|--------------------------------------------------------|
//! | nil, bool     | `c0`, `c2` / `c3`                                       |
//! | unsigned int  | positive fixint, uint8 `cc`, uint16 `cd`, uint32 `ce`, uint64 `cf` |
//! | str (UTF-8)   | fixstr `a0..bf`, str8 `d9`, str16 `da`                  |
//! | array         | fixarray `90..9f`, array16 `dc`                         |
//! | map           | fixmap `80..8f`, map16 `de`                             |
//!
//! Anything longer than the 16-bit forms allow is refused with [`MsgpackError::TooLong`] rather
//! than encoded some other way (fail closed). Map entries keep their insertion order: the wire
//! order is part of what gets hashed.

use core::fmt;

const NIL: u8 = 0xc0;
const FALSE: u8 = 0xc2;
const TRUE: u8 = 0xc3;
const POSITIVE_FIXINT_MAX: u8 = 0x7f;
const UINT8: u8 = 0xcc;
const UINT16: u8 = 0xcd;
const UINT32: u8 = 0xce;
const UINT64: u8 = 0xcf;
const FIXSTR: u8 = 0xa0;
const FIXSTR_MAX_LEN: usize = 31;
const STR8: u8 = 0xd9;
const STR16: u8 = 0xda;
const FIXARRAY: u8 = 0x90;
const ARRAY16: u8 = 0xdc;
const FIXMAP: u8 = 0x80;
const MAP16: u8 = 0xde;
/// Largest element count of a fixarray / fixmap.
const FIX_CONTAINER_MAX_LEN: usize = 15;

/// Largest string byte length or container element count this encoder accepts.
pub const MAX_LEN: usize = u16::MAX as usize;

/// A value tree in exactly the shape (and key order) that gets encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value<'a> {
    Nil,
    Bool(bool),
    UInt(u64),
    Str(&'a str),
    Array(Vec<Value<'a>>),
    /// String-keyed map; entries are encoded in this order.
    Map(Vec<(&'a str, Value<'a>)>),
}

/// The value cannot be encoded by this minimal encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgpackError {
    /// A string, array or map is longer than [`MAX_LEN`].
    TooLong { len: usize },
}

impl fmt::Display for MsgpackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong { len } => write!(f, "length {len} exceeds {MAX_LEN}"),
        }
    }
}

/// Encodes `value` byte-identically to Python `msgpack.packb`.
pub fn encode(value: &Value<'_>) -> Result<Vec<u8>, MsgpackError> {
    let mut out = Vec::new();
    write_value(&mut out, value)?;
    Ok(out)
}

fn write_value(out: &mut Vec<u8>, value: &Value<'_>) -> Result<(), MsgpackError> {
    match value {
        Value::Nil => out.push(NIL),
        Value::Bool(b) => out.push(if *b { TRUE } else { FALSE }),
        Value::UInt(n) => write_uint(out, *n),
        Value::Str(s) => write_str(out, s)?,
        Value::Array(items) => {
            write_container_header(out, items.len(), FIXARRAY, ARRAY16)?;
            for item in items {
                write_value(out, item)?;
            }
        }
        Value::Map(entries) => {
            write_container_header(out, entries.len(), FIXMAP, MAP16)?;
            for (key, item) in entries {
                write_str(out, key)?;
                write_value(out, item)?;
            }
        }
    }
    Ok(())
}

fn write_uint(out: &mut Vec<u8>, n: u64) {
    if let Ok(v) = u8::try_from(n) {
        if v <= POSITIVE_FIXINT_MAX {
            out.push(v);
        } else {
            out.extend_from_slice(&[UINT8, v]);
        }
    } else if let Ok(v) = u16::try_from(n) {
        out.push(UINT16);
        out.extend_from_slice(&v.to_be_bytes());
    } else if let Ok(v) = u32::try_from(n) {
        out.push(UINT32);
        out.extend_from_slice(&v.to_be_bytes());
    } else {
        out.push(UINT64);
        out.extend_from_slice(&n.to_be_bytes());
    }
}

fn write_str(out: &mut Vec<u8>, s: &str) -> Result<(), MsgpackError> {
    let bytes = s.as_bytes();
    let len = bytes.len();
    if len <= FIXSTR_MAX_LEN {
        out.push(FIXSTR | len as u8); // len <= 31: fits the 5-bit length field
    } else if let Ok(len8) = u8::try_from(len) {
        out.extend_from_slice(&[STR8, len8]);
    } else if let Ok(len16) = u16::try_from(len) {
        out.push(STR16);
        out.extend_from_slice(&len16.to_be_bytes());
    } else {
        return Err(MsgpackError::TooLong { len });
    }
    out.extend_from_slice(bytes);
    Ok(())
}

fn write_container_header(
    out: &mut Vec<u8>,
    len: usize,
    fix_marker: u8,
    marker16: u8,
) -> Result<(), MsgpackError> {
    if len <= FIX_CONTAINER_MAX_LEN {
        out.push(fix_marker | len as u8); // len <= 15: fits the 4-bit length field
    } else if let Ok(len16) = u16::try_from(len) {
        out.push(marker16);
        out.extend_from_slice(&len16.to_be_bytes());
    } else {
        return Err(MsgpackError::TooLong { len });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::encode_hex;

    fn hex_of(value: &Value<'_>) -> String {
        encode_hex(&encode(value).expect("encodable"))
    }

    // Expected bytes below were produced with Python msgpack 1.2.4 `msgpack.packb`.

    #[test]
    fn scalars() {
        assert_eq!(hex_of(&Value::Nil), "c0");
        assert_eq!(hex_of(&Value::Bool(true)), "c3");
        assert_eq!(hex_of(&Value::Bool(false)), "c2");
    }

    #[test]
    fn unsigned_ints_use_smallest_form() {
        let cases: &[(u64, &str)] = &[
            (0, "00"),
            (127, "7f"),
            (128, "cc80"),
            (255, "ccff"),
            (256, "cd0100"),
            (65_535, "cdffff"),
            (65_536, "ce00010000"),
            (u64::from(u32::MAX), "ceffffffff"),
            (u64::from(u32::MAX) + 1, "cf0000000100000000"),
            (u64::MAX, "cfffffffffffffffff"),
        ];
        for &(n, expected) in cases {
            assert_eq!(hex_of(&Value::UInt(n)), expected, "uint {n}");
        }
    }

    #[test]
    fn strings_use_fixstr_str8_str16() {
        assert_eq!(hex_of(&Value::Str("")), "a0");
        let s31 = "a".repeat(31);
        assert_eq!(hex_of(&Value::Str(&s31)), format!("bf{}", "61".repeat(31)));
        let s32 = "a".repeat(32);
        assert_eq!(
            hex_of(&Value::Str(&s32)),
            format!("d920{}", "61".repeat(32))
        );
        let s255 = "a".repeat(255);
        assert_eq!(
            hex_of(&Value::Str(&s255)),
            format!("d9ff{}", "61".repeat(255))
        );
        let s256 = "a".repeat(256);
        assert_eq!(
            hex_of(&Value::Str(&s256)),
            format!("da0100{}", "61".repeat(256))
        );
        let s_max = "a".repeat(MAX_LEN);
        assert!(hex_of(&Value::Str(&s_max)).starts_with("daffff6161"));
    }

    #[test]
    fn strings_are_utf8_bytes() {
        // Length prefix counts bytes, not chars.
        assert_eq!(hex_of(&Value::Str("é")), "a2c3a9");
    }

    #[test]
    fn arrays_use_fixarray_array16() {
        assert_eq!(hex_of(&Value::Array(vec![])), "90");
        let a15 = Value::Array(vec![Value::UInt(0); 15]);
        assert_eq!(hex_of(&a15), format!("9f{}", "00".repeat(15)));
        let a16 = Value::Array(vec![Value::UInt(0); 16]);
        assert_eq!(hex_of(&a16), format!("dc0010{}", "00".repeat(16)));
    }

    #[test]
    fn maps_use_fixmap_map16_and_keep_order() {
        assert_eq!(hex_of(&Value::Map(vec![])), "80");
        // {"z": [None, True, {"a": "b"}], "a": 1}: insertion order, not sorted.
        let nested = Value::Map(vec![
            (
                "z",
                Value::Array(vec![
                    Value::Nil,
                    Value::Bool(true),
                    Value::Map(vec![("a", Value::Str("b"))]),
                ]),
            ),
            ("a", Value::UInt(1)),
        ]);
        assert_eq!(hex_of(&nested), "82a17a93c0c381a161a162a16101");

        let keys: Vec<String> = (0..16).map(|i| format!("k{i:02}")).collect();
        let map16 = Value::Map(
            keys.iter()
                .zip(0u64..)
                .map(|(k, i)| (k.as_str(), Value::UInt(i)))
                .collect(),
        );
        assert!(hex_of(&map16).starts_with("de0010a36b3030"));
    }

    #[test]
    fn refuses_lengths_beyond_16_bit_forms() {
        let long = "a".repeat(MAX_LEN + 1);
        assert_eq!(
            encode(&Value::Str(&long)),
            Err(MsgpackError::TooLong { len: MAX_LEN + 1 })
        );
        let big_array = Value::Array(vec![Value::Nil; MAX_LEN + 1]);
        assert_eq!(
            encode(&big_array),
            Err(MsgpackError::TooLong { len: MAX_LEN + 1 })
        );
        let entries = vec![("", Value::Nil); MAX_LEN + 1];
        assert_eq!(
            encode(&Value::Map(entries)),
            Err(MsgpackError::TooLong { len: MAX_LEN + 1 })
        );
        // A too-long key inside a map is refused too.
        let nested = Value::Map(vec![(long.as_str(), Value::Nil)]);
        assert!(encode(&nested).is_err());
    }
}
