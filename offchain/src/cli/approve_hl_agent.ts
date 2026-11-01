// `npm run approve-hl-agent -- [--yes]`: OWNER-RUN, testnet only (owner go).
// The throwaway testnet master key (HL_MASTER_TESTNET_PRIVATE_KEY) signs Hyperliquid's approveAgent
// user-signed action (hyperliquidChain "Testnet", signatureChainId 0x66eee) for the address derived
// for (claw-guard contract, "hl-testnet-1"). An approved agent wallet can place and cancel orders
// for the master account but cannot withdraw.
// Without --yes this is a dry run: the unsigned action and its EIP-712 digest are printed; the
// master key signs nothing and nothing is sent (a printed signed request could be posted by anyone
// who sees it).
//   --agent <0x…>     approve this address instead of the derived one
//   --valid-days <n>  agent name "clawguard valid_until <ms>" (default 30 days)
//   --offline         derive the address with local math instead of the MPC view
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError, assertTestnetAccountId, clawguardContractId, loadConfig, log, requireValue, resolveNearRpcUrl } from "../config.js";
import { deriveAddress } from "../derive.js";
import { approveAgentAction, approveAgentDigest, buildApproveAgentRequest } from "../hl.js";
import { assertProviderNetwork, createProvider } from "../near.js";
import { submitHlExchange } from "../relayer/hl.js";
import { DERIVATION_PATHS } from "../types.js";
import { isMain, parseFlags, positiveIntFlag, runCli } from "./common.js";

const DAY_MS = 86_400_000;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags(
    {
      yes: { type: "boolean" },
      agent: { type: "string" },
      "valid-days": { type: "string" },
      offline: { type: "boolean" },
      rpc: { type: "string" },
    },
    argv,
  );
  if (config.nearNetwork !== "testnet") {
    throw new ConfigError("approve-hl-agent needs NEAR_NETWORK=testnet (it approves the testnet-derived address)");
  }

  const key = requireValue(config.hlMasterTestnetPrivateKey, "HL_MASTER_TESTNET_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key.reveal())) throw new ConfigError("HL_MASTER_TESTNET_PRIVATE_KEY must be 0x + 64 hex");
  const master = privateKeyToAccount(key.reveal() as `0x${string}`);
  if (config.hlMasterAddress !== undefined && config.hlMasterAddress.toLowerCase() !== master.address.toLowerCase()) {
    throw new ConfigError("HL_MASTER_ADDRESS does not match HL_MASTER_TESTNET_PRIVATE_KEY");
  }

  let agent = flags.agent;
  if (agent === undefined) {
    const contractId = assertTestnetAccountId(clawguardContractId(config), "CLAWGUARD_CONTRACT_ID");
    let provider;
    if (flags.offline !== true) {
      provider = createProvider(resolveNearRpcUrl(config, flags.rpc));
      await assertProviderNetwork(provider, "testnet");
    }
    agent = (
      await deriveAddress({
        network: "testnet",
        contractId,
        path: DERIVATION_PATHS.HlTestnet,
        mpcContractId: config.mpcContractId,
        ...(provider === undefined ? {} : { provider }),
      })
    ).address;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent)) throw new ConfigError("--agent must be 0x + 40 hex");

  const now = Date.now();
  const validUntil = now + positiveIntFlag(flags["valid-days"], "valid-days", 30) * DAY_MS;
  const action = approveAgentAction(agent, `clawguard valid_until ${validUntil}`, now);

  log.info(`Hyperliquid testnet master ${master.address} approves agent wallet ${action.agentAddress}`);
  log.info(`(agent wallets can place and cancel orders for the master account; they cannot withdraw)`);
  if (flags.yes !== true) {
    // Sign nothing in a dry run: a signed body in a log or scrollback could be POSTed by anyone.
    log.info("Dry run, nothing signed or sent. Unsigned approveAgent action that --yes would sign and POST to /exchange:");
    log.info(JSON.stringify(action, null, 2));
    log.info(`EIP-712 digest the master key would sign: ${approveAgentDigest(action)}`);
    return 0;
  }
  const request = await buildApproveAgentRequest(action, (typedData) => master.signTypedData(typedData));
  const { httpStatus, response } = await submitHlExchange(request, { apiUrl: config.hlApiUrl });
  log.info(`Hyperliquid testnet HTTP ${httpStatus}:`);
  log.info(JSON.stringify(response, null, 2));
  // Hyperliquid reports most failures as HTTP 200 with {"status":"err", ...}.
  const ok = httpStatus === 200 && typeof response === "object" && response !== null && (response as { status?: unknown }).status === "ok";
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) void runCli(() => main());
