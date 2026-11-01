// Hyperliquid testnet signing payloads, reimplemented from hyperliquid-python-sdk 0.24.0
// (utils/signing.py: action_hash, construct_phantom_agent, l1_payload, sign_agent).
//
// Testnet only: the phantom-agent source is the constant "b" and approveAgent is
// built for hyperliquidChain "Testnet". There is no parameter that switches either.
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { type Hex, getAddress, hashTypedData, keccak256, parseSignature, zeroAddress } from "viem";

/** Phantom-agent source: "a" is mainnet, "b" is testnet. Only "b" exists here. */
export const HL_TESTNET_SOURCE = "b";
export const HL_TESTNET_CHAIN = "Testnet";
/** Chain id the user-signed EIP-712 domain uses (the SDK's fixed 0x66eee). */
export const HL_SIGNATURE_CHAIN_ID = "0x66eee";

const L1_DOMAIN = { name: "Exchange", version: "1", chainId: 1337, verifyingContract: zeroAddress } as const;
const L1_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

/**
 * connectionId = keccak256(msgpack(action) ‖ nonce (8 bytes BE) ‖ 0x00).
 * The trailing 0x00 means "no vault"; expiresAfter is never set.
 * `action` must keep the canonical key order (JSON.parse preserves it).
 */
export function hlActionHash(action: unknown, nonceMs: bigint): Hex {
  if (nonceMs < 0n || nonceMs > 0xffff_ffff_ffff_ffffn) throw new RangeError("nonce must be a u64");
  const packed = msgpackEncode(action);
  const buf = new Uint8Array(packed.length + 9);
  buf.set(packed, 0);
  new DataView(buf.buffer).setBigUint64(packed.length, nonceMs, false);
  buf[packed.length + 8] = 0x00;
  return keccak256(buf);
}

/** EIP-712 digest of the testnet phantom agent for `action` (what the MPC signs). */
export function hlL1Digest(action: unknown, nonceMs: bigint): Hex {
  return hashTypedData({
    domain: L1_DOMAIN,
    types: L1_TYPES,
    primaryType: "Agent",
    message: { source: HL_TESTNET_SOURCE, connectionId: hlActionHash(action, nonceMs) },
  });
}

/** Digest of a receipt's canonical action JSON (`signed_body`). */
export function hlDigestOfSignedBody(signedBody: string, nonceMs: bigint): Hex {
  return hlL1Digest(JSON.parse(signedBody) as unknown, nonceMs);
}

// ---------------------------------------------------------------------------
// approveAgent (user-signed action; run once by the owner with the testnet master key)
// ---------------------------------------------------------------------------

const APPROVE_AGENT_PRIMARY_TYPE = "HyperliquidTransaction:ApproveAgent";
const APPROVE_AGENT_TYPES = {
  [APPROVE_AGENT_PRIMARY_TYPE]: [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export interface ApproveAgentAction {
  type: "approveAgent";
  agentAddress: string;
  agentName: string;
  nonce: number;
  signatureChainId: typeof HL_SIGNATURE_CHAIN_ID;
  hyperliquidChain: typeof HL_TESTNET_CHAIN;
}

/** The approveAgent action exactly as the SDK posts it (key order included). */
export function approveAgentAction(agentAddress: string, agentName: string, nonceMs: number): ApproveAgentAction {
  if (!Number.isSafeInteger(nonceMs) || nonceMs <= 0) throw new RangeError("nonce must be a positive ms timestamp");
  return {
    type: "approveAgent",
    agentAddress: getAddress(agentAddress),
    agentName,
    nonce: nonceMs,
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
    hyperliquidChain: HL_TESTNET_CHAIN,
  };
}

/** EIP-712 typed data the master key signs for approveAgent. */
export function approveAgentTypedData(action: ApproveAgentAction) {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number.parseInt(action.signatureChainId, 16),
      verifyingContract: zeroAddress,
    },
    types: APPROVE_AGENT_TYPES,
    primaryType: APPROVE_AGENT_PRIMARY_TYPE,
    message: {
      hyperliquidChain: action.hyperliquidChain,
      agentAddress: action.agentAddress as Hex,
      agentName: action.agentName,
      nonce: BigInt(action.nonce),
    },
  } as const;
}

export function approveAgentDigest(action: ApproveAgentAction): Hex {
  return hashTypedData(approveAgentTypedData(action));
}

/** Signs EIP-712 typed data and returns a 65-byte hex signature (e.g. a viem LocalAccount's signTypedData). */
export type ApproveAgentSigner = (typedData: ReturnType<typeof approveAgentTypedData>) => Promise<Hex>;

export interface ApproveAgentRequest {
  action: ApproveAgentAction;
  nonce: number;
  signature: { r: Hex; s: Hex; v: number };
  vaultAddress: null;
  expiresAfter: null;
}

/**
 * The /exchange body for approveAgent. The key stays with the caller: this
 * function only receives a signing callback.
 */
export async function buildApproveAgentRequest(action: ApproveAgentAction, sign: ApproveAgentSigner): Promise<ApproveAgentRequest> {
  const sig = parseSignature(await sign(approveAgentTypedData(action)));
  const yParity = sig.yParity ?? (sig.v === 28n ? 1 : 0);
  return {
    action,
    nonce: action.nonce,
    signature: { r: sig.r, s: sig.s, v: 27 + yParity },
    vaultAddress: null,
    expiresAfter: null,
  };
}
