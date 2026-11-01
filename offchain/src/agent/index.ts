// `npm run agent -- [--scenario normal|injection|all|spike] [--mode scripted|llm]
//                         [--prompt-file demo/poisoned_message.txt] [--rpc url] [--receipt-id-file path]`
// Prototype. Testnet only. Not audited.
//
// The demo agent. It holds ONLY the agent account's function-call key (receiver = claw-guard,
// methods = [propose_order]); it refuses to start with any other key. Each decision is printed as
//   #12 Allowed: within your limits sig=0x9db86c17…8d61
//   #13 Blocked by your rule: market DOGE is not on your list
//
//  - sandbox: run `npm run setup:sandbox` in another terminal first (it writes offchain/.sandbox/).
//  - testnet: AGENT_ACCOUNT_ID + AGENT_PRIVATE_KEY in offchain/.env (owner go).
//  - scripted (default): normal = ordinary trading inside the rules; injection = the prompt-injection
//    steps 1-6 (step 7 needs Claw Watch: `npm run demo` shows it); all = normal, then injection;
//    spike = one far-below-market order for the Hyperliquid spike (`make spike-hl`).
//    Exit code 1 if any decision differs from what the scenario expects.
//  - llm (AGENT_MODE=llm or --mode llm, needs LLM_API_KEY): a Claude model gets the owner's task
//    and the prompt file as its inbox, with one tool, propose_order.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Account, JsonRpcProvider } from "near-api-js";
import { type AgentMode, type Config, ConfigError, SANDBOX_IDS, loadConfig, log, readSandboxState, requireValue } from "../config.js";
import { connectAccount, signerFromKey, viewAccessKeyList } from "../near.js";
import { formatDecisionLine } from "../receipts_view.js";
import { connectGuard, isMain, parseFlags, runCli } from "../cli/common.js";
import { readSandboxKey } from "../cli/setup.js";
import type { Decision } from "../types.js";
import { POISONED_MESSAGE_FILE, runInjectionScenario } from "./injection.js";
import { runLlmAgent } from "./llm.js";
import {
  type AgentPort,
  HlNonceClock,
  type Print,
  type ScenarioReport,
  chainAgentPort,
  nextEvmNonce,
  runNormalScenario,
  runSteps,
  spikeSteps,
  summarize,
} from "./scripted.js";

export const SCENARIOS = ["normal", "injection", "all", "spike"] as const;
export type Scenario = (typeof SCENARIOS)[number];

const print: Print = (line) => log.info(line);

/**
 * Least privilege: the agent signs only with a function-call key of `agentId` for `contractId`
 * whose only method is propose_order. A full-access key (or any wider key) is refused.
 */
export async function assertProposeOnlyAgentKey(
  provider: JsonRpcProvider,
  agentId: string,
  publicKey: string,
  contractId: string,
): Promise<void> {
  const key = (await viewAccessKeyList(provider, agentId)).find((k) => k.publicKey === publicKey);
  if (key === undefined) throw new ConfigError(`the agent key is not an access key of ${agentId}`);
  const proposeOnly =
    key.kind === "FunctionCall" && key.receiverId === contractId && key.methodNames.length === 1 && key.methodNames[0] === "propose_order";
  if (!proposeOnly) {
    throw new ConfigError(
      `the agent runs only with a function-call key for ${contractId} with the method propose_order (this is a ${key.kind} key); refused`,
    );
  }
}

/** The agent account, signing with its function-call key (sandbox: from setup:sandbox; testnet: from .env). */
export async function connectAgent(config: Config, provider: JsonRpcProvider, contractId: string): Promise<Account> {
  let agentId: string;
  let secret;
  if (config.nearNetwork === "sandbox") {
    const state = readSandboxState();
    agentId = typeof state?.agentId === "string" ? state.agentId : SANDBOX_IDS.agent;
    secret = readSandboxKey(agentId);
  } else {
    agentId = requireValue(config.agentAccountId, "AGENT_ACCOUNT_ID");
    secret = requireValue(config.agentPrivateKey, "AGENT_PRIVATE_KEY");
  }
  const signer = signerFromKey(secret);
  await assertProposeOnlyAgentKey(provider, agentId, (await signer.getPublicKey()).toString(), contractId);
  return connectAccount(agentId, provider, signer);
}

/** Relative output paths are taken from where `npm run` was started (npm sets INIT_CWD). */
export function resolveOutputPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return isAbsolute(path) ? path : resolve(env.INIT_CWD ?? process.cwd(), path);
}

/** Relative input paths: from where `npm run` was started, else from the repo root. */
export function resolveInputPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromCaller = resolveOutputPath(path, env);
  return isAbsolute(path) || existsSync(fromCaller) ? fromCaller : resolve(POISONED_MESSAGE_FILE, "..", "..", path);
}

/** The id `--receipt-id-file` gets: the last allowed order's receipt, never "0" (no receipt stored). */
export function receiptIdForFile(decisions: readonly Decision[]): string | undefined {
  return decisions.filter((d) => d.allowed && d.receipt_id !== "0").at(-1)?.receipt_id;
}

export async function runScripted(port: AgentPort, scenario: Scenario): Promise<ScenarioReport> {
  const nonces = new HlNonceClock(port);
  switch (scenario) {
    case "normal":
      return runNormalScenario(port, print, nonces);
    case "injection":
      return runInjectionScenario(port, print, { nonces });
    case "all": {
      const normal = await runNormalScenario(port, print, nonces);
      const injection = await runInjectionScenario(port, print, { nonces });
      return summarize([...normal.results, ...injection.results.map((r) => ({ ...r, step: { ...r.step, label: `i${r.step.label}` } }))]);
    }
    case "spike":
      return summarize(await runSteps(port, spikeSteps(nonces), print));
  }
}

function parseScenario(value: string | undefined): Scenario {
  const scenario = SCENARIOS.find((s) => s === (value ?? "normal"));
  if (scenario === undefined) throw new ConfigError(`--scenario must be one of ${SCENARIOS.join(" | ")}`);
  return scenario;
}

function parseMode(value: string | undefined, fallback: AgentMode): AgentMode {
  const mode = value ?? fallback;
  if (mode !== "scripted" && mode !== "llm") throw new ConfigError("--mode must be scripted or llm");
  return mode;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags(
    {
      scenario: { type: "string" },
      mode: { type: "string" },
      "prompt-file": { type: "string" },
      rpc: { type: "string" },
      "receipt-id-file": { type: "string" },
    },
    argv,
  );
  const mode = parseMode(flags.mode, config.agentMode);
  const scenario = parseScenario(flags.scenario);
  if (mode === "llm" && flags.scenario !== undefined) throw new ConfigError("--scenario applies to the scripted mode only");
  if (mode === "scripted" && flags["prompt-file"] !== undefined) throw new ConfigError("--prompt-file applies to --mode llm only");
  // Fail before touching the chain when the LLM mode has no key.
  const llmApiKey = mode === "llm" ? requireValue(config.llmApiKey, "LLM_API_KEY") : undefined;

  const { provider, contractId } = await connectGuard(config, flags.rpc);
  const agent = await connectAgent(config, provider, contractId);
  // Sandbox gas is 10x testnet's: wait for each gas refund before the next proposal (see chainAgentPort).
  const port = chainAgentPort(provider, contractId, agent, { waitUntil: config.nearNetwork === "sandbox" ? "FINAL" : "EXECUTED_OPTIMISTIC" });
  print(`Agent ${agent.accountId} on NEAR ${config.nearNetwork}: function-call key for ${contractId}, method propose_order only`);

  let decisions: Decision[];
  let exitCode = 0;
  if (llmApiKey !== undefined) {
    const promptFile = resolveInputPath(flags["prompt-file"] ?? POISONED_MESSAGE_FILE);
    const nonces = new HlNonceClock(port);
    print(`LLM mode: the model reads ${promptFile} as its inbox; it can only call propose_order`);
    const result = await runLlmAgent(readFileSync(promptFile, "utf8"), {
      apiKey: llmApiKey,
      propose: async (proposal) => {
        const { decision } = await port.propose(proposal);
        print(formatDecisionLine(decision));
        return decision;
      },
      nonces: { hlNonceMs: () => nonces.next(), evmNonce: () => nextEvmNonce(port) },
      print,
    });
    decisions = result.decisions;
    print(`LLM run ended (${result.endedBy}) after ${result.proposals} proposals`);
  } else {
    const report = await runScripted(port, scenario);
    decisions = report.results.map((r) => r.outcome.decision);
    for (const mismatch of report.mismatches) log.error(`check failed: ${mismatch}`);
    if (report.mismatches.length > 0) exitCode = 1;
  }

  const allowed = decisions.filter((d) => d.allowed);
  print(`Agent done: ${allowed.length} allowed, ${decisions.length - allowed.length} blocked`);
  const receiptIdFile = flags["receipt-id-file"];
  if (receiptIdFile !== undefined) {
    const receiptId = receiptIdForFile(decisions);
    if (receiptId === undefined) {
      log.error("no allowed order: nothing to write to --receipt-id-file");
      return 1;
    }
    writeFileSync(resolveOutputPath(receiptIdFile), `${receiptId}\n`, "utf8");
  }
  return exitCode;
}

if (isMain(import.meta.url)) void runCli(() => main());
