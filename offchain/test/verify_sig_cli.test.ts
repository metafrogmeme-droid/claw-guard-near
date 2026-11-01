// verify-sig CLI (`npm run verify-sig -- --receipt <id>`) end to end on a sandbox
// config, with the contract connection replaced by an in-memory receipt list (no network, no
// sandbox node). Checks the printed line and the exit code for every receipt status: a receipt
// that by design has no signature prints "no signature …" and exits 0 (never MATCH); a Signed
// receipt is MATCH (0) or MISMATCH (1); an unknown id exits 1; a missing --receipt exits 2.
import { toHex } from "viem";
import { sign } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as common from "../src/cli/common.js";
import { main } from "../src/cli/verify_sig.js";
import { SANDBOX_IDS } from "../src/config.js";
import { sandboxDerivedAddress, sandboxSecretKey } from "../src/derive.js";
import type { Receipt } from "../src/types.js";
import { first, hlOrderReceipt, hlOrders } from "./helpers.js";

vi.mock("../src/cli/common.js", async (importOriginal) => {
  const original = await importOriginal<typeof common>();
  return { ...original, connectGuard: vi.fn() };
});

const CONTRACT = SANDBOX_IDS.contract;

/** A Signed HL receipt whose signature comes from the sandbox mock-mpc key for (contract, hl-testnet-1). */
async function sandboxSignedReceipt(id: string): Promise<Receipt> {
  const receipt = hlOrderReceipt(first(hlOrders()), id);
  const sig = await sign({ hash: receipt.payload_hash as `0x${string}`, privateKey: toHex(sandboxSecretKey(CONTRACT, "hl-testnet-1")) });
  return { ...receipt, signature: { r: sig.r, s: sig.s, v: 27 + (sig.yParity ?? 0) } };
}

/** Run main with the given receipts on the "contract"; returns exit code and printed lines. */
async function run(argv: string[], receipts: Record<string, Receipt>): Promise<{ code: number; out: string[]; err: string[] }> {
  const getReceipt = vi.fn((id: number) => Promise.resolve(receipts[String(id)] ?? null));
  vi.mocked(common.connectGuard).mockResolvedValue({
    provider: {} as never,
    contractId: CONTRACT,
    client: { getReceipt } as never,
  });
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.map(String).join(" ")));
  const code = await main(argv);
  return { code, out, err };
}

beforeEach(() => {
  vi.mocked(common.connectGuard).mockReset();
  // Isolate from any developer offchain/.env: the real environment wins over the file.
  vi.stubEnv("NEAR_NETWORK", "sandbox");
  vi.stubEnv("CLAWGUARD_CONTRACT_ID", "");
  vi.stubEnv("NEAR_RPC_URL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("verify-sig CLI: printed line and exit code per receipt status", () => {
  it("Signed with the sandbox-derived signer → MATCH <address>, exit 0", async () => {
    const receipt = await sandboxSignedReceipt("1");
    const { code, out } = await run(["--receipt", "1"], { "1": receipt });
    expect(out).toEqual([`MATCH ${sandboxDerivedAddress(CONTRACT, "hl-testnet-1")}`]);
    expect(code).toBe(0);
  });

  it("Signed by another key (the vector's own signer, not the derived address) → MISMATCH, exit 1", async () => {
    const receipt = hlOrderReceipt(first(hlOrders()), "1");
    const { code, out } = await run(["--receipt", "1"], { "1": receipt });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^MISMATCH \(recovered 0x[0-9a-f]{40}, expected 0x[0-9a-f]{40}\)$/);
    expect(code).toBe(1);
  });

  it("Signed but without a derivation path → MISMATCH, exit 1", async () => {
    const receipt = { ...(await sandboxSignedReceipt("3")), derivation_path: null };
    const { code, out } = await run(["--receipt", "3"], { "3": receipt });
    expect(out).toEqual(["MISMATCH (receipt #3 is Signed but has no derivation path)"]);
    expect(code).toBe(1);
  });

  it.each([
    ["Blocked", "no signature (blocked)"],
    ["SignFailed", "no signature (signature request failed)"],
    ["PendingSignature", "no signature yet (pending)"],
  ] as const)("%s → %j, exit 0", async (status, line) => {
    const signed = await sandboxSignedReceipt("6");
    const receipt: Receipt =
      status === "Blocked"
        ? { ...signed, status, payload_hash: null, signed_body: null, derivation_path: null, signature: null }
        : { ...signed, status, signature: null };
    const { code, out } = await run(["--receipt", "6"], { "6": receipt });
    expect(out).toEqual([line]);
    expect(code).toBe(0);
  });

  it("Blocked but carrying a signature (contradictory view) → MISMATCH, exit 1, never 'no signature'", async () => {
    const receipt: Receipt = { ...(await sandboxSignedReceipt("6")), status: "Blocked" };
    const { code, out } = await run(["--receipt", "6"], { "6": receipt });
    expect(out).toEqual(["MISMATCH (receipt #6 is Blocked but carries a signature)"]);
    expect(code).toBe(1);
  });

  it("an unknown receipt id → 'receipt #<id> not found on <contract>', exit 1", async () => {
    const { code, out } = await run(["--receipt", "42"], {});
    expect(out).toEqual([`receipt #42 not found on ${CONTRACT}`]);
    expect(code).toBe(1);
  });

  it("no --receipt → usage on stderr, exit 2, nothing read", async () => {
    const { code, out, err } = await run([], {});
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(["Usage: npm run verify-sig -- --receipt <id>"]);
    expect(common.connectGuard).not.toHaveBeenCalled();
  });
});
