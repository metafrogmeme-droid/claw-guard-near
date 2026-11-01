//! Fail-closed checks for the fields an agent puts in an order.
//!
//! Every agent-supplied value goes through this module before anything is hashed or signed.
//! A value is either accepted in exactly one canonical form or rejected with a [`Malformed`]
//! error naming the field; the contract turns that into the `MALFORMED` receipt
//! `Blocked by your rule: orders must be well-formed (<field>)`.
//!
//! The checked types ([`Decimal8`], [`CheckedHlOrder`], [`EvmAddress`]) can only be built by
//! the functions here, so the encoders in `hl.rs` and `evm.rs` only ever see checked values.

use core::fmt;
use core::num::NonZeroU8;

use near_sdk::env;

use crate::util::{decode_hex_array, encode_hex_0x};

/// Decimal places of the fixed-point representation used for HL prices and sizes (1e-8 units).
pub const DECIMALS: usize = 8;
const UNITS_PER_ONE: u128 = 100_000_000; // 10^DECIMALS
/// `px × sz` is in 1e-16 units; dividing by 1e10 gives the notional in 1e-6 quote units.
const NOTIONAL_DIVISOR: u128 = 10_000_000_000;
/// HL tick rule: non-integer prices may have at most this many significant figures.
pub const MAX_PRICE_SIG_FIGS: usize = 5;
/// HL perps `MAX_DECIMALS`: a market's `sz_decimals` is at most this, and a non-integer price
/// may have at most `MAX_PERP_DECIMALS - sz_decimals` decimals.
pub const MAX_PERP_DECIMALS: u8 = 6;

/// Smallest accepted EVM `gas_limit` (a plain transfer costs 21 000 gas).
pub const MIN_GAS_LIMIT: u64 = 21_000;
/// Largest accepted EVM `gas_limit`.
pub const MAX_GAS_LIMIT: u64 = 200_000;
/// Largest accepted `max_fee_per_gas`: 100 gwei, in wei.
pub const MAX_FEE_PER_GAS_WEI: u128 = 100_000_000_000;
/// Largest accepted EVM `nonce`: 2^53 - 1. The keyless relayer (viem) cannot carry a larger
/// nonce, and EIP-2681 forbids 2^64 - 1, so a larger value would be signed for nothing and
/// would raise the agent's EVM nonce floor past every nonce it could still use.
pub const MAX_EVM_NONCE: u64 = (1 << 53) - 1;

/// Longest accepted proposal memo, in UTF-8 bytes.
pub const MAX_MEMO_BYTES: usize = 140;
/// Longest market name or token symbol, in characters.
pub const MAX_SYMBOL_CHARS: usize = 16;

/// An order field that failed a check. `as_str` is the wire name shown in the receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Market,
    Token,
    LimitPx,
    Sz,
    Tif,
    Leverage,
    Notional,
    Amount,
    To,
    GasLimit,
    MaxFeePerGas,
    MaxPriorityFeePerGas,
    Nonce,
    Memo,
    Order,
}

impl Field {
    /// The field's JSON wire name, e.g. `"limit_px"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Market => "market",
            Self::Token => "token",
            Self::LimitPx => "limit_px",
            Self::Sz => "sz",
            Self::Tif => "tif",
            Self::Leverage => "leverage",
            Self::Notional => "notional",
            Self::Amount => "amount",
            Self::To => "to",
            Self::GasLimit => "gas_limit",
            Self::MaxFeePerGas => "max_fee_per_gas",
            Self::MaxPriorityFeePerGas => "max_priority_fee_per_gas",
            Self::Nonce => "nonce",
            Self::Memo => "memo",
            Self::Order => "order",
        }
    }
}

impl fmt::Display for Field {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The order is not well-formed; the payload names the first field that failed.
/// `Display` prints only the field's wire name (e.g. `limit_px`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Malformed(pub Field);

impl fmt::Display for Malformed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Why a string is not a canonical HL decimal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecimalError {
    /// `""`.
    Empty,
    /// Anything but ASCII digits and one `.`: signs, exponents, spaces, a second `.`.
    InvalidChar,
    /// No digits before or after the `.` (`".5"`, `"1."`).
    MissingDigits,
    /// A leading zero other than the single `0` of `0.x` (`"01"`, `"00.5"`).
    LeadingZero,
    /// A zero at the end of the fractional part (`"0.010"`, `"1.0"`).
    TrailingZero,
    /// More than [`DECIMALS`] fractional digits.
    TooManyDecimals,
    /// The value is zero.
    Zero,
    /// The value does not fit in `u128` at 1e-8 scale.
    Overflow,
    /// A non-integer price with more than [`MAX_PRICE_SIG_FIGS`] significant figures.
    TooManySigFigs,
}

/// A positive decimal in HL canonical wire form, together with its value in 1e-8 units.
///
/// Canonical form: ASCII digits with at most one `.`, no sign or exponent, at most 8 decimals,
/// no trailing zeros after the `.`, no leading zeros except the single `0` in `0.x`, value > 0.
/// This is exactly what the HL Python SDK's `float_to_wire` produces, so the string can go into
/// the hashed action unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decimal8 {
    text: String,
    units: u128,
}

impl Decimal8 {
    /// Parses a canonical decimal (no significant-figure limit; see [`parse_limit_px`]).
    pub fn parse(s: &str) -> Result<Self, DecimalError> {
        if s.is_empty() {
            return Err(DecimalError::Empty);
        }
        let (int_part, frac_part) = match s.split_once('.') {
            Some((int_part, frac_part)) => (int_part, Some(frac_part)),
            None => (s, None),
        };
        let is_digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
        // A second '.' lands in `frac_part` and fails here as well.
        if !is_digits(int_part) || !frac_part.is_none_or(is_digits) {
            return Err(DecimalError::InvalidChar);
        }
        if int_part.is_empty() || frac_part == Some("") {
            return Err(DecimalError::MissingDigits);
        }
        if int_part.len() > 1 && int_part.starts_with('0') {
            return Err(DecimalError::LeadingZero);
        }
        let frac_part = frac_part.unwrap_or("");
        if frac_part.len() > DECIMALS {
            return Err(DecimalError::TooManyDecimals);
        }
        if frac_part.ends_with('0') {
            return Err(DecimalError::TrailingZero);
        }

        let int_units = digits_value(int_part)
            .and_then(|v| v.checked_mul(UNITS_PER_ONE))
            .ok_or(DecimalError::Overflow)?;
        // At most 8 digits, so neither step can overflow; right-pad to 8 decimals.
        let frac_units = digits_value(frac_part).ok_or(DecimalError::Overflow)?
            * 10u128.pow((DECIMALS - frac_part.len()) as u32);
        let units = int_units
            .checked_add(frac_units)
            .ok_or(DecimalError::Overflow)?;
        if units == 0 {
            return Err(DecimalError::Zero);
        }
        Ok(Self {
            text: s.to_owned(),
            units,
        })
    }

    /// The canonical string, exactly as it goes on the wire.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// The value in 1e-8 units (`"0.5"` -> `50_000_000`).
    pub fn units(&self) -> u128 {
        self.units
    }

    /// True if the value has no fractional part.
    pub fn is_integer(&self) -> bool {
        !self.text.contains('.')
    }

    /// Number of decimals as written (canonical form has no trailing zeros, so this is the
    /// value's real precision): `"0.01"` -> 2, `"65000"` -> 0.
    pub fn decimals(&self) -> usize {
        self.text.split_once('.').map_or(0, |(_, frac)| frac.len())
    }

    /// Number of significant figures: digits from the first non-zero digit to the end.
    /// (Canonical form has no trailing fractional zeros, so the last digit of a non-integer
    /// is significant; trailing zeros of an integer are counted too.)
    pub fn significant_figures(&self) -> usize {
        self.text
            .bytes()
            .filter(u8::is_ascii_digit)
            .skip_while(|&b| b == b'0')
            .count()
    }
}

/// Value of an ASCII digit string (empty -> 0); `None` on `u128` overflow.
fn digits_value(digits: &str) -> Option<u128> {
    digits.bytes().try_fold(0u128, |acc, b| {
        acc.checked_mul(10)?.checked_add(u128::from(b - b'0'))
    })
}

/// Parses an HL limit price: canonical decimal, and a non-integer price has at most
/// [`MAX_PRICE_SIG_FIGS`] significant figures (integer prices are always allowed).
pub fn parse_limit_px(s: &str) -> Result<Decimal8, Malformed> {
    let px = Decimal8::parse(s).map_err(|_| Malformed(Field::LimitPx))?;
    if !px.is_integer() && px.significant_figures() > MAX_PRICE_SIG_FIGS {
        return Err(Malformed(Field::LimitPx));
    }
    Ok(px)
}

/// Parses an HL order size (canonical decimal).
pub fn parse_sz(s: &str) -> Result<Decimal8, Malformed> {
    Decimal8::parse(s).map_err(|_| Malformed(Field::Sz))
}

/// HL limit-order time in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tif {
    /// Good til cancelled.
    Gtc,
    /// Immediate or cancel.
    Ioc,
    /// Add liquidity only (post only).
    Alo,
}

impl Tif {
    /// The HL wire string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Gtc => "Gtc",
            Self::Ioc => "Ioc",
            Self::Alo => "Alo",
        }
    }
}

/// Parses a time in force; only the exact strings `Gtc`, `Ioc`, `Alo` are accepted.
pub fn parse_tif(s: &str) -> Result<Tif, Malformed> {
    match s {
        "Gtc" => Ok(Tif::Gtc),
        "Ioc" => Ok(Tif::Ioc),
        "Alo" => Ok(Tif::Alo),
        _ => Err(Malformed(Field::Tif)),
    }
}

/// Notional `px × sz` in 1e-6 quote units, rounded up (fail closed against caps).
/// Overflow of the `u128` product is reported as `notional`.
pub fn notional_1e6(px: &Decimal8, sz: &Decimal8) -> Result<u128, Malformed> {
    let product = px
        .units()
        .checked_mul(sz.units())
        .ok_or(Malformed(Field::Notional))?;
    Ok(product / NOTIONAL_DIVISOR + u128::from(product % NOTIONAL_DIVISOR != 0))
}

/// The agent-supplied parts of an HL limit order after every check passed.
/// Only [`check_hl_order`] creates it, so holding one proves the checks ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedHlOrder {
    limit_px: Decimal8,
    sz: Decimal8,
    tif: Tif,
    notional_1e6: u128,
}

impl CheckedHlOrder {
    pub fn limit_px(&self) -> &Decimal8 {
        &self.limit_px
    }

    pub fn sz(&self) -> &Decimal8 {
        &self.sz
    }

    pub fn tif(&self) -> Tif {
        self.tif
    }

    /// `ceil(px × sz)` in 1e-6 quote units; this is what the notional and daily caps count.
    pub fn notional_1e6(&self) -> u128 {
        self.notional_1e6
    }
}

/// Checks an HL limit order's fields in a fixed order: `limit_px`, `sz`, `tif`, `notional`.
///
/// `sz_decimals` is the owner's value for the order's market, or `None` if the market is not on
/// the agent's list (that order is blocked later as `MARKET_NOT_ALLOWED`, so only the generic
/// format is checked here). With `Some(d)`: `sz` has at most `d` decimals and `limit_px` at
/// most `MAX_PERP_DECIMALS - d` (an integer price has none, so it always passes this check;
/// the significant-figure rule still applies to non-integer prices).
pub fn check_hl_order(
    limit_px: &str,
    sz: &str,
    tif: &str,
    sz_decimals: Option<u8>,
) -> Result<CheckedHlOrder, Malformed> {
    let limit_px = parse_limit_px(limit_px)?;
    // Rules validation keeps `sz_decimals <= MAX_PERP_DECIMALS`; were it ever larger, the
    // saturating subtraction would allow integer prices only.
    if let Some(sz_decimals) = sz_decimals
        && limit_px.decimals() > usize::from(MAX_PERP_DECIMALS.saturating_sub(sz_decimals))
    {
        return Err(Malformed(Field::LimitPx));
    }
    let sz = parse_sz(sz)?;
    if let Some(sz_decimals) = sz_decimals
        && sz.decimals() > usize::from(sz_decimals)
    {
        return Err(Malformed(Field::Sz));
    }
    let tif = parse_tif(tif)?;
    let notional_1e6 = notional_1e6(&limit_px, &sz)?;
    Ok(CheckedHlOrder {
        limit_px,
        sz,
        tif,
        notional_1e6,
    })
}

/// Checks an HL `updateLeverage` value: leverage 0 is malformed. The owner's ceiling is a
/// separate rule (`LEVERAGE_ABOVE_LIMIT`).
pub fn check_leverage(leverage: u8) -> Result<NonZeroU8, Malformed> {
    NonZeroU8::new(leverage).ok_or(Malformed(Field::Leverage))
}

/// A 20-byte EVM address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EvmAddress([u8; 20]);

impl EvmAddress {
    /// Parses `0x` or `0X` + exactly 40 hex digits. All-lowercase and all-uppercase digits are
    /// accepted as they are; mixed case must be a valid EIP-55 checksum, so a typo in a
    /// checksummed address is refused instead of silently lowercased.
    pub fn parse(s: &str) -> Option<Self> {
        let digits = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
        // Check the digits here rather than rely on `decode_hex`, which would accept a second
        // `0x` prefix.
        if digits.len() != 40 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let mixed_case = digits.bytes().any(|b| b.is_ascii_lowercase())
            && digits.bytes().any(|b| b.is_ascii_uppercase());
        if mixed_case && !is_eip55_checksum(digits) {
            return None;
        }
        decode_hex_array::<20>(digits).ok().map(Self)
    }

    pub fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    /// `0x` + 40 lowercase hex digits: the form used for allowlist comparison.
    pub fn to_hex(&self) -> String {
        encode_hex_0x(&self.0)
    }
}

impl fmt::Display for EvmAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// EIP-55: hex digit `i` of `digits` (40 hex digits, no prefix) is uppercase exactly when nibble
/// `i` of `keccak256(lowercase digits as ASCII)` is 8 or more. Decimal digits have no case.
fn is_eip55_checksum(digits: &str) -> bool {
    let hash = env::keccak256_array(digits.to_ascii_lowercase().as_bytes());
    digits.bytes().enumerate().all(|(i, b)| {
        let nibble = if i % 2 == 0 {
            hash[i / 2] >> 4
        } else {
            hash[i / 2] & 0x0f
        };
        b.is_ascii_digit()
            || if nibble >= 8 {
                b.is_ascii_uppercase()
            } else {
                b.is_ascii_lowercase()
            }
    })
}

/// The stored and compared form of an EVM address (`0x` + 40 lowercase hex), or `None` if `s`
/// is not an address [`EvmAddress::parse`] accepts.
pub fn normalize_evm_address(s: &str) -> Option<String> {
    EvmAddress::parse(s).map(|address| address.to_hex())
}

/// True if `s` is an EVM address already in canonical form (`0x` + 40 lowercase hex), the form
/// stored owner rules hold for token addresses and receivers.
pub fn is_canonical_evm_address(s: &str) -> bool {
    normalize_evm_address(s).is_some_and(|address| address == s)
}

/// True if `a` and `b` are both valid EVM addresses and name the same 20 bytes, whatever their
/// case or prefix. An unparsable address equals nothing (fail closed).
pub fn same_evm_address(a: &str, b: &str) -> bool {
    matches!((EvmAddress::parse(a), EvmAddress::parse(b)), (Some(x), Some(y)) if x == y)
}

/// Checks the agent-supplied fields of an ERC-20 transfer in a fixed order: `to`, `amount`,
/// `gas_limit`, `max_fee_per_gas`, `max_priority_fee_per_gas`. Returns the parsed receiver.
///
/// Bounds: `amount > 0`, `MIN_GAS_LIMIT <= gas_limit <= MAX_GAS_LIMIT`,
/// `max_fee_per_gas <= MAX_FEE_PER_GAS_WEI`, `max_priority_fee_per_gas <= max_fee_per_gas`.
pub fn check_evm_transfer(
    to: &str,
    amount: u128,
    gas_limit: u64,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
) -> Result<EvmAddress, Malformed> {
    let to = EvmAddress::parse(to).ok_or(Malformed(Field::To))?;
    if amount == 0 {
        return Err(Malformed(Field::Amount));
    }
    if !(MIN_GAS_LIMIT..=MAX_GAS_LIMIT).contains(&gas_limit) {
        return Err(Malformed(Field::GasLimit));
    }
    if max_fee_per_gas > MAX_FEE_PER_GAS_WEI {
        return Err(Malformed(Field::MaxFeePerGas));
    }
    if max_priority_fee_per_gas > max_fee_per_gas {
        return Err(Malformed(Field::MaxPriorityFeePerGas));
    }
    Ok(to)
}

/// Checks an EVM transfer's `nonce`: at most [`MAX_EVM_NONCE`]. Whether it is above the agent's
/// last EVM nonce is step 5 (`STALE_NONCE`).
pub fn check_evm_nonce(nonce: u64) -> Result<(), Malformed> {
    if nonce <= MAX_EVM_NONCE {
        Ok(())
    } else {
        Err(Malformed(Field::Nonce))
    }
}

/// True if `s` is 1..=[`MAX_SYMBOL_CHARS`] ASCII letters or digits.
fn is_symbol_like(s: &str) -> bool {
    (1..=MAX_SYMBOL_CHARS).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// True if `s` is a valid owner-set market name or token symbol: 1..=16 of `A-Z`, `0-9`.
pub fn is_rule_symbol(s: &str) -> bool {
    is_symbol_like(s) && !s.bytes().any(|b| b.is_ascii_lowercase())
}

/// Checks an agent-supplied market name before it is looked up or quoted in a receipt
/// message: 1..=16 ASCII letters or digits. Lowercase passes this check (and then simply does
/// not match any owner market); anything else is malformed, so agent text with spaces,
/// punctuation or extra length never reaches a decision message.
pub fn check_market(market: &str) -> Result<(), Malformed> {
    if is_symbol_like(market) {
        Ok(())
    } else {
        Err(Malformed(Field::Market))
    }
}

/// Checks an agent-supplied token symbol; same format as [`check_market`].
pub fn check_token(token: &str) -> Result<(), Malformed> {
    if is_symbol_like(token) {
        Ok(())
    } else {
        Err(Malformed(Field::Token))
    }
}

/// Checks the optional proposal memo: at most [`MAX_MEMO_BYTES`] UTF-8 bytes.
pub fn check_memo(memo: Option<&str>) -> Result<(), Malformed> {
    match memo {
        Some(memo) if memo.len() > MAX_MEMO_BYTES => Err(Malformed(Field::Memo)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> u128 {
        Decimal8::parse(s).expect("canonical").units()
    }

    #[test]
    fn plan_accept_table() {
        // Accept list.
        assert_eq!(units("0.01"), 1_000_000);
        assert_eq!(units("65000"), 6_500_000_000_000);
        assert_eq!(units("0.5"), 50_000_000);
        for s in ["0.01", "65000", "0.5"] {
            assert_eq!(parse_limit_px(s).map(|d| d.units()), Ok(units(s)), "{s}");
            assert_eq!(parse_sz(s).map(|d| d.units()), Ok(units(s)), "{s}");
        }
    }

    #[test]
    fn plan_reject_table() {
        // Reject list, with the reason each one fails.
        let cases: &[(&str, DecimalError)] = &[
            ("0.010", DecimalError::TrailingZero),
            ("1e3", DecimalError::InvalidChar),
            ("-1", DecimalError::InvalidChar),
            (".5", DecimalError::MissingDigits),
            ("01", DecimalError::LeadingZero),
            ("0.123456789", DecimalError::TooManyDecimals),
            ("1.000000001", DecimalError::TooManyDecimals),
        ];
        for &(s, reason) in cases {
            assert_eq!(Decimal8::parse(s), Err(reason), "{s:?}");
            assert_eq!(parse_limit_px(s), Err(Malformed(Field::LimitPx)), "{s:?}");
            assert_eq!(parse_sz(s), Err(Malformed(Field::Sz)), "{s:?}");
        }
    }

    #[test]
    fn edge_case_rejects() {
        let cases: &[(&str, DecimalError)] = &[
            ("", DecimalError::Empty),
            ("0", DecimalError::Zero),
            ("0.0", DecimalError::TrailingZero),
            ("0.00000000", DecimalError::TrailingZero),
            ("1.", DecimalError::MissingDigits),
            (".", DecimalError::MissingDigits),
            ("1.0", DecimalError::TrailingZero),
            ("10.50", DecimalError::TrailingZero),
            ("+1", DecimalError::InvalidChar),
            (" 1", DecimalError::InvalidChar),
            ("1 ", DecimalError::InvalidChar),
            ("1.2.3", DecimalError::InvalidChar),
            ("1,5", DecimalError::InvalidChar),
            ("0x10", DecimalError::InvalidChar),
            ("NaN", DecimalError::InvalidChar),
            ("inf", DecimalError::InvalidChar),
            ("١", DecimalError::InvalidChar), // non-ASCII digit
            ("00", DecimalError::LeadingZero),
            ("00.5", DecimalError::LeadingZero),
            ("007", DecimalError::LeadingZero),
        ];
        for &(s, reason) in cases {
            assert_eq!(Decimal8::parse(s), Err(reason), "{s:?}");
        }
    }

    #[test]
    fn edge_case_accepts() {
        assert_eq!(units("0.00000001"), 1);
        assert_eq!(units("0.12345678"), 12_345_678);
        assert_eq!(units("1"), 100_000_000);
        assert_eq!(units("10"), 1_000_000_000);
        assert_eq!(units("2500.5"), 250_050_000_000);
        assert_eq!(units("0.05"), 5_000_000);
    }

    #[test]
    fn overflow_is_rejected() {
        // u128::MAX ≈ 3.4e38, so at 1e-8 scale the integer part tops out near 3.4e30.
        let max_int = (u128::MAX / UNITS_PER_ONE).to_string();
        assert_eq!(units(&max_int), u128::MAX / UNITS_PER_ONE * UNITS_PER_ONE);
        let too_big = (u128::MAX / UNITS_PER_ONE + 1).to_string();
        assert_eq!(Decimal8::parse(&too_big), Err(DecimalError::Overflow));
        // The fractional part pushes the sum over the edge.
        let edge = format!("{max_int}.99999999");
        assert_eq!(Decimal8::parse(&edge), Err(DecimalError::Overflow));
        // Far more digits than u128 holds.
        let huge = "9".repeat(100);
        assert_eq!(Decimal8::parse(&huge), Err(DecimalError::Overflow));
        assert_eq!(parse_sz(&huge), Err(Malformed(Field::Sz)));
        assert_eq!(parse_limit_px(&huge), Err(Malformed(Field::LimitPx)));
    }

    #[test]
    fn price_significant_figures() {
        // Non-integer prices: at most 5 significant figures.
        for ok in [
            "2500.5",
            "12.345",
            "3.1415",
            "0.0001234",
            "0.00012345",
            "1234.5",
            "0.5",
        ] {
            assert!(parse_limit_px(ok).is_ok(), "{ok}");
        }
        for bad in ["123.456", "12345.6", "1.23456", "0.00123456", "65000.5"] {
            assert_eq!(parse_limit_px(bad), Err(Malformed(Field::LimitPx)), "{bad}");
            // Sizes have no significant-figure limit.
            assert!(parse_sz(bad).is_ok(), "{bad}");
        }
        // Integer prices are always allowed, whatever their significant figures.
        for ok in ["123456", "99999", "100000000", "1234567890123"] {
            assert!(parse_limit_px(ok).is_ok(), "{ok}");
        }
        assert_eq!(
            Decimal8::parse("0.0001234").unwrap().significant_figures(),
            4
        );
        assert_eq!(Decimal8::parse("2500.5").unwrap().significant_figures(), 5);
        assert_eq!(Decimal8::parse("65000").unwrap().significant_figures(), 5);
    }

    #[test]
    fn decimals_count_written_fraction_digits() {
        let d = |s| Decimal8::parse(s).unwrap().decimals();
        assert_eq!(d("65000"), 0);
        assert_eq!(d("1"), 0);
        assert_eq!(d("0.5"), 1);
        assert_eq!(d("0.01"), 2);
        assert_eq!(d("2500.5"), 1);
        assert_eq!(d("0.0001234"), 7);
        assert_eq!(d("0.00000001"), 8);
    }

    #[test]
    fn market_decimals_bound_size_and_price() {
        let check = |px: &str, sz: &str, sz_decimals: u8| {
            check_hl_order(px, sz, "Gtc", Some(sz_decimals)).map(|o| o.notional_1e6())
        };
        let px = Err(Malformed(Field::LimitPx));
        let sz = Err(Malformed(Field::Sz));
        for d in 0..=MAX_PERP_DECIMALS {
            let max_px_decimals = usize::from(MAX_PERP_DECIMALS - d);
            // Size: exactly `d` decimals allowed, `d + 1` refused.
            let at = if d == 0 {
                "1".to_owned()
            } else {
                format!("0.{}1", "0".repeat(usize::from(d) - 1))
            };
            let over = format!("0.{}1", "0".repeat(usize::from(d)));
            assert!(check("1", &at, d).is_ok(), "sz {at} with {d}");
            assert_eq!(check("1", &over, d), sz, "sz {over} with {d}");
            // Price: exactly `6 - d` decimals allowed, one more refused; integers always pass.
            let px_at = if max_px_decimals == 0 {
                "7".to_owned()
            } else {
                format!("0.{}7", "0".repeat(max_px_decimals - 1))
            };
            let px_over = format!("0.{}7", "0".repeat(max_px_decimals));
            assert!(check(&px_at, "1", d).is_ok(), "px {px_at} with {d}");
            assert_eq!(check(&px_over, "1", d), px, "px {px_over} with {d}");
            assert!(check("65000", "1", d).is_ok(), "integer px with {d}");
            assert!(
                check("1234567", "1", d).is_ok(),
                "integer px, 7 figures, {d}"
            );
        }
        // The significant-figure rule still applies within the allowed decimals.
        assert!(check("1.2345", "1", 0).is_ok());
        assert_eq!(check("1.23456", "1", 0), px);
        // Field order: limit_px, then sz, then tif.
        assert_eq!(check("0.0000007", "0.0000001", 0), px);
        assert_eq!(
            check_hl_order("1", "0.0000001", "bad", Some(6)),
            Err(Malformed(Field::Sz))
        );
        assert_eq!(
            check_hl_order("1", "0.000001", "bad", Some(6)),
            Err(Malformed(Field::Tif))
        );
        // `None` (market not on the list): only the generic format.
        assert!(check_hl_order("0.0001234", "0.00000001", "Gtc", None).is_ok());
        // Out-of-range `sz_decimals` (refused by rules validation) never allows more.
        assert_eq!(check("0.5", "1", u8::MAX), px);
        assert!(check("5", "0.00000001", u8::MAX).is_ok());
    }

    #[test]
    fn tif_is_exact() {
        assert_eq!(parse_tif("Gtc"), Ok(Tif::Gtc));
        assert_eq!(parse_tif("Ioc"), Ok(Tif::Ioc));
        assert_eq!(parse_tif("Alo"), Ok(Tif::Alo));
        for bad in ["", "gtc", "GTC", "Gtc ", "FrontendMarket", "Alo\0"] {
            assert_eq!(parse_tif(bad), Err(Malformed(Field::Tif)), "{bad:?}");
        }
        for tif in [Tif::Gtc, Tif::Ioc, Tif::Alo] {
            assert_eq!(parse_tif(tif.as_str()), Ok(tif));
        }
    }

    #[test]
    fn notional_rounds_up() {
        let d = |s| Decimal8::parse(s).unwrap();
        // 65000 × 0.01 = 650 quote units = 650_000_000 at 1e-6.
        assert_eq!(notional_1e6(&d("65000"), &d("0.01")), Ok(650_000_000));
        // 1000 × 0.001 = 1.
        assert_eq!(notional_1e6(&d("1000"), &d("0.001")), Ok(1_000_000));
        // Exact at 1e-6: 0.5 × 0.000002 = 0.000001.
        assert_eq!(notional_1e6(&d("0.5"), &d("0.000002")), Ok(1));
        // Below 1e-6 rounds up to 1 (fail closed against caps).
        assert_eq!(notional_1e6(&d("0.5"), &d("0.00000001")), Ok(1));
        // 0.0001234 × 123 = 0.0151782 -> 15178.2 -> 15179.
        assert_eq!(notional_1e6(&d("0.0001234"), &d("123")), Ok(15_179));
    }

    #[test]
    fn notional_overflow_is_malformed() {
        let px = Decimal8::parse("100000000000000000000").unwrap(); // 1e20 -> 1e28 units
        let sz = Decimal8::parse("100000000000").unwrap(); // 1e11 -> 1e19 units
        assert_eq!(notional_1e6(&px, &sz), Err(Malformed(Field::Notional)));
        assert_eq!(
            check_hl_order("100000000000000000000", "100000000000", "Gtc", None),
            Err(Malformed(Field::Notional))
        );
        // Largest product that fits still works.
        let one = Decimal8::parse("1").unwrap();
        let max_int = (u128::MAX / UNITS_PER_ONE).to_string();
        let big = Decimal8::parse(&max_int).unwrap();
        assert_eq!(
            notional_1e6(&big, &one),
            Err(Malformed(Field::Notional)),
            "units × 1e8 overflows u128"
        );
        let unit = Decimal8::parse("0.00000001").unwrap();
        assert!(notional_1e6(&big, &unit).is_ok());
    }

    #[test]
    fn hl_order_checks_fields_in_order() {
        let ok = check_hl_order("2500.5", "0.1", "Alo", None).expect("valid");
        assert_eq!(ok.limit_px().as_str(), "2500.5");
        assert_eq!(ok.sz().as_str(), "0.1");
        assert_eq!(ok.tif(), Tif::Alo);
        assert_eq!(ok.notional_1e6(), 250_050_000);
        // First failing field wins: limit_px, then sz, then tif.
        assert_eq!(
            check_hl_order("01", "0.010", "x", None),
            Err(Malformed(Field::LimitPx))
        );
        assert_eq!(
            check_hl_order("1", "0.010", "x", None),
            Err(Malformed(Field::Sz))
        );
        assert_eq!(
            check_hl_order("1", "0.01", "x", None),
            Err(Malformed(Field::Tif))
        );
    }

    #[test]
    fn leverage_zero_is_malformed() {
        assert_eq!(check_leverage(0), Err(Malformed(Field::Leverage)));
        assert_eq!(check_leverage(1).map(NonZeroU8::get), Ok(1));
        assert_eq!(check_leverage(u8::MAX).map(NonZeroU8::get), Ok(u8::MAX));
    }

    #[test]
    fn evm_address_parsing_and_lowercasing() {
        // EIP-55 checksum of 0xabcdef0123456789abcdef0123456789abcdef01 (eth_utils 5.x).
        let mixed = "0xabCDeF0123456789AbcdEf0123456789aBCDEF01";
        let address = EvmAddress::parse(mixed).expect("valid");
        assert_eq!(address.to_hex(), mixed.to_ascii_lowercase());
        assert_eq!(address.to_string(), mixed.to_ascii_lowercase());
        assert_eq!(address.as_bytes()[0], 0xab);
        assert!(!is_canonical_evm_address(mixed));
        assert!(is_canonical_evm_address(&mixed.to_ascii_lowercase()));
        assert_eq!(
            normalize_evm_address(mixed).as_deref(),
            Some("0xabcdef0123456789abcdef0123456789abcdef01")
        );

        for bad in [
            "",
            "0x",
            "0X",
            "abcdef0123456789abcdef0123456789abcdef01", // no prefix
            "0xabcdef0123456789abcdef0123456789abcdef0", // 39 digits
            "0xabcdef0123456789abcdef0123456789abcdef012", // 41 digits
            "0Xabcdef0123456789abcdef0123456789abcdef0", // 39 digits, 0X
            "0xabcdef0123456789abcdef0123456789abcdef0g", // non-hex
            "0xABCDEF0123456789ABCDEF0123456789ABCDEF0G", // non-hex, uppercase
            "0x abcdef0123456789abcdef0123456789abcdef0",
            " 0xabcdef0123456789abcdef0123456789abcdef01",
            "0xabcdef0123456789abcdef0123456789abcdef01 ",
            "0x0xabcdef0123456789abcdef0123456789abcdef",
            "0X0Xabcdef0123456789abcdef0123456789abcdef",
            "0x+bcdef0123456789abcdef0123456789abcdef01",
            "xabcdef0123456789abcdef0123456789abcdef01",
            "00abcdef0123456789abcdef0123456789abcdef01",
            "0xAbCdEf0123456789abcdef0123456789ABCDEF01", // mixed case, not the checksum
            "bad.testnet",
        ] {
            assert_eq!(EvmAddress::parse(bad), None, "{bad:?}");
            assert_eq!(normalize_evm_address(bad), None, "{bad:?}");
            assert!(!is_canonical_evm_address(bad), "{bad:?}");
        }
    }

    /// The four test addresses of the EIP-55 specification.
    const EIP55_SPEC: [&str; 4] = [
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
        "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
        "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
        "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ];

    /// `s` with the ASCII case of the byte at `i` flipped.
    fn flip_case(s: &str, i: usize) -> String {
        let mut bytes = s.as_bytes().to_vec();
        bytes[i] ^= 0x20;
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn eip55_spec_addresses_are_accepted_and_lowercased() {
        for address in EIP55_SPEC {
            let lowercase = format!("0x{}", address[2..].to_ascii_lowercase());
            let parsed = EvmAddress::parse(address).unwrap_or_else(|| panic!("{address}"));
            assert_eq!(parsed.to_hex(), lowercase);
            // The same checksummed digits behind `0X`.
            assert_eq!(
                EvmAddress::parse(&format!("0X{}", &address[2..])),
                Some(parsed),
                "{address}"
            );
            assert!(same_evm_address(address, &lowercase));
        }
    }

    #[test]
    fn eip55_one_flipped_letter_is_refused() {
        for address in EIP55_SPEC {
            let mut flipped_any = false;
            for i in 2..address.len() {
                if !address.as_bytes()[i].is_ascii_alphabetic() {
                    continue;
                }
                // Every spec address has letters of both cases, so one flip stays mixed case.
                let flipped = flip_case(address, i);
                assert_eq!(EvmAddress::parse(&flipped), None, "{flipped}");
                assert_eq!(
                    EvmAddress::parse(&format!("0X{}", &flipped[2..])),
                    None,
                    "{flipped}"
                );
                assert!(!same_evm_address(&flipped, address), "{flipped}");
                flipped_any = true;
            }
            assert!(flipped_any, "{address}");
        }
    }

    #[test]
    fn single_case_addresses_need_no_checksum() {
        for address in EIP55_SPEC {
            let lower = address[2..].to_ascii_lowercase();
            let upper = address[2..].to_ascii_uppercase();
            let expected = EvmAddress::parse(address).unwrap();
            for form in [
                format!("0x{lower}"),
                format!("0x{upper}"),
                format!("0X{lower}"),
                format!("0X{upper}"),
            ] {
                assert_eq!(EvmAddress::parse(&form), Some(expected), "{form}");
                assert_eq!(
                    normalize_evm_address(&form).as_deref(),
                    Some(format!("0x{lower}").as_str()),
                    "{form}"
                );
            }
        }
        // Only decimal digits: no letters, so no case at all.
        let digits = "0x1111111111111111111111111111111111111111";
        assert!(EvmAddress::parse(digits).is_some());
        assert!(EvmAddress::parse(&digits.replace("0x", "0X")).is_some());
    }

    #[test]
    fn same_evm_address_compares_bytes_and_fails_closed() {
        let lower = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
        assert!(same_evm_address(lower, EIP55_SPEC[0]));
        assert!(same_evm_address(&lower.to_ascii_uppercase(), lower));
        assert!(!same_evm_address(lower, EIP55_SPEC[1]));
        // Unparsable never equals anything, not even itself.
        assert!(!same_evm_address("0xbad", "0xbad"));
        assert!(!same_evm_address(
            &flip_case(EIP55_SPEC[0], 3),
            EIP55_SPEC[0]
        ));
    }

    /// Independent oracle: 16 random addresses (Python `random.Random(55)`) checksummed by
    /// `eth_utils.to_checksum_address`, plus the EIP-55 specification's examples whose checksum
    /// is all caps or all lowercase.
    const ETH_UTILS_CHECKSUMS: [&str; 16] = [
        "0x26492592BFcccAD18170e71c72D676D59A03D9Ab",
        "0x67e55795e694df3C28189a842DefF2F8b387cDF5",
        "0x817bdaB01b6fAf9C8f6756BEF01385f6D3d69607",
        "0xff6D0bE82DbdCA214D40218B12D70E21bd0D7844",
        "0x982cF0A33192752fE802c24fC1AD32123f996c05",
        "0x4AfBf048fA31aE988F3B7334a0EC5d382701b0df",
        "0x1a6776BFa20bc709990C8249b9A42903E4C94Be9",
        "0x7dC88FD18C3983A6b599a769b226d48f8adeBdC9",
        "0xCa26dE1e9EF173B632586A486cB93957AAA7A57D",
        "0x06b5d8Ca86C953bABF159ec72C6a94805647853c",
        "0x631e71586bfE2F375e23fb57265018761925AEb0",
        "0xF69d4F5D1E2197f678D3Cb22F0feb37d3c93c4c7",
        "0x8b6A56Da9a34610eD15BF0B867a0B0E3DB6C7E03",
        "0x7a1F6ad3aAa106486fdD86E8659A68E08564C933",
        "0x1865D370b67b528E52c2696AF7768d1B8D22c413",
        "0xaABf2F686d167757C85Bd20dB676e78D3817dd6F",
    ];
    const EIP55_SPEC_SINGLE_CASE: [&str; 4] = [
        "0x52908400098527886E0F7030069857D2E4169EE7",
        "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
        "0xde709f2102306220921060314715629080e2fb77",
        "0x27b1fdb04752bbc536007a920d24acb045561c26",
    ];

    #[test]
    fn eip55_matches_an_independent_reference() {
        for address in ETH_UTILS_CHECKSUMS.iter().chain(&EIP55_SPEC_SINGLE_CASE) {
            let lowercase = format!("0x{}", address[2..].to_ascii_lowercase());
            let parsed = EvmAddress::parse(address).unwrap_or_else(|| panic!("{address}"));
            assert_eq!(parsed.to_hex(), lowercase, "{address}");
            assert_eq!(
                EvmAddress::parse(&format!("0X{}", &address[2..])),
                Some(parsed),
                "{address}"
            );
            // Every single-letter case flip of a valid checksum is refused, behind either
            // prefix; for an address whose checksum is single case, a flip makes it mixed case.
            for i in 2..address.len() {
                if !address.as_bytes()[i].is_ascii_alphabetic() {
                    continue;
                }
                let flipped = flip_case(address, i);
                let mixed = flipped[2..].bytes().any(|b| b.is_ascii_lowercase())
                    && flipped[2..].bytes().any(|b| b.is_ascii_uppercase());
                if mixed {
                    assert_eq!(EvmAddress::parse(&flipped), None, "{flipped}");
                    assert_eq!(
                        EvmAddress::parse(&format!("0X{}", &flipped[2..])),
                        None,
                        "{flipped}"
                    );
                    assert_eq!(normalize_evm_address(&flipped), None, "{flipped}");
                } else {
                    // A flip turned it into all one case: accepted as is, same bytes.
                    assert_eq!(EvmAddress::parse(&flipped), Some(parsed), "{flipped}");
                }
            }
        }
    }

    #[test]
    fn market_decimals_match_a_model_for_every_combination() {
        // `"0.0…07"` with `k` decimals has one significant figure, so only the decimal bounds
        // decide; `"7"` is an integer price.
        let with_decimals = |k: usize| {
            if k == 0 {
                "7".to_owned()
            } else {
                format!("0.{}7", "0".repeat(k - 1))
            }
        };
        for d in 0..=MAX_PERP_DECIMALS {
            for px_decimals in 0..=DECIMALS {
                for sz_decimals in 0..=DECIMALS {
                    let px = with_decimals(px_decimals);
                    let sz = with_decimals(sz_decimals);
                    let expected = if px_decimals > usize::from(MAX_PERP_DECIMALS - d) {
                        Err(Malformed(Field::LimitPx))
                    } else if sz_decimals > usize::from(d) {
                        Err(Malformed(Field::Sz))
                    } else {
                        Ok(())
                    };
                    assert_eq!(
                        check_hl_order(&px, &sz, "Gtc", Some(d)).map(|_| ()),
                        expected,
                        "px {px} sz {sz} sz_decimals {d}"
                    );
                    // Without a market precision every combination passes the generic format.
                    assert!(check_hl_order(&px, &sz, "Gtc", None).is_ok(), "{px} {sz}");
                }
            }
        }
    }

    const TO: &str = "0x1111111111111111111111111111111111111111";

    #[test]
    fn evm_transfer_bounds() {
        let ok = check_evm_transfer(TO, 1, MIN_GAS_LIMIT, 0, 0).expect("valid");
        assert_eq!(ok.to_hex(), TO);
        assert!(
            check_evm_transfer(
                TO,
                u128::MAX,
                MAX_GAS_LIMIT,
                MAX_FEE_PER_GAS_WEI,
                MAX_FEE_PER_GAS_WEI
            )
            .is_ok()
        );

        let cases: &[(&str, u128, u64, u128, u128, Field)] = &[
            ("0xbad", 1, 21_000, 1, 1, Field::To),
            (TO, 0, 21_000, 1, 1, Field::Amount),
            (TO, 1, MIN_GAS_LIMIT - 1, 1, 1, Field::GasLimit),
            (TO, 1, MAX_GAS_LIMIT + 1, 1, 1, Field::GasLimit),
            (TO, 1, 0, 1, 1, Field::GasLimit),
            (
                TO,
                1,
                21_000,
                MAX_FEE_PER_GAS_WEI + 1,
                1,
                Field::MaxFeePerGas,
            ),
            (TO, 1, 21_000, 10, 11, Field::MaxPriorityFeePerGas),
            // Several bad fields: the first in check order is reported.
            ("nope", 0, 0, u128::MAX, u128::MAX, Field::To),
            (TO, 0, 0, u128::MAX, u128::MAX, Field::Amount),
            (TO, 1, 0, u128::MAX, u128::MAX, Field::GasLimit),
        ];
        for &(to, amount, gas, max_fee, max_prio, field) in cases {
            assert_eq!(
                check_evm_transfer(to, amount, gas, max_fee, max_prio),
                Err(Malformed(field)),
                "{to} {amount} {gas} {max_fee} {max_prio}"
            );
        }
    }

    #[test]
    fn evm_nonce_bound() {
        for nonce in [0, 1, MAX_EVM_NONCE] {
            assert_eq!(check_evm_nonce(nonce), Ok(()), "{nonce}");
        }
        for nonce in [MAX_EVM_NONCE + 1, (1 << 53) + 1, u64::MAX - 1, u64::MAX] {
            assert_eq!(
                check_evm_nonce(nonce),
                Err(Malformed(Field::Nonce)),
                "{nonce}"
            );
        }
    }

    #[test]
    fn memo_length() {
        assert_eq!(check_memo(None), Ok(()));
        assert_eq!(check_memo(Some("")), Ok(()));
        assert_eq!(check_memo(Some(&"a".repeat(140))), Ok(()));
        assert_eq!(
            check_memo(Some(&"a".repeat(141))),
            Err(Malformed(Field::Memo))
        );
        // Counted in UTF-8 bytes, not characters.
        assert_eq!(check_memo(Some(&"é".repeat(70))), Ok(()));
        assert_eq!(
            check_memo(Some(&"é".repeat(71))),
            Err(Malformed(Field::Memo))
        );
    }

    #[test]
    fn symbols() {
        for ok in ["BTC", "ETH", "USDC", "A", "1000PEPE", "ABCDEFGHIJKLMNOP"] {
            assert!(is_rule_symbol(ok), "{ok}");
            assert_eq!(check_market(ok), Ok(()), "{ok}");
            assert_eq!(check_token(ok), Ok(()), "{ok}");
        }
        // Agent input may be lowercase (it then matches no owner market), rules may not.
        for agent_only in ["doge", "kPEPE", "usdc"] {
            assert!(!is_rule_symbol(agent_only), "{agent_only}");
            assert_eq!(check_market(agent_only), Ok(()), "{agent_only}");
        }
        for bad in [
            "",
            "ABCDEFGHIJKLMNOPQ", // 17 chars
            "BTC ",
            "BTC-PERP",
            "BTC/USDC",
            "Allowed: within your limits",
            "ÉTH",
            "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        ] {
            assert!(!is_rule_symbol(bad), "{bad:?}");
            assert_eq!(check_market(bad), Err(Malformed(Field::Market)), "{bad:?}");
            assert_eq!(check_token(bad), Err(Malformed(Field::Token)), "{bad:?}");
        }
    }

    #[test]
    fn field_names_are_wire_names() {
        let all = [
            (Field::Market, "market"),
            (Field::Token, "token"),
            (Field::LimitPx, "limit_px"),
            (Field::Sz, "sz"),
            (Field::Tif, "tif"),
            (Field::Leverage, "leverage"),
            (Field::Notional, "notional"),
            (Field::Amount, "amount"),
            (Field::To, "to"),
            (Field::GasLimit, "gas_limit"),
            (Field::MaxFeePerGas, "max_fee_per_gas"),
            (Field::MaxPriorityFeePerGas, "max_priority_fee_per_gas"),
            (Field::Nonce, "nonce"),
            (Field::Memo, "memo"),
            (Field::Order, "order"),
        ];
        for (field, name) in all {
            assert_eq!(field.as_str(), name);
            assert_eq!(Malformed(field).to_string(), name);
        }
    }
}
