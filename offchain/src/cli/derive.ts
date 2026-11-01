// `npm run derive -- --path hl-testnet-1`: print the EVM address the MPC signs with
// for (claw-guard contract id, path). Address on stdout; notes on stderr.
//   --contract <id>  override CLAWGUARD_CONTRACT_ID
//   --offline        testnet: use the local derivation math instead of the MPC view
//   --rpc <url>      override NEAR_RPC_URL
import { assertTestnetAccountId, clawguardContractId, loadConfig, log, readSandboxState, resolveNearRpcUrl } from "../config.js";
import { deriveAddress } from "../derive.js";
import { assertProviderNetwork, createProvider } from "../near.js";
import { isMain, parseFlags, runCli } from "./common.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags(
    { path: { type: "string" }, contract: { type: "string" }, offline: { type: "boolean" }, rpc: { type: "string" } },
    argv,
  );
  const path = flags.path;
  if (path === undefined || !/^[a-z0-9-]{1,64}$/.test(path)) {
    log.error("Usage: npm run derive -- --path <hl-testnet-1|base-sepolia-1> [--contract <id>] [--offline]");
    return 2;
  }
  const sandboxContract = config.nearNetwork === "sandbox" ? readSandboxState()?.contractId : undefined;
  const contractId = assertTestnetAccountId(
    flags.contract ?? config.clawguardContractId ?? sandboxContract ?? clawguardContractId(config),
    "contract id",
  );

  let provider;
  if (config.nearNetwork === "testnet" && flags.offline !== true) {
    provider = createProvider(resolveNearRpcUrl(config, flags.rpc));
    await assertProviderNetwork(provider, config.nearNetwork);
  }
  const derived = await deriveAddress({
    network: config.nearNetwork,
    contractId,
    path,
    mpcContractId: config.mpcContractId,
    ...(provider === undefined ? {} : { provider }),
  });

  console.log(derived.address);
  console.error(`(${derived.source}: predecessor ${contractId}, path ${path}, network ${config.nearNetwork})`);
  if (derived.localMathAgrees === false) {
    log.warn("Note: the MPC view and the local derivation math disagree; the MPC view value is printed above.");
  }
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());
