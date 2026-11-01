// Derived addresses: sandbox mock-mpc formula (viem vectors) and testnet MPC math
// (chainsig.js 1.1.16 vectors), plus the online MPC-view path with a mocked provider.
import { baseEncode, type Provider } from "near-api-js";
import { keccak256, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { MainnetRefusedError } from "../src/config.js";
import {
  TESTNET_MPC_ROOT_PUBLIC_KEY,
  deriveAddress,
  deriveMpcPublicKey,
  mpcDerivedAddress,
  mpcTweak,
  parseSecp256k1PublicKey,
  publicKeyToEvmAddress,
  sandboxDerivedAddress,
  sandboxDerivedPublicKey,
  sandboxSecretKey,
} from "../src/derive.js";
import { loadVectors } from "./helpers.js";

interface SandboxVector {
  predecessor: string;
  path: string;
  preimage: string;
  uncompressed_pk: string;
  evm_address: string;
}
interface MpcVector {
  predecessor: string;
  path: string;
  tweak: string;
  derived_pk_uncompressed: string;
  evm_address: string;
}

const sandbox = loadVectors<SandboxVector>("derive_sandbox.json");
const mpc = loadVectors<MpcVector>("derive_mpc.json");

describe("sandbox mock-mpc derivation", () => {
  it.each(sandbox.vectors)("$predecessor / $path", (v) => {
    // Independent re-computation with viem, from the public preimage.
    expect(toHex(sandboxSecretKey(v.predecessor, v.path))).toBe(keccak256(toBytes(v.preimage)));
    expect(privateKeyToAccount(keccak256(toBytes(v.preimage))).address.toLowerCase()).toBe(v.evm_address);
    expect(toHex(sandboxDerivedPublicKey(v.predecessor, v.path))).toBe(v.uncompressed_pk);
    expect(sandboxDerivedAddress(v.predecessor, v.path)).toBe(v.evm_address);
  });

  it("the agent account derives a different address than the contract", () => {
    expect(sandboxDerivedAddress("agent-1.test.near", "hl-testnet-1")).not.toBe(
      sandboxDerivedAddress("clawguard.test.near", "hl-testnet-1"),
    );
  });
});

describe("testnet MPC derivation (cross-checked with chainsig.js 1.1.16)", () => {
  it("uses the documented testnet root key", () => {
    expect(TESTNET_MPC_ROOT_PUBLIC_KEY).toBe(mpc.meta.root_pk);
    expect(toHex(parseSecp256k1PublicKey(TESTNET_MPC_ROOT_PUBLIC_KEY))).toBe(mpc.meta.root_pk_uncompressed);
    expect(mpc.meta.mpc_contract_id).toBe("v1.signer-prod.testnet");
  });

  it.each(mpc.vectors)("$predecessor / $path", (v) => {
    expect(`0x${mpcTweak(v.predecessor, v.path).toString(16).padStart(64, "0")}`).toBe(v.tweak);
    expect(toHex(deriveMpcPublicKey(TESTNET_MPC_ROOT_PUBLIC_KEY, v.predecessor, v.path))).toBe(v.derived_pk_uncompressed);
    expect(mpcDerivedAddress(v.predecessor, v.path)).toBe(v.evm_address);
  });

  it("accepts hex and compressed root keys and rejects off-curve points", () => {
    const uncompressed = parseSecp256k1PublicKey(TESTNET_MPC_ROOT_PUBLIC_KEY);
    expect(parseSecp256k1PublicKey(toHex(uncompressed))).toEqual(uncompressed);
    const compressed = new Uint8Array([2 + ((uncompressed[64] ?? 0) & 1), ...uncompressed.subarray(1, 33)]);
    expect(parseSecp256k1PublicKey(toHex(compressed))).toEqual(uncompressed);
    const offCurve = uncompressed.slice();
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    expect(() => parseSecp256k1PublicKey(toHex(offCurve))).toThrow();
    expect(() => publicKeyToEvmAddress(compressed)).toThrow(/65-byte/);
  });
});

describe("deriveAddress", () => {
  const first = mpc.vectors[0] as MpcVector;
  const contractId = first.predecessor;

  /** A provider whose derived_public_key view returns `xy` (64 bytes) in NEAR's base58 form. */
  const viewProvider = (xy: Uint8Array) => {
    const callFunction = vi.fn(() => Promise.resolve(`secp256k1:${baseEncode(xy)}`));
    return { provider: { callFunction } as unknown as Provider, callFunction };
  };

  it("sandbox: mock-mpc formula with the contract as predecessor", async () => {
    await expect(deriveAddress({ network: "sandbox", contractId: "clawguard.test.near", path: "hl-testnet-1" })).resolves.toEqual({
      address: (sandbox.vectors[0] as SandboxVector).evm_address,
      source: "sandbox-mock-mpc",
    });
  });

  it("testnet offline: local math", async () => {
    await expect(deriveAddress({ network: "testnet", contractId, path: first.path })).resolves.toEqual({
      address: first.evm_address,
      source: "local-math",
    });
  });

  it("testnet online: asks the MPC view and reports agreement", async () => {
    const xy = toBytes(first.derived_pk_uncompressed).subarray(1);
    const { provider, callFunction } = viewProvider(xy);
    const res = await deriveAddress({ network: "testnet", contractId, path: first.path, provider });
    expect(res).toEqual({ address: first.evm_address, source: "mpc-view", localMathAgrees: true });
    expect(callFunction).toHaveBeenCalledWith({
      contractId: "v1.signer-prod.testnet",
      method: "derived_public_key",
      args: { path: first.path, predecessor: contractId, domain_id: 0 },
    });
  });

  it("testnet online: the MPC view value wins when the local root key is stale", async () => {
    const other = mpc.vectors[1] as MpcVector;
    const { provider } = viewProvider(toBytes(other.derived_pk_uncompressed).subarray(1));
    const res = await deriveAddress({ network: "testnet", contractId, path: first.path, provider });
    expect(res).toEqual({ address: other.evm_address, source: "mpc-view", localMathAgrees: false });
  });

  it("refuses mainnet ids", async () => {
    await expect(deriveAddress({ network: "testnet", contractId: "clawguard.near", path: "hl-testnet-1" })).rejects.toThrow(
      MainnetRefusedError,
    );
    const { provider, callFunction } = viewProvider(new Uint8Array(64));
    await expect(
      deriveAddress({ network: "testnet", contractId, path: "hl-testnet-1", provider, mpcContractId: "v1.signer" }),
    ).rejects.toThrow(MainnetRefusedError);
    expect(callFunction).not.toHaveBeenCalled();
  });
});
