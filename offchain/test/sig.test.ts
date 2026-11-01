// verify-sig: HL and EVM vector signatures recover to their signer (MATCH); tampering
// with the hash, body, status or v gives MISMATCH. Includes a sandbox mock-mpc round trip, and the
// CLI decision (verifySigStep / verifySigReport): a receipt that by design has no signature is
// "no signature …" with exit 0, never MATCH; a Signed receipt keeps the strict check.
import { toHex } from "viem";
import { sign } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { sandboxDerivedAddress, sandboxSecretKey } from "../src/derive.js";
import { hlL1Digest } from "../src/hl.js";
import {
  NO_SIGNATURE_LINES,
  recomputePayloadHash,
  recoverSigner,
  sigYParity,
  verifyReceipt,
  verifySigReport,
  verifySigStep,
  verifySignature,
} from "../src/sig.js";
import { RECEIPT_STATUSES, type Receipt } from "../src/types.js";
import { evmReceipt, evmTransfers, evmVectorSig, first, hlLeverage, hlLeverageReceipt, hlOrderReceipt, hlOrders } from "./helpers.js";

/** Flip the last hex digit. */
const tamper = (hex: string): string => hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");

describe("signature recovery against the vectors", () => {
  it.each([...hlOrders(), ...hlLeverage()])("HL $name → MATCH", async (v) => {
    const res = await verifySignature(v.digest, v.signature, v.signer);
    expect(res.match).toBe(true);
    expect(res.line).toBe(`MATCH ${v.signer}`);
  });

  it.each(evmTransfers())("EVM $name → MATCH", async (v) => {
    const res = await verifySignature(v.payload_hash, evmVectorSig(v), v.signer);
    expect(res.line).toBe(`MATCH ${v.signer}`);
  });

  it("a tampered hash → MISMATCH", async () => {
    const hl = first(hlOrders());
    const resHl = await verifySignature(tamper(hl.digest), hl.signature, hl.signer);
    expect(resHl.match).toBe(false);
    expect(resHl.line).toMatch(/^MISMATCH /);

    const evm = first(evmTransfers());
    const resEvm = await verifySignature(tamper(evm.payload_hash), evmVectorSig(evm), evm.signer);
    expect(resEvm.match).toBe(false);
    expect(resEvm.line).toMatch(/^MISMATCH \(recovered 0x[0-9a-f]{40}, expected /);
  });

  it("a different expected address → MISMATCH; expected address case does not matter", async () => {
    const v = first(hlOrders());
    expect((await verifySignature(v.digest, v.signature, `0x${"11".repeat(20)}`)).match).toBe(false);
    expect((await verifySignature(v.digest, v.signature, v.signer.toUpperCase().replace("0X", "0x"))).match).toBe(true);
  });

  it("unrecoverable signatures are a MISMATCH, not a crash", async () => {
    const v = first(hlOrders());
    const res = await verifySignature(v.digest, { ...v.signature, r: `0x${"00".repeat(32)}` }, v.signer);
    expect(res.match).toBe(false);
    expect(res.line).toMatch(/^MISMATCH \(signature does not recover/);
    expect((await verifySignature(v.digest, { ...v.signature, v: 5 }, v.signer)).match).toBe(false);
  });

  it("v: 27/28 (HL) and 0/1 (EIP-1559) are y-parity 0/1; anything else throws", () => {
    expect([27, 28, 0, 1].map((v) => sigYParity({ r: "", s: "", v }))).toEqual([0, 1, 0, 1]);
    expect(() => sigYParity({ r: "", s: "", v: 2 })).toThrow();
  });
});

describe("verifyReceipt (binding + signer)", () => {
  const cases: Array<[string, Receipt, string]> = [
    ["HL order", hlOrderReceipt(first(hlOrders())), first(hlOrders()).signer],
    ["HL updateLeverage", hlLeverageReceipt(first(hlLeverage())), first(hlLeverage()).signer],
    ["EVM transfer", evmReceipt(first(evmTransfers())), first(evmTransfers()).signer],
  ];

  it.each(cases)("%s → MATCH", async (_name, receipt, signer) => {
    expect(recomputePayloadHash(receipt)).toBe(receipt.payload_hash);
    expect((await verifyReceipt(receipt, signer)).line).toBe(`MATCH ${signer}`);
  });

  it.each(cases)("%s with a tampered signed body → MISMATCH", async (_name, receipt, signer) => {
    const body = receipt.signed_body ?? "";
    const tampered =
      receipt.target === "HlTestnet" ? body.replace('"p":"1000"', '"p":"9000"').replace('"leverage":3', '"leverage":9') : tamper(body);
    expect(tampered).not.toBe(body);
    const res = await verifyReceipt({ ...receipt, signed_body: tampered }, signer);
    expect(res.match).toBe(false);
    expect(res.line).toMatch(/does not match the signed body|^MISMATCH/);
  });

  it.each(cases)("%s with a tampered payload_hash → MISMATCH", async (_name, receipt, signer) => {
    const res = await verifyReceipt({ ...receipt, payload_hash: tamper(receipt.payload_hash ?? "") }, signer);
    expect(res.match).toBe(false);
  });

  it("a Blocked receipt has nothing to verify → MISMATCH", async () => {
    const receipt = { ...cases[0]![1], status: "Blocked" as const, signature: null, payload_hash: null, signed_body: null };
    const res = await verifyReceipt(receipt, first(hlOrders()).signer);
    expect(res.line).toBe("MISMATCH (receipt #1 is Blocked, no signature to check)");
  });
});

describe("sandbox round trip (what mock-mpc does)", () => {
  it("a digest signed with the mock-mpc key recovers to the sandbox-derived address", async () => {
    const v = first(hlOrders());
    const digest = hlL1Digest(JSON.parse(v.action_json), BigInt(v.nonce_ms));
    const sk = toHex(sandboxSecretKey("clawguard.test.near", "hl-testnet-1"));
    const sig = await sign({ hash: digest, privateKey: sk });
    const asContract = { r: sig.r, s: sig.s, v: 27 + (sig.yParity ?? 0) };
    const expected = sandboxDerivedAddress("clawguard.test.near", "hl-testnet-1");
    expect(await recoverSigner(digest, asContract)).toBe(expected);
    expect((await verifySignature(digest, asContract, expected)).line).toBe(`MATCH ${expected}`);
    // The agent account's own derived address never matches the contract's signatures.
    const agentAddress = sandboxDerivedAddress("agent-1.test.near", "hl-testnet-1");
    expect((await verifySignature(digest, asContract, agentAddress)).match).toBe(false);
  });
});

describe("verify-sig decision (verifySigStep / verifySigReport)", () => {
  const CONTRACT = "clawguard.test.near";
  const signed = hlOrderReceipt(first(hlOrders()), "7");
  const signer = first(hlOrders()).signer;
  /** A receipt as the contract stores it for each status (Blocked: no path, nothing signed). */
  const withStatus = (status: Receipt["status"]): Receipt =>
    status === "Blocked"
      ? { ...signed, status, rule_code: "MARKET_NOT_ALLOWED", payload_hash: null, signed_body: null, derivation_path: null, signature: null }
      : status === "Signed"
        ? signed
        : { ...signed, status, signature: null }; // PendingSignature / SignFailed keep path, hash and body

  it("covers every receipt status: Signed is checked, every other one has a no-signature line", () => {
    expect(Object.keys(NO_SIGNATURE_LINES).sort()).toEqual(RECEIPT_STATUSES.filter((s) => s !== "Signed").sort());
  });

  it.each([
    ["Blocked", "no signature (blocked)"],
    ["SignFailed", "no signature (signature request failed)"],
    ["PendingSignature", "no signature yet (pending)"],
  ] as const)("%s → %j, exit 0, never MATCH, nothing derived", async (status, line) => {
    const derive = vi.fn(() => Promise.resolve(signer));
    const report = await verifySigReport("6", CONTRACT, withStatus(status), derive);
    expect(report).toEqual({ line, exitCode: 0 });
    expect(report.line).not.toMatch(/MATCH/);
    expect(derive).not.toHaveBeenCalled();
    expect(verifySigStep("6", CONTRACT, withStatus(status))).toEqual({ kind: "report", line, exitCode: 0 });
  });

  it("the 31 Oct 2026 rerun case: a Blocked receipt (#6) no longer prints MISMATCH or exits 1", async () => {
    const report = await verifySigReport("6", CONTRACT, withStatus("Blocked"), () => Promise.resolve(signer));
    expect(report.line).toBe("no signature (blocked)");
    expect(report.exitCode).toBe(0);
  });

  it("a complete Signed receipt → MATCH, exit 0 (the address is derived once, for its path)", async () => {
    const derive = vi.fn(() => Promise.resolve(signer));
    await expect(verifySigReport("7", CONTRACT, signed, derive)).resolves.toEqual({ line: `MATCH ${signer}`, exitCode: 0 });
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledWith("hl-testnet-1");
    expect(verifySigStep("7", CONTRACT, signed)).toEqual({ kind: "check", receipt: signed, path: "hl-testnet-1" });
  });

  it("a Signed receipt whose signer is not the derived address → MISMATCH, exit 1", async () => {
    const report = await verifySigReport("7", CONTRACT, signed, () => Promise.resolve(`0x${"11".repeat(20)}`));
    expect(report.exitCode).toBe(1);
    expect(report.line).toMatch(/^MISMATCH \(recovered 0x[0-9a-f]{40}, expected 0x1{40}\)$/);
  });

  it("a Signed receipt with a tampered signed body or payload hash → MISMATCH, exit 1", async () => {
    const body = (signed.signed_body ?? "").replace('"p":"1000"', '"p":"9000"');
    expect(body).not.toBe(signed.signed_body);
    for (const receipt of [{ ...signed, signed_body: body }, { ...signed, payload_hash: tamper(signed.payload_hash ?? "") }]) {
      const report = await verifySigReport("7", CONTRACT, receipt, () => Promise.resolve(signer));
      expect(report.exitCode).toBe(1);
      expect(report.line).toMatch(/^MISMATCH /);
    }
  });

  it.each([
    ["derivation path", { derivation_path: null }],
    ["signature", { signature: null }],
    ["payload hash", { payload_hash: null }],
    ["derivation path, signature, payload hash", { derivation_path: null, signature: null, payload_hash: null }],
  ] as const)("a Signed receipt without its %s stays MISMATCH, exit 1, nothing derived", async (what, change) => {
    const derive = vi.fn(() => Promise.resolve(signer));
    const report = await verifySigReport("7", CONTRACT, { ...signed, ...change }, derive);
    expect(report).toEqual({ line: `MISMATCH (receipt #7 is Signed but has no ${what})`, exitCode: 1 });
    expect(derive).not.toHaveBeenCalled();
  });

  it("receipt not found → an error line naming the contract, exit 1, never MATCH", async () => {
    const derive = vi.fn(() => Promise.resolve(signer));
    const report = await verifySigReport("99", CONTRACT, null, derive);
    expect(report).toEqual({ line: "receipt #99 not found on clawguard.test.near", exitCode: 1 });
    expect(report.line).not.toMatch(/MATCH/);
    expect(derive).not.toHaveBeenCalled();
  });

  it.each(["Blocked", "SignFailed", "PendingSignature"] as const)(
    "%s that still carries a signature (the contract never stores one there) fails closed: MISMATCH, exit 1, never 'no signature'",
    async (status) => {
      expect(signed.signature).not.toBeNull();
      const derive = vi.fn(() => Promise.resolve(signer));
      const report = await verifySigReport("7", CONTRACT, { ...signed, status }, derive);
      expect(report).toEqual({ line: `MISMATCH (receipt #7 is ${status} but carries a signature)`, exitCode: 1 });
      expect(report.line).not.toMatch(/no signature|^MATCH/);
      expect(derive).not.toHaveBeenCalled();
    },
  );

  it("an unknown status (impossible after parseReceipt) fails closed: MISMATCH, exit 1", () => {
    for (const status of ["Pending", "constructor", "toString"]) {
      const receipt = { ...signed, status } as unknown as Receipt;
      expect(verifySigStep("7", CONTRACT, receipt)).toEqual({
        kind: "report",
        line: `MISMATCH (receipt #7 has unknown status ${status})`,
        exitCode: 1,
      });
    }
  });

  it("a deriveSigner failure is not swallowed (the CLI reports it as an error, exit 1)", async () => {
    await expect(verifySigReport("7", CONTRACT, signed, () => Promise.reject(new Error("rpc down")))).rejects.toThrow("rpc down");
  });
});
