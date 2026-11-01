// `npm run relay -- --receipt 12`: keyless relayer. Reads a Signed receipt from the
// contract, checks it (payload binding + signer = derived address) and submits it to Hyperliquid
// testnet or Base Sepolia, by target. Testnet only (owner go); the sandbox demo never relays.
import { ConfigError, loadConfig, log } from "../config.js";
import { deriveAddress } from "../derive.js";
import { relayReceipt } from "../relayer/index.js";
import { connectGuard, isMain, parseFlags, positiveIntFlag, runCli } from "./common.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags({ receipt: { type: "string" }, rpc: { type: "string" } }, argv);
  const id = positiveIntFlag(flags.receipt, "receipt", 0);
  if (id === 0) {
    console.error("Usage: npm run relay -- --receipt <id>");
    return 2;
  }
  if (config.nearNetwork !== "testnet") {
    throw new ConfigError("relay needs NEAR_NETWORK=testnet (sandbox signatures come from a mock key and are never relayed)");
  }
  const { provider, contractId, client } = await connectGuard(config, flags.rpc);
  const receipt = await client.getReceipt(id);
  if (receipt === null) throw new Error(`receipt #${id} not found`);
  if (receipt.derivation_path === null) throw new Error(`receipt #${id} has no derivation path (status ${receipt.status})`);

  const { address } = await deriveAddress({
    network: "testnet",
    contractId,
    path: receipt.derivation_path,
    mpcContractId: config.mpcContractId,
    provider,
  });
  log.info(`Relaying receipt #${id} (${receipt.target}) signed by ${address}`);
  const result = await relayReceipt(receipt, { config, expectedSigner: address });
  if (result.target === "HlTestnet") {
    log.info(`Hyperliquid testnet HTTP ${result.httpStatus}:`);
    log.info(JSON.stringify(result.response, null, 2));
  } else {
    log.info(`Base Sepolia transaction hash: ${result.txHash}`);
  }
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());
