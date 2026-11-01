// `npm run receipts -- --last 20 [--json]`: table of on-chain receipts with a decoded
// "what is being signed" line per receipt. Read-only. Each agent's current rules (get_rules) name
// the signed asset index or token address; a removed agent's receipts show the index or address.
import { loadConfig } from "../config.js";
import type { RuleNames } from "../decode.js";
import { formatReceiptsJson, formatReceiptsTable } from "../receipts_view.js";
import { connectGuard, isMain, parseFlags, positiveIntFlag, runCli } from "./common.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags({ last: { type: "string" }, json: { type: "boolean" }, rpc: { type: "string" } }, argv);
  const last = positiveIntFlag(flags.last, "last", 20);
  const { client } = await connectGuard(config, flags.rpc);
  const receipts = await client.getLastReceipts(last);
  const names = new Map<string, RuleNames>();
  for (const agentId of new Set(receipts.map((r) => r.agent_id))) {
    const state = await client.getRules(agentId);
    if (state !== null) names.set(agentId, state.rules);
  }
  console.log(flags.json === true ? formatReceiptsJson(receipts, names) : formatReceiptsTable(receipts, names));
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());
