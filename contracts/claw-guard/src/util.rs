//! Hex and UTF-8 helpers shared by the contract modules.
//!
//! Output is always lowercase. `encode_hex_0x` is the format used for every hash, address and
//! signature the contract shows (`0x` + lowercase hex); `encode_hex` (no prefix) is the format
//! the MPC `payload_v2` field expects. Decoding is lenient on case and the `0x` prefix so that
//! responses from other services parse, but strict on everything else.

use core::fmt;

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// Why a hex string could not be decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HexError {
    /// The number of hex digits is odd.
    OddLength,
    /// A character that is not a hex digit.
    InvalidChar,
    /// The decoded byte length differs from the required fixed length.
    WrongLength { expected: usize, actual: usize },
}

impl fmt::Display for HexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OddLength => f.write_str("odd number of hex digits"),
            Self::InvalidChar => f.write_str("invalid hex character"),
            Self::WrongLength { expected, actual } => {
                write!(f, "expected {expected} bytes, got {actual}")
            }
        }
    }
}

/// Lowercase hex without a prefix, e.g. `[0xab, 0x01]` -> `"ab01"`.
pub fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    push_hex(&mut out, bytes);
    out
}

/// `0x` + lowercase hex, e.g. `[0xab, 0x01]` -> `"0xab01"`.
pub fn encode_hex_0x(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    push_hex(&mut out, bytes);
    out
}

/// Appends the lowercase hex digits of `bytes` to `out`.
pub(crate) fn push_hex(out: &mut String, bytes: &[u8]) {
    for &byte in bytes {
        out.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(HEX_DIGITS[usize::from(byte & 0x0f)]));
    }
}

/// Decodes hex with or without a `0x` prefix; digits may be upper or lower case.
pub fn decode_hex(s: &str) -> Result<Vec<u8>, HexError> {
    let digits = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    if !digits.len().is_multiple_of(2) {
        return Err(HexError::OddLength);
    }
    digits
        .chunks_exact(2)
        .map(|pair| Ok((nibble(pair[0])? << 4) | nibble(pair[1])?))
        .collect()
}

/// Like [`decode_hex`], but the result must be exactly `N` bytes long.
pub fn decode_hex_array<const N: usize>(s: &str) -> Result<[u8; N], HexError> {
    let bytes = decode_hex(s)?;
    <[u8; N]>::try_from(bytes.as_slice()).map_err(|_| HexError::WrongLength {
        expected: N,
        actual: bytes.len(),
    })
}

/// The longest prefix of `s` that is at most `max_bytes` UTF-8 bytes long. Cuts only at a
/// character boundary (never splits a character), so the result can be shorter than `max_bytes`.
pub fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    &s[..s.floor_char_boundary(max_bytes)]
}

fn nibble(c: u8) -> Result<u8, HexError> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(HexError::InvalidChar),
    }
}

/// Test-only helpers shared by the vector tests in `hl.rs` and `evm.rs`.
#[cfg(test)]
pub(crate) mod testing {
    use super::{decode_hex, encode_hex_0x};
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    /// Parses a big-endian hex number of up to 32 bytes into a left-padded 32-byte word.
    /// Reference signatures sometimes drop leading zero digits (e.g. 63 hex digits).
    pub fn word(hex: &str) -> [u8; 32] {
        let digits = hex.strip_prefix("0x").unwrap_or(hex);
        assert!(digits.len() <= 64, "more than 32 bytes: {hex}");
        let padded = format!("{digits:0>64}");
        let bytes = decode_hex(&padded).expect("hex word");
        bytes.try_into().expect("32 bytes")
    }

    /// Recovers the EVM address (`0x` + lowercase hex) that produced `(r, s, recovery_id)` over
    /// `prehash`, using k256 independently of the contract code.
    pub fn recover_evm_address(
        prehash: &[u8; 32],
        r: &[u8; 32],
        s: &[u8; 32],
        recovery_id: u8,
    ) -> String {
        let signature = Signature::from_scalars(*r, *s).expect("r and s are valid scalars");
        let recovery_id = RecoveryId::from_byte(recovery_id).expect("recovery id is 0..=3");
        let key = VerifyingKey::recover_from_prehash(prehash, &signature, recovery_id)
            .expect("signature recovers to a public key");
        let uncompressed = key.to_sec1_point(false);
        // Address = last 20 bytes of keccak256(x ‖ y), skipping the 0x04 SEC1 tag.
        let hash = near_sdk::env::keccak256_array(&uncompressed.as_bytes()[1..]);
        encode_hex_0x(&hash[12..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_lowercase_with_and_without_prefix() {
        assert_eq!(encode_hex(&[]), "");
        assert_eq!(encode_hex_0x(&[]), "0x");
        assert_eq!(encode_hex(&[0x00, 0xab, 0x0f, 0xff]), "00ab0fff");
        assert_eq!(encode_hex_0x(&[0xde, 0xad, 0xBE, 0xEF]), "0xdeadbeef");
    }

    #[test]
    fn decodes_either_case_and_optional_prefix() {
        assert_eq!(decode_hex("0xDeadBEEF"), Ok(vec![0xde, 0xad, 0xbe, 0xef]));
        assert_eq!(decode_hex("deadbeef"), Ok(vec![0xde, 0xad, 0xbe, 0xef]));
        assert_eq!(decode_hex("0x"), Ok(vec![]));
        assert_eq!(decode_hex(""), Ok(vec![]));
    }

    #[test]
    fn rejects_bad_hex() {
        assert_eq!(decode_hex("0xabc"), Err(HexError::OddLength));
        assert_eq!(decode_hex("0xzz"), Err(HexError::InvalidChar));
        assert_eq!(decode_hex(" 0xab"), Err(HexError::OddLength));
        assert_eq!(decode_hex("0x ab "), Err(HexError::InvalidChar));
        assert_eq!(decode_hex("0x0xab"), Err(HexError::InvalidChar));
        assert_eq!(decode_hex("+1"), Err(HexError::InvalidChar));
        // Only a lowercase `0x` prefix is stripped.
        assert_eq!(decode_hex("0Xab"), Err(HexError::InvalidChar));
    }

    #[test]
    fn fixed_length_decode() {
        assert_eq!(decode_hex_array::<2>("0x0102"), Ok([1, 2]));
        assert_eq!(
            decode_hex_array::<32>("0x0102"),
            Err(HexError::WrongLength {
                expected: 32,
                actual: 2
            })
        );
        assert_eq!(decode_hex_array::<1>("0x1"), Err(HexError::OddLength));
    }

    #[test]
    fn round_trips() {
        let bytes: Vec<u8> = (0..=255).collect();
        assert_eq!(decode_hex(&encode_hex_0x(&bytes)), Ok(bytes.clone()));
        assert_eq!(decode_hex(&encode_hex(&bytes)), Ok(bytes));
    }

    #[test]
    fn word_left_pads() {
        let w = testing::word("0x1");
        assert_eq!(w[31], 1);
        assert!(w[..31].iter().all(|&b| b == 0));
    }
}
