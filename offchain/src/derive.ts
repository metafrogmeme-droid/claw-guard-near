// Derived EVM signer address for (claw-guard contract id, derivation path).
//
// The MPC network derives a separate key for every (predecessor account, path):
// only the claw-guard contract itself can obtain signatures for its addresses.
//
//  - sandbox: the mock-mpc contract signs with
//      sk = keccak256("clawguard-sandbox-only:" ‖ predecessor ‖ "," ‖ path)
//    sandbox test key, worthless, never use anywhere else.
//  - testnet: the real MPC signer (near/mpc kdf.rs):
//      tweak = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" ‖ predecessor ‖ "," ‖ path)
//      derived = root + tweak·G
//    The MPC view `derived_public_key` is preferred when online; the local math
//    is the offline fallback and is cross-checked against chainsig.js 1.1.16
//    (test/vectors/derive_mpc.json).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { baseDecode, type Provider } from "near-api-js";
import { type NearNetwork, TESTNET_MPC_CONTRACT_ID, assertMpcContractId, assertTestnetAccountId } from "./config.js";
import { viewFunction } from "./near.js";

const SANDBOX_KEY_PREFIX = "clawguard-sandbox-only:";
const MPC_TWEAK_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";
/** MPC secp256k1 domain (domain_id 0). */
const SECP256K1_DOMAIN_ID = 0;

/**
 * Root secp256k1 public key of v1.signer-prod.testnet, from chainsig.js 1.1.16
 * `constants.ROOT_PUBLIC_KEYS.TESTNET` (documented there as the contract's
 * `public_key` view). UNVERIFIED by us against the live contract: when online,
 * deriveAddress() asks the MPC contract instead and reports any difference.
 */
export const TESTNET_MPC_ROOT_PUBLIC_KEY =
  "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";

export type Hex = `0x${string}`;

const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** EVM address (lowercase) of an uncompressed SEC1 public key (65 bytes, 0x04 ‖ x ‖ y). */
export function publicKeyToEvmAddress(uncompressed: Uint8Array): Hex {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error("expected a 65-byte uncompressed secp256k1 public key");
  }
  return `0x${bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
}

/**
 * Parse a secp256k1 public key given as NEAR "secp256k1:<base58 x‖y>" or as hex
 * (65-byte uncompressed or 33-byte compressed, with or without 0x). The point is
 * validated to be on the curve. Returns the 65-byte uncompressed form.
 */
export function parseSecp256k1PublicKey(key: string): Uint8Array {
  let bytes: Uint8Array;
  if (key.startsWith("secp256k1:")) {
    const xy = baseDecode(key.slice("secp256k1:".length));
    if (xy.length !== 64) throw new Error("NEAR secp256k1 public key must be 64 bytes (x ‖ y)");
    bytes = new Uint8Array([0x04, ...xy]);
  } else {
    bytes = hexToBytes(strip0x(key));
  }
  return secp256k1.Point.fromBytes(bytes).toBytes(false);
}

// ---------------------------------------------------------------------------
// Sandbox (mock-mpc)
// ---------------------------------------------------------------------------

/**
 * The mock-mpc signing key for (predecessor, path). Sandbox test key, worthless,
 * never use anywhere else: it is derived from public strings by design.
 */
export function sandboxSecretKey(predecessor: string, path: string): Uint8Array {
  const sk = keccak_256(utf8ToBytes(`${SANDBOX_KEY_PREFIX}${predecessor},${path}`));
  if (!secp256k1.utils.isValidSecretKey(sk)) throw new Error("sandbox key is not a valid secp256k1 scalar");
  return sk;
}

export function sandboxDerivedPublicKey(predecessor: string, path: string): Uint8Array {
  return secp256k1.getPublicKey(sandboxSecretKey(predecessor, path), false);
}

export function sandboxDerivedAddress(predecessor: string, path: string): Hex {
  return publicKeyToEvmAddress(sandboxDerivedPublicKey(predecessor, path));
}

// ---------------------------------------------------------------------------
// Testnet (real MPC)
// ---------------------------------------------------------------------------

/** epsilon = sha3_256(prefix ‖ predecessor ‖ "," ‖ path) as a big-endian scalar. */
export function mpcTweak(predecessor: string, path: string): bigint {
  return bytesToBigInt(sha3_256(utf8ToBytes(`${MPC_TWEAK_PREFIX}${predecessor},${path}`)));
}

/**
 * derived = root + tweak·G (uncompressed, 65 bytes). Throws if the tweak is not
 * a valid scalar, like the MPC contract does (probability ~2^-128).
 */
export function deriveMpcPublicKey(rootPublicKey: string, predecessor: string, path: string): Uint8Array {
  const tweak = mpcTweak(predecessor, path);
  if (tweak === 0n || tweak >= CURVE_ORDER) throw new Error("MPC tweak is not a valid secp256k1 scalar");
  const root = secp256k1.Point.fromBytes(parseSecp256k1PublicKey(rootPublicKey));
  const derived = root.add(secp256k1.Point.BASE.multiply(tweak));
  if (derived.is0()) throw new Error("derived MPC key is the point at infinity");
  return derived.toBytes(false);
}

export function mpcDerivedAddress(
  predecessor: string,
  path: string,
  rootPublicKey: string = TESTNET_MPC_ROOT_PUBLIC_KEY,
): Hex {
  return publicKeyToEvmAddress(deriveMpcPublicKey(rootPublicKey, predecessor, path));
}

/** MPC view `derived_public_key({path, predecessor, domain_id: 0})` → uncompressed key. */
export async function fetchMpcDerivedPublicKey(
  provider: Provider,
  mpcContractId: string,
  predecessor: string,
  path: string,
): Promise<Uint8Array> {
  const res = await viewFunction(provider, assertMpcContractId(mpcContractId), "derived_public_key", {
    path,
    predecessor,
    domain_id: SECP256K1_DOMAIN_ID,
  });
  if (typeof res !== "string") throw new Error("derived_public_key did not return a string");
  return parseSecp256k1PublicKey(res);
}

// ---------------------------------------------------------------------------
// One entry point for the CLIs
// ---------------------------------------------------------------------------

export interface DeriveRequest {
  network: NearNetwork;
  /** The claw-guard contract account: it is the MPC predecessor. */
  contractId: string;
  path: string;
  /** Testnet only: ask the MPC contract (preferred). Omit for offline math. */
  provider?: Provider;
  mpcContractId?: string;
}

export interface DerivedAddress {
  address: Hex;
  source: "sandbox-mock-mpc" | "mpc-view" | "local-math";
  /** Testnet with a provider: whether the offline math agrees with the MPC view. */
  localMathAgrees?: boolean;
}

export async function deriveAddress(req: DeriveRequest): Promise<DerivedAddress> {
  assertTestnetAccountId(req.contractId, "contract id");
  if (req.network === "sandbox") {
    return { address: sandboxDerivedAddress(req.contractId, req.path), source: "sandbox-mock-mpc" };
  }
  const local = mpcDerivedAddress(req.contractId, req.path);
  if (req.provider === undefined) return { address: local, source: "local-math" };
  const viewed = publicKeyToEvmAddress(
    await fetchMpcDerivedPublicKey(req.provider, req.mpcContractId ?? TESTNET_MPC_CONTRACT_ID, req.contractId, req.path),
  );
  return { address: viewed, source: "mpc-view", localMathAgrees: viewed === local };
}
