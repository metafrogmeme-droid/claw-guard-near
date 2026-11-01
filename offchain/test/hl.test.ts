// Hyperliquid testnet payloads must hash exactly like hyperliquid-python-sdk 0.24.0.
import { type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  HL_TESTNET_SOURCE,
  approveAgentAction,
  approveAgentDigest,
  buildApproveAgentRequest,
  hlActionHash,
  hlDigestOfSignedBody,
  hlL1Digest,
} from "../src/hl.js";
import { hlLeverage, hlOrders, loadVectors } from "./helpers.js";

interface ApproveVector {
  name: string;
  request: { agent_address: string; agent_name: string; nonce_ms: string };
  action: Record<string, unknown>;
  digest: string;
  signer: string;
  signature: { r: string; s: string; v: number };
}

describe("L1 action digest (order, updateLeverage)", () => {
  it("source is the testnet one", () => {
    expect(HL_TESTNET_SOURCE).toBe("b");
  });

  it.each([...hlOrders(), ...hlLeverage()])("$name", (v) => {
    const action: unknown = JSON.parse(v.action_json);
    const nonce = BigInt(v.nonce_ms);
    expect(hlActionHash(action, nonce)).toBe(v.connection_id);
    expect(hlL1Digest(action, nonce)).toBe(v.digest);
    expect(hlDigestOfSignedBody(v.action_json, nonce)).toBe(v.digest);
  });

  it("changing any field or the nonce changes the digest", () => {
    const v = hlOrders()[0];
    if (v === undefined) throw new Error("no vectors");
    const nonce = BigInt(v.nonce_ms);
    expect(hlDigestOfSignedBody(v.action_json.replace('"p":"1000"', '"p":"1001"'), nonce)).not.toBe(v.digest);
    expect(hlDigestOfSignedBody(v.action_json, nonce + 1n)).not.toBe(v.digest);
  });

  it("rejects nonces outside u64", () => {
    expect(() => hlActionHash({}, -1n)).toThrow(RangeError);
    expect(() => hlActionHash({}, 1n << 64n)).toThrow(RangeError);
  });
});

describe("approveAgent (user-signed, Testnet, signatureChainId 0x66eee)", () => {
  const { vectors } = loadVectors<ApproveVector>("hl_approve_agent.json");
  // Same public-label test key as the SDK vectors; worthless.
  const testAccount = privateKeyToAccount(keccak256(toBytes("clawguard-test-vectors-only")));

  it.each(vectors)("$name", async (v) => {
    const action = approveAgentAction(v.request.agent_address, v.request.agent_name, Number(v.request.nonce_ms));
    expect(action).toEqual(v.action);
    expect(Object.keys(action)).toEqual(Object.keys(v.action)); // same key order as the SDK posts
    expect(approveAgentDigest(action)).toBe(v.digest);

    expect(testAccount.address.toLowerCase()).toBe(v.signer);
    const request = await buildApproveAgentRequest(action, (td) => testAccount.signTypedData(td));
    expect(BigInt(request.signature.r)).toBe(BigInt(v.signature.r));
    expect(BigInt(request.signature.s)).toBe(BigInt(v.signature.s));
    expect(request.signature.v).toBe(v.signature.v);
    expect(request).toMatchObject({ nonce: action.nonce, vaultAddress: null, expiresAfter: null });
  });

  it("always targets the Hyperliquid testnet", () => {
    const action = approveAgentAction("0x" + "ab".repeat(20), "clawguard", 1);
    expect(action.hyperliquidChain).toBe("Testnet");
    expect(action.signatureChainId).toBe("0x66eee");
  });

  it("rejects bad nonces and addresses", () => {
    expect(() => approveAgentAction("0x" + "ab".repeat(20), "x", 0)).toThrow(RangeError);
    expect(() => approveAgentAction("0x1234", "x", 1)).toThrow();
  });

  it("signer callback receives the typed data and the key never enters hl.ts", async () => {
    const action = approveAgentAction("0x" + "cd".repeat(20), "clawguard", 1793318400000);
    let seen: unknown;
    await buildApproveAgentRequest(action, (td) => {
      seen = td;
      return testAccount.signTypedData(td);
    });
    expect(seen).toMatchObject({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66eee },
      primaryType: "HyperliquidTransaction:ApproveAgent",
    });
    const digest: Hex = approveAgentDigest(action);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
