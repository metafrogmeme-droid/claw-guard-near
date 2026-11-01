// verify-sig logic: recover the signer of a receipt's payload_hash and compare it with
// the address derived for (claw-guard contract, derivation path).
//
// Two independent checks, both fail closed:
//  1. binding: payload_hash is recomputed from the receipt's signed_body
//     (HL: EIP-712 phantom-agent digest; Base: keccak256 of the unsigned tx);
//  2. signer: ecrecover(payload_hash, r, s, v) must equal the expected address.
// Only a Signed receipt is checked. A receipt that by design has no signature (Blocked,
// SignFailed, PendingSignature) is reported as such, never as MATCH (verifySigReport).
import { type Hex, keccak256, pad, recoverAddress } from "viem";
import { hlDigestOfSignedBody } from "./hl.js";
import type { Receipt, ReceiptStatus, Sig } from "./types.js";

export type VerifyOutcome =
  | { match: true; recovered: Hex; line: string }
  | { match: false; recovered: Hex | null; expected: Hex; reason: string; line: string };

/** v as y-parity: HL uses 27/28, EIP-1559 uses 0/1. Anything else is invalid. */
export function sigYParity(sig: Sig): 0 | 1 {
  if (sig.v === 0 || sig.v === 27) return 0;
  if (sig.v === 1 || sig.v === 28) return 1;
  throw new Error(`invalid signature v=${sig.v}`);
}

function isHex32(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * r/s as a 32-byte word. Contract receipts always carry 64 hex digits; the HL
 * Python SDK prints them without leading zeros, so shorter values are padded.
 */
function scalarWord(value: string, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error(`${name} must be 0x + up to 64 hex digits`);
  return pad(value as Hex, { size: 32 });
}

/** ecrecover over a 32-byte hash. Returns the lowercase address. */
export async function recoverSigner(payloadHash: string, sig: Sig): Promise<Hex> {
  if (!isHex32(payloadHash)) throw new Error("payload hash must be 0x + 64 hex");
  const address = await recoverAddress({
    hash: payloadHash,
    signature: { r: scalarWord(sig.r, "r"), s: scalarWord(sig.s, "s"), yParity: sigYParity(sig) },
  });
  return address.toLowerCase() as Hex;
}

function mismatch(expected: Hex, recovered: Hex | null, reason: string): VerifyOutcome {
  return { match: false, recovered, expected, reason, line: `MISMATCH ${reason}` };
}

/** "MATCH 0x…" when the signature over payloadHash recovers to `expected`, else "MISMATCH …". */
export async function verifySignature(payloadHash: string, sig: Sig, expected: string): Promise<VerifyOutcome> {
  const want = expected.toLowerCase() as Hex;
  let recovered: Hex;
  try {
    recovered = await recoverSigner(payloadHash, sig);
  } catch (err) {
    return mismatch(want, null, `(signature does not recover: ${err instanceof Error ? err.message : String(err)})`);
  }
  if (recovered !== want) return mismatch(want, recovered, `(recovered ${recovered}, expected ${want})`);
  return { match: true, recovered, line: `MATCH ${recovered}` };
}

/**
 * The payload hash implied by the receipt's signed_body, computed off-chain
 * exactly like the contract does. Throws if the receipt has no signed body or
 * its body cannot be parsed.
 */
export function recomputePayloadHash(receipt: Receipt): Hex {
  const body = receipt.signed_body;
  if (body === null) throw new Error(`receipt #${receipt.id} has no signed body`);
  const order = receipt.proposal.order;
  if (receipt.target === "HlTestnet") {
    const nonce = "HlOrder" in order ? order.HlOrder.nonce_ms : "HlUpdateLeverage" in order ? order.HlUpdateLeverage.nonce_ms : null;
    if (nonce === null) throw new Error(`receipt #${receipt.id}: HlTestnet receipt without a Hyperliquid order`);
    return hlDigestOfSignedBody(body, BigInt(nonce));
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(body)) throw new Error(`receipt #${receipt.id}: signed body is not hex`);
  return keccak256(body as Hex);
}

/**
 * Full verify-sig for one receipt: binding check, then signer check. Strict: anything but a
 * complete Signed receipt is a MISMATCH (the CLI decides first with verifySigStep).
 */
export async function verifyReceipt(receipt: Receipt, expectedSigner: string): Promise<VerifyOutcome> {
  const want = expectedSigner.toLowerCase() as Hex;
  if (receipt.status !== "Signed" || receipt.signature === null || receipt.payload_hash === null) {
    return mismatch(want, null, `(receipt #${receipt.id} is ${receipt.status}, no signature to check)`);
  }
  let recomputed: Hex;
  try {
    recomputed = recomputePayloadHash(receipt);
  } catch (err) {
    return mismatch(want, null, `(${err instanceof Error ? err.message : String(err)})`);
  }
  if (recomputed.toLowerCase() !== receipt.payload_hash.toLowerCase()) {
    return mismatch(want, null, `(payload_hash ${receipt.payload_hash} does not match the signed body ${recomputed})`);
  }
  return verifySignature(receipt.payload_hash, receipt.signature, want);
}

// ---------------------------------------------------------------------------
// verify-sig CLI decision (owner request after the 31 Oct 2026 testnet rerun)
// ---------------------------------------------------------------------------

/**
 * What verify-sig prints for a receipt that by design carries no signature. None of these is a
 * failure (exit 0), and none ever says MATCH: a blocked order is never signed, a failed signature
 * request leaves no signature, and a pending one has none yet.
 */
export const NO_SIGNATURE_LINES: Readonly<Record<Exclude<ReceiptStatus, "Signed">, string>> = {
  Blocked: "no signature (blocked)",
  SignFailed: "no signature (signature request failed)",
  PendingSignature: "no signature yet (pending)",
};

/** A finished verify-sig answer: the one line to print and the exit code. */
export interface VerifySigReport {
  line: string;
  exitCode: 0 | 1;
}

/**
 * verify-sig's first step, decided from the receipt alone (pure: no network, no clock).
 *  - no receipt: `receipt #<id> not found on <contract>`, exit 1;
 *  - Blocked / SignFailed / PendingSignature without a signature: the NO_SIGNATURE_LINES line, exit 0;
 *  - Blocked / SignFailed / PendingSignature that still carries a signature (the contract never
 *    stores one there): MISMATCH, exit 1, so "no signature" is never printed over a signature;
 *  - Signed without a derivation path, signature or payload hash: MISMATCH, exit 1;
 *  - a complete Signed receipt: `check` (derive the address for `path`, then verifyReceipt).
 */
export type VerifySigStep = ({ kind: "report" } & VerifySigReport) | { kind: "check"; receipt: Receipt; path: string };

export function verifySigStep(id: string, contractId: string, receipt: Receipt | null): VerifySigStep {
  if (receipt === null) return { kind: "report", line: `receipt #${id} not found on ${contractId}`, exitCode: 1 };
  if (receipt.status !== "Signed") {
    // parseReceipt accepts only the four statuses; anything else still fails closed here.
    const status: string = receipt.status;
    if (!Object.hasOwn(NO_SIGNATURE_LINES, status)) {
      return { kind: "report", line: `MISMATCH (receipt #${id} has unknown status ${status})`, exitCode: 1 };
    }
    // Fail closed on a contradictory receipt: "no signature" must be true of what the view returned.
    if (receipt.signature !== null) {
      return { kind: "report", line: `MISMATCH (receipt #${id} is ${status} but carries a signature)`, exitCode: 1 };
    }
    return { kind: "report", line: NO_SIGNATURE_LINES[receipt.status], exitCode: 0 };
  }
  const missing = [
    receipt.derivation_path === null ? "derivation path" : null,
    receipt.signature === null ? "signature" : null,
    receipt.payload_hash === null ? "payload hash" : null,
  ].filter((part): part is string => part !== null);
  if (receipt.derivation_path === null || missing.length > 0) {
    return { kind: "report", line: `MISMATCH (receipt #${id} is Signed but has no ${missing.join(", ")})`, exitCode: 1 };
  }
  return { kind: "check", receipt, path: receipt.derivation_path };
}

/**
 * The whole verify-sig answer for one receipt. `deriveSigner(path)` returns the address derived
 * for (claw-guard contract, path); it is called only for a complete Signed receipt, which then
 * gets the strict check: MATCH (exit 0) or MISMATCH (exit 1).
 */
export async function verifySigReport(
  id: string,
  contractId: string,
  receipt: Receipt | null,
  deriveSigner: (path: string) => Promise<string>,
): Promise<VerifySigReport> {
  const step = verifySigStep(id, contractId, receipt);
  if (step.kind === "report") return { line: step.line, exitCode: step.exitCode };
  const outcome = await verifyReceipt(step.receipt, await deriveSigner(step.path));
  return { line: outcome.line, exitCode: outcome.match ? 0 : 1 };
}
