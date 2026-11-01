// `npm run verify-sig -- --receipt 12`: for a Signed receipt, recompute payload_hash
// from its signed body, recover the signer from payload_hash + signature, and compare with the
// address derived for (claw-guard contract, derivation path). Prints "MATCH 0x…" (exit 0) or
// "MISMATCH …" (exit 1); a Signed receipt without a derivation path, signature or payload hash is a
// MISMATCH too. A receipt that by design has no signature is not a failure and never a MATCH:
// "no signature (blocked)", "no signature (signature request failed)" or "no signature yet
// (pending)", exit 0; if such a receipt still carries a signature it is a MISMATCH, exit 1.
// An unknown id prints "receipt #<id> not found on <contract>", exit 1.
// A missing --receipt exits 2. The decision is verifySigReport in ../sig.ts.
import { loadConfig } from "../config.js";
import { deriveAddress } from "../derive.js";
import { verifySigReport } from "../sig.js";
import { connectGuard, isMain, parseFlags, positiveIntFlag, runCli } from "./common.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags({ receipt: { type: "string" }, rpc: { type: "string" }, offline: { type: "boolean" } }, argv);
  const id = positiveIntFlag(flags.receipt, "receipt", 0);
  if (id === 0) {
    console.error("Usage: npm run verify-sig -- --receipt <id>");
    return 2;
  }
  const { provider, contractId, client } = await connectGuard(config, flags.rpc);
  const receipt = await client.getReceipt(id);
  const report = await verifySigReport(String(id), contractId, receipt, async (path) => {
    const { address } = await deriveAddress({
      network: config.nearNetwork,
      contractId,
      path,
      mpcContractId: config.mpcContractId,
      ...(config.nearNetwork === "testnet" && flags.offline !== true ? { provider } : {}),
    });
    return address;
  });
  console.log(report.line);
  return report.exitCode;
}

if (isMain(import.meta.url)) void runCli(() => main());
