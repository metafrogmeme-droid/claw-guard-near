//! Unsigned EIP-1559 ERC-20 `transfer` transactions for Base Sepolia.
//!
//! ```text
//! unsigned_tx  = 0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit,
//!                           to = token, value = 0, data = transfer(receiver, amount), accessList = []])
//! payload_hash = keccak256(unsigned_tx)
//! ```
//!
//! The chain id is the compile-time constant 84532 (Base Sepolia); no function takes a chain id,
//! so this crate cannot build a transaction for any other chain. RLP is hand-rolled (it is
//! small) and checked byte for byte against viem-generated vectors.

use near_sdk::env;

/// Base Sepolia. Fixed at compile time.
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84_532;
/// EIP-2718 type byte of an EIP-1559 transaction.
pub const EIP1559_TX_TYPE: u8 = 0x02;
/// `bytes4(keccak256("transfer(address,uint256)"))`.
pub const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// Length of `transfer(address,uint256)` calldata: selector + two ABI words.
pub const TRANSFER_CALLDATA_LEN: usize = 4 + 32 + 32;

/// An ERC-20 transfer, from the owner's token rule plus the agent's checked fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Erc20Transfer {
    /// ERC-20 contract address (the transaction's `to`), from the owner's token rule.
    pub token: [u8; 20],
    /// Receiver of the tokens (inside the calldata).
    pub to: [u8; 20],
    /// Raw token units.
    pub amount: u128,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
}

/// The unsigned transaction and the hash the MPC signs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmPayload {
    /// `0x02 ‖ rlp(...)`; stored (hex) as the receipt's `signed_body`.
    pub unsigned_tx: Vec<u8>,
    /// `keccak256(unsigned_tx)`; the receipt's `payload_hash`.
    pub payload_hash: [u8; 32],
}

/// Builds the unsigned EIP-1559 transaction and its signing hash.
pub fn build_transfer(transfer: &Erc20Transfer) -> EvmPayload {
    let unsigned_tx = unsigned_tx(transfer);
    let payload_hash = env::keccak256_array(&unsigned_tx);
    EvmPayload {
        unsigned_tx,
        payload_hash,
    }
}

/// `0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, token, 0, data, []])`.
pub fn unsigned_tx(transfer: &Erc20Transfer) -> Vec<u8> {
    let mut fields = Vec::with_capacity(160);
    rlp::encode_uint(&mut fields, u128::from(BASE_SEPOLIA_CHAIN_ID));
    rlp::encode_uint(&mut fields, u128::from(transfer.nonce));
    rlp::encode_uint(&mut fields, transfer.max_priority_fee_per_gas);
    rlp::encode_uint(&mut fields, transfer.max_fee_per_gas);
    rlp::encode_uint(&mut fields, u128::from(transfer.gas_limit));
    rlp::encode_bytes(&mut fields, &transfer.token);
    rlp::encode_uint(&mut fields, 0); // value: no ETH is sent
    rlp::encode_bytes(
        &mut fields,
        &transfer_calldata(&transfer.to, transfer.amount),
    );
    rlp::encode_list(&mut fields, &[]); // accessList

    let mut tx = Vec::with_capacity(fields.len() + 4);
    tx.push(EIP1559_TX_TYPE);
    rlp::encode_list(&mut tx, &fields);
    tx
}

/// ABI calldata of `transfer(address to, uint256 amount)`.
pub fn transfer_calldata(to: &[u8; 20], amount: u128) -> [u8; TRANSFER_CALLDATA_LEN] {
    let mut data = [0u8; TRANSFER_CALLDATA_LEN];
    data[..4].copy_from_slice(&ERC20_TRANSFER_SELECTOR);
    data[16..36].copy_from_slice(to); // address word: 12 zero bytes, then 20 bytes
    data[52..].copy_from_slice(&amount.to_be_bytes()); // uint256 word: 16 zero bytes, then u128
    data
}

/// The subset of RLP needed here: byte strings, unsigned integers and lists.
mod rlp {
    const STRING_SHORT: u8 = 0x80;
    const STRING_LONG: u8 = 0xb7;
    const LIST_SHORT: u8 = 0xc0;
    const LIST_LONG: u8 = 0xf7;
    /// Payloads up to this length use the one-byte short header.
    const SHORT_MAX_LEN: usize = 55;

    /// A byte string. A single byte below 0x80 is its own encoding.
    pub fn encode_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
        if let [single] = bytes
            && *single < STRING_SHORT
        {
            out.push(*single);
            return;
        }
        write_header(out, bytes.len(), STRING_SHORT, STRING_LONG);
        out.extend_from_slice(bytes);
    }

    /// An unsigned integer: minimal big-endian bytes, no leading zeros (0 is the empty string).
    pub fn encode_uint(out: &mut Vec<u8>, value: u128) {
        let bytes = value.to_be_bytes();
        let first_non_zero = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
        encode_bytes(out, &bytes[first_non_zero..]);
    }

    /// A list whose items are already RLP-encoded and concatenated in `payload`.
    pub fn encode_list(out: &mut Vec<u8>, payload: &[u8]) {
        write_header(out, payload.len(), LIST_SHORT, LIST_LONG);
        out.extend_from_slice(payload);
    }

    fn write_header(out: &mut Vec<u8>, len: usize, short_base: u8, long_base: u8) {
        if len <= SHORT_MAX_LEN {
            out.push(short_base + len as u8); // len <= 55
        } else {
            let len_bytes = (len as u64).to_be_bytes();
            let first_non_zero = len_bytes.iter().position(|&b| b != 0).unwrap_or(7);
            let len_bytes = &len_bytes[first_non_zero..];
            out.push(long_base + len_bytes.len() as u8); // at most 8 length bytes
            out.extend_from_slice(len_bytes);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::util::encode_hex;

        fn bytes_hex(bytes: &[u8]) -> String {
            let mut out = Vec::new();
            encode_bytes(&mut out, bytes);
            encode_hex(&out)
        }

        fn uint_hex(value: u128) -> String {
            let mut out = Vec::new();
            encode_uint(&mut out, value);
            encode_hex(&out)
        }

        #[test]
        fn byte_strings() {
            assert_eq!(bytes_hex(&[]), "80");
            assert_eq!(bytes_hex(&[0x00]), "00");
            assert_eq!(bytes_hex(&[0x7f]), "7f");
            assert_eq!(bytes_hex(&[0x80]), "8180");
            assert_eq!(bytes_hex(&[1, 2]), "820102");
            let b55 = [0xaau8; 55];
            assert_eq!(bytes_hex(&b55), format!("b7{}", "aa".repeat(55)));
            let b56 = [0xaau8; 56];
            assert_eq!(bytes_hex(&b56), format!("b838{}", "aa".repeat(56)));
            let b256 = [0xaau8; 256];
            assert_eq!(bytes_hex(&b256), format!("b90100{}", "aa".repeat(256)));
        }

        #[test]
        fn unsigned_integers() {
            assert_eq!(uint_hex(0), "80");
            assert_eq!(uint_hex(1), "01");
            assert_eq!(uint_hex(127), "7f");
            assert_eq!(uint_hex(128), "8180");
            assert_eq!(uint_hex(256), "820100");
            assert_eq!(uint_hex(84_532), "83014a34");
            assert_eq!(uint_hex(u128::MAX), format!("90{}", "ff".repeat(16)));
        }

        #[test]
        fn lists() {
            let mut out = Vec::new();
            encode_list(&mut out, &[]);
            assert_eq!(encode_hex(&out), "c0");
            let mut out = Vec::new();
            encode_list(&mut out, &[0x01; 55]);
            assert_eq!(out[0], 0xf7);
            let mut out = Vec::new();
            encode_list(&mut out, &[0x01; 56]);
            assert_eq!(&out[..2], &[0xf8, 56]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::order::{EvmAddress, check_evm_transfer};
    use crate::util::testing::recover_evm_address;
    use crate::util::{decode_hex, encode_hex_0x};
    use serde_json::Value as Json;

    const EVM_VECTORS: &str = include_str!("../../../offchain/test/vectors/evm_transfers.json");

    fn str_of<'a>(v: &'a Json, key: &str) -> &'a str {
        v[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} is a string"))
    }

    fn num_of<T: core::str::FromStr>(v: &Json, key: &str) -> T {
        str_of(v, key)
            .parse()
            .unwrap_or_else(|_| panic!("{key} is a decimal string"))
    }

    /// Test-only RLP reader: splits the item at the start of `input` into
    /// (header length, payload length, is_list).
    fn rlp_header(input: &[u8]) -> (usize, usize, bool) {
        let be = |bytes: &[u8]| {
            bytes
                .iter()
                .fold(0usize, |acc, &b| (acc << 8) | usize::from(b))
        };
        match input[0] {
            0x00..=0x7f => (0, 1, false),
            b @ 0x80..=0xb7 => (1, usize::from(b - 0x80), false),
            b @ 0xb8..=0xbf => {
                let n = usize::from(b - 0xb7);
                (1 + n, be(&input[1..=n]), false)
            }
            b @ 0xc0..=0xf7 => (1, usize::from(b - 0xc0), true),
            b @ 0xf8..=0xff => {
                let n = usize::from(b - 0xf7);
                (1 + n, be(&input[1..=n]), true)
            }
        }
    }

    /// Splits a list payload into its raw (still encoded) items.
    fn rlp_items(mut payload: &[u8]) -> Vec<&[u8]> {
        let mut items = Vec::new();
        while !payload.is_empty() {
            let (header, len, _) = rlp_header(payload);
            items.push(&payload[..header + len]);
            payload = &payload[header + len..];
        }
        items
    }

    /// Payload of a list item that spans the whole of `encoded`.
    fn rlp_list_payload(encoded: &[u8]) -> &[u8] {
        let (header, len, is_list) = rlp_header(encoded);
        assert!(is_list);
        assert_eq!(header + len, encoded.len(), "single list");
        &encoded[header..]
    }

    /// Content bytes of a string item.
    fn rlp_string(item: &[u8]) -> &[u8] {
        let (header, len, is_list) = rlp_header(item);
        assert!(!is_list);
        &item[header..header + len]
    }

    fn transfer_from(v: &Json) -> Erc20Transfer {
        let request = &v["request"];
        assert_eq!(str_of(request, "token"), "USDC");
        let to = check_evm_transfer(
            str_of(request, "to"),
            num_of(request, "amount"),
            num_of(request, "gas_limit"),
            num_of(request, "max_fee_per_gas"),
            num_of(request, "max_priority_fee_per_gas"),
        )
        .expect("vector is within the EVM bounds");
        let token = EvmAddress::parse(str_of(v, "token_address")).expect("token address");
        Erc20Transfer {
            token: *token.as_bytes(),
            to: *to.as_bytes(),
            amount: num_of(request, "amount"),
            nonce: num_of(request, "nonce"),
            max_priority_fee_per_gas: num_of(request, "max_priority_fee_per_gas"),
            max_fee_per_gas: num_of(request, "max_fee_per_gas"),
            gas_limit: num_of(request, "gas_limit"),
        }
    }

    #[test]
    fn transfer_vectors_match_viem() {
        let doc: Json = serde_json::from_str(EVM_VECTORS).expect("vector file is JSON");
        assert_eq!(doc["meta"]["chain_id"], Json::from(BASE_SEPOLIA_CHAIN_ID));
        let vectors = doc["vectors"].as_array().expect("vectors array");
        assert_eq!(vectors.len(), 5);

        for v in vectors {
            let name = str_of(v, "name");
            assert_eq!(v["chain_id"], Json::from(BASE_SEPOLIA_CHAIN_ID), "{name}");
            let transfer = transfer_from(v);
            let payload = build_transfer(&transfer);

            assert_eq!(
                encode_hex_0x(&transfer_calldata(&transfer.to, transfer.amount)),
                str_of(v, "data"),
                "{name}: calldata"
            );
            assert_eq!(
                encode_hex_0x(&payload.unsigned_tx),
                str_of(v, "unsigned_tx"),
                "{name}: unsigned tx"
            );
            assert_eq!(
                encode_hex_0x(&payload.payload_hash),
                str_of(v, "payload_hash"),
                "{name}: payload hash"
            );

            // The signed tx carries the same 9 fields followed by (yParity, r, s); its signature
            // must recover to the vector signer from our hash.
            let signed = decode_hex(str_of(v, "signed_tx")).expect("signed tx hex");
            assert_eq!(signed[0], EIP1559_TX_TYPE, "{name}");
            let signed_items = rlp_items(rlp_list_payload(&signed[1..]));
            let unsigned_items = rlp_items(rlp_list_payload(&payload.unsigned_tx[1..]));
            assert_eq!(unsigned_items.len(), 9, "{name}");
            assert_eq!(signed_items.len(), 12, "{name}");
            assert_eq!(
                &signed_items[..9],
                &unsigned_items[..],
                "{name}: same fields"
            );

            let y_parity = match rlp_string(signed_items[9]) {
                [] => 0,
                [1] => 1,
                other => panic!("{name}: bad yParity {other:?}"),
            };
            // r and s are minimal big-endian integers: left-pad to 32 bytes.
            let pad = |bytes: &[u8]| {
                let mut word = [0u8; 32];
                word[32 - bytes.len()..].copy_from_slice(bytes);
                word
            };
            let r = pad(rlp_string(signed_items[10]));
            let s = pad(rlp_string(signed_items[11]));
            assert_eq!(
                recover_evm_address(&payload.payload_hash, &r, &s, y_parity),
                str_of(v, "signer"),
                "{name}: signature recovers"
            );
        }
    }

    #[test]
    fn chain_id_is_always_base_sepolia() {
        let transfer = Erc20Transfer {
            token: [0x11; 20],
            to: [0x22; 20],
            amount: 1,
            nonce: 0,
            max_priority_fee_per_gas: 0,
            max_fee_per_gas: 0,
            gas_limit: 21_000,
        };
        let tx = unsigned_tx(&transfer);
        assert_eq!(tx[0], EIP1559_TX_TYPE);
        let items = rlp_items(rlp_list_payload(&tx[1..]));
        assert_eq!(items[0], &[0x83, 0x01, 0x4a, 0x34], "chain id 84532");
        assert_eq!(items[6], &[0x80], "value 0");
        assert_eq!(items[8], &[0xc0], "empty access list");
    }

    #[test]
    fn every_field_changes_the_hash() {
        let base = Erc20Transfer {
            token: [0x11; 20],
            to: [0x22; 20],
            amount: 1_000_000,
            nonce: 5,
            max_priority_fee_per_gas: 1,
            max_fee_per_gas: 2,
            gas_limit: 65_000,
        };
        let reference = build_transfer(&base).payload_hash;
        let variants = [
            Erc20Transfer {
                token: [0x12; 20],
                ..base
            },
            Erc20Transfer {
                to: [0x23; 20],
                ..base
            },
            Erc20Transfer {
                amount: 1_000_001,
                ..base
            },
            Erc20Transfer { nonce: 6, ..base },
            Erc20Transfer {
                max_priority_fee_per_gas: 2,
                ..base
            },
            Erc20Transfer {
                max_fee_per_gas: 3,
                ..base
            },
            Erc20Transfer {
                gas_limit: 65_001,
                ..base
            },
        ];
        for variant in &variants {
            assert_ne!(
                build_transfer(variant).payload_hash,
                reference,
                "{variant:?}"
            );
        }
    }

    #[test]
    fn transfer_selector_is_keccak_of_signature() {
        let hash = env::keccak256_array(b"transfer(address,uint256)");
        assert_eq!(&hash[..4], &ERC20_TRANSFER_SELECTOR);
    }
}
