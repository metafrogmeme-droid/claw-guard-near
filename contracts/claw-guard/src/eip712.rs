//! EIP-712 digest of a Hyperliquid L1 action ("phantom agent"), testnet only.
//!
//! Mirrors `construct_phantom_agent` + `l1_payload` of hyperliquid-python-sdk 0.24.0:
//!
//! ```text
//! domain  = EIP712Domain{name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0}
//! message = Agent{source:"b", connectionId}
//! digest  = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(message))
//! ```
//!
//! The phantom-agent source is the compile-time constant `"b"` (Hyperliquid testnet). No function
//! takes a source parameter, so this crate cannot produce a digest for source `"a"` (mainnet).

use near_sdk::env;

/// Phantom-agent source for Hyperliquid **testnet**. Fixed at compile time.
pub const PHANTOM_AGENT_SOURCE: &str = "b";
/// EIP-712 domain of Hyperliquid L1 actions (the same on testnet and mainnet; the source
/// field is what separates them).
pub const DOMAIN_NAME: &str = "Exchange";
pub const DOMAIN_VERSION: &str = "1";
pub const DOMAIN_CHAIN_ID: u64 = 1337;
pub const DOMAIN_VERIFYING_CONTRACT: [u8; 20] = [0u8; 20];

const EIP712_DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const AGENT_TYPE: &str = "Agent(string source,bytes32 connectionId)";

/// `hashStruct(EIP712Domain{...})` for the Hyperliquid "Exchange" domain.
pub fn domain_separator() -> [u8; 32] {
    let mut encoded = Vec::with_capacity(5 * 32);
    encoded.extend_from_slice(&env::keccak256_array(EIP712_DOMAIN_TYPE));
    encoded.extend_from_slice(&env::keccak256_array(DOMAIN_NAME));
    encoded.extend_from_slice(&env::keccak256_array(DOMAIN_VERSION));
    encoded.extend_from_slice(&uint256_word(DOMAIN_CHAIN_ID));
    encoded.extend_from_slice(&address_word(&DOMAIN_VERIFYING_CONTRACT));
    env::keccak256_array(&encoded)
}

/// `hashStruct(Agent{source:"b", connectionId})`.
pub fn agent_struct_hash(connection_id: &[u8; 32]) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(3 * 32);
    encoded.extend_from_slice(&env::keccak256_array(AGENT_TYPE));
    encoded.extend_from_slice(&env::keccak256_array(PHANTOM_AGENT_SOURCE));
    encoded.extend_from_slice(connection_id);
    env::keccak256_array(&encoded)
}

/// The digest the HL testnet signer signs for an L1 action with this `connection_id`.
pub fn l1_digest(connection_id: &[u8; 32]) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(2 + 2 * 32);
    encoded.extend_from_slice(&[0x19, 0x01]);
    encoded.extend_from_slice(&domain_separator());
    encoded.extend_from_slice(&agent_struct_hash(connection_id));
    env::keccak256_array(&encoded)
}

/// ABI word for a `uint256` that fits in `u64`: 24 zero bytes then the value big-endian.
fn uint256_word(value: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

/// ABI word for an `address`: 12 zero bytes then the 20 address bytes.
fn address_word(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::encode_hex;

    // Expected values computed independently with eth_utils.keccak (Python) over the same
    // type strings and domain values.

    #[test]
    fn type_hashes() {
        assert_eq!(
            encode_hex(&env::keccak256_array(EIP712_DOMAIN_TYPE)),
            "8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f"
        );
        assert_eq!(
            encode_hex(&env::keccak256_array(AGENT_TYPE)),
            "26f05c2f7239b6983075e58321292d77b3aa173d19b27257ac96ab362570f508"
        );
    }

    #[test]
    fn hyperliquid_domain_separator() {
        assert_eq!(
            encode_hex(&domain_separator()),
            "d79297fcdf2ffcd4ae223d01edaa2ba214ff8f401d7c9300d995d17c82aa4040"
        );
    }

    #[test]
    fn source_is_testnet() {
        assert_eq!(PHANTOM_AGENT_SOURCE, "b");
    }

    #[test]
    fn words_are_left_padded() {
        let w = uint256_word(1337);
        assert_eq!(&w[..30], &[0u8; 30]);
        assert_eq!(&w[30..], &[0x05, 0x39]);
        let mut address = [0u8; 20];
        address[0] = 0xaa;
        address[19] = 0xbb;
        let w = address_word(&address);
        assert_eq!(&w[..12], &[0u8; 12]);
        assert_eq!(w[12], 0xaa);
        assert_eq!(w[31], 0xbb);
    }

    #[test]
    fn digest_depends_on_connection_id() {
        assert_ne!(l1_digest(&[0u8; 32]), l1_digest(&[1u8; 32]));
    }
}
