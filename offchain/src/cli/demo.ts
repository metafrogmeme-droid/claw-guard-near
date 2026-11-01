// `npm run demo` (used by `make demo`): the whole Claw Guard story on a local NEAR
// sandbox, in one process, with no keys and no network accounts. Prototype. Testnet only. Not audited.
//
// 1. setup: sandbox node, mock-mpc + claw-guard, owner / agent / guardian keys, demo/rules.json
//    -> READY contract=clawguard.test.near agent=agent-1.test.near
// 2. the scripted agent's normal order (#1 Allowed, verify-sig MATCH), then the poisoned support
//    message: every injected order is blocked with the exact rule message; repeated in-cap
//    orders run into the daily cap
// 3. what #1 signed, decoded from the signed body
// 4. the agent's function-call key really is locked: a NEAR transfer, set_rules and add_key are
//    each attempted with it and each is rejected by the protocol
// 5. a full-access key appears on the agent account (simulated with sandbox_patch_state) ->
//    Claw Watch raises "Public signal: new full-access key on agent-1.test.near" -> the guardian
//    pauses (function-call key, method pause only) -> the next order is blocked as paused ->
//    the owner unpauses (1 yoctoNEAR) -> the next order is allowed
// 6. DEMO OK (<n> allowed, <m> blocked, keys locked, pause works)
//
// Every step is asserted (decision, rule code, exact message, MPC calls); any difference stops
// the demo with "DEMO FAILED: …" and exit code 1. The sandbox is always torn down.
import { KeyPair, actions } from "near-api-js";
import {
  AccessKeyMethodNameMismatchActionError,
  AccessKeyRequiresFullAccessActionError,
} from "near-api-js/rpc-errors";
import { type FetchLike, loadConfig, log } from "../config.js";
import { describeReceipt } from "../decode.js";
import { deriveAddress } from "../derive.js";
import { type ClawGuardClient, tgas, viewAccessKeyList, viewFunction } from "../near.js";
import { verifyReceipt } from "../sig.js";
import { DERIVATION_PATHS, type Receipt } from "../types.js";
import { assertPauseOnlyGuardianKey, createClawWatch, reportLines } from "../watch/index.js";
import { type InjectionReport, WATCH_PAUSE_REASON, pausedProbeStep, resumedStep, runInjectionScenario } from "../agent/injection.js";
import { type AgentPort, HlNonceClock, type Print, type StepResult, chainAgentPort, runStep } from "../agent/scripted.js";
import { isMain, parseFlags, runCli } from "./common.js";
import { AGENT_METHODS, SandboxSignalGuard, type SandboxDeployment, assertOnlyFunctionCallKey, readyLine, setupSandbox } from "./setup.js";

/** A demo assertion failed: printed as "DEMO FAILED: <message>". */
export class DemoFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoFailure";
  }
}

function demand(condition: boolean, message: string): asserts condition {
  if (!condition) throw new DemoFailure(message);
}

const print: Print = (line) => log.info(line);

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function signCount(dep: SandboxDeployment): Promise<number> {
  const count = await viewFunction(dep.provider, dep.ids.mpc, "sign_count");
  demand(typeof count === "number", "mock-mpc sign_count did not return a number");
  return count;
}

/**
 * The step's decision is the expected one, and the MPC signer was reached exactly when the order
 * was allowed (a blocked order must never request a signature).
 */
function checkStep(dep: SandboxDeployment, result: StepResult): void {
  demand(result.mismatch === undefined, `step ${result.step.label}: ${result.mismatch ?? ""}`);
  const reachedMpc = result.outcome.receiptExecutors.includes(dep.ids.mpc);
  const allowed = result.outcome.decision.allowed;
  demand(reachedMpc === allowed, `step ${result.step.label}: ${allowed ? "allowed without" : "blocked but made"} a signature request`);
}

/** verify-sig, in-process: payload binding + signer = address derived for (claw-guard, path). */
async function verifySigLine(dep: SandboxDeployment, receiptId: string): Promise<{ line: string; receipt: Receipt }> {
  const receipt = await dep.client.getReceipt(receiptId);
  demand(receipt !== null && receipt.derivation_path !== null, `receipt #${receiptId} has no signature to verify`);
  const { address } = await deriveAddress({ network: "sandbox", contractId: dep.ids.contract, path: receipt.derivation_path });
  const result = await verifyReceipt(receipt, address);
  demand(result.match, `verify-sig for #${receiptId}: ${result.line}`);
  return { line: `verify-sig: ${result.line}`, receipt };
}

// ---------------------------------------------------------------------------
// Agent key attempts (each must be rejected by the protocol)
// ---------------------------------------------------------------------------

type Rejection = "RequiresFullAccess" | "MethodNameMismatch";

async function expectRejected(label: string, kind: Rejection, send: () => Promise<unknown>): Promise<string> {
  try {
    await send();
  } catch (err) {
    const matches =
      kind === "RequiresFullAccess"
        ? err instanceof AccessKeyRequiresFullAccessActionError
        : err instanceof AccessKeyMethodNameMismatchActionError;
    demand(matches, `agent key ${label}: expected a ${kind} rejection, got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return (err as Error).message;
  }
  throw new DemoFailure(`agent key ${label}: the protocol accepted it`);
}

async function agentKeyIsLocked(dep: SandboxDeployment): Promise<void> {
  const { agent, provider, ids, client } = dep;
  print(`Agent key test: ${ids.agent} signs three transactions with its own function-call key`);
  const ownerBefore = (await provider.viewAccount({ accountId: ids.owner })).amount;
  const versionBefore = (await client.getRules(ids.agent))?.rules_version;

  // 0.1 NEAR: within the agent's balance, so only the key permission can refuse it.
  const transfer = await expectRejected("transfer", "RequiresFullAccess", () =>
    agent.signAndSendTransaction({ receiverId: ids.owner, actions: [actions.transfer(10n ** 23n)], waitUntil: "EXECUTED_OPTIMISTIC" }),
  );
  print(`  agent key sends 0.1 NEAR to ${ids.owner}: rejected by the protocol (${transfer})`);

  // A loosened rule set (50x leverage) that the agent would like to have.
  const loosened = { ...dep.rules, max_leverage: 50 };
  const setRules = await expectRejected("set_rules", "MethodNameMismatch", () =>
    agent.signAndSendTransaction({
      receiverId: ids.contract,
      actions: [actions.functionCall("set_rules", { agent_id: ids.agent, rules: loosened }, tgas(30), 0n)],
      waitUntil: "EXECUTED_OPTIMISTIC",
    }),
  );
  print(`  agent key calls set_rules (50x leverage): rejected by the protocol (${setRules})`);

  const addKey = await expectRejected("add_key", "RequiresFullAccess", () =>
    agent.signAndSendTransaction({
      receiverId: ids.agent,
      actions: [actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())],
      waitUntil: "EXECUTED_OPTIMISTIC",
    }),
  );
  print(`  agent key adds a full-access key to ${ids.agent}: rejected by the protocol (${addKey})`);

  // Nothing changed: same single key, same rules, owner balance untouched.
  await assertOnlyFunctionCallKey(provider, ids.agent, ids.contract, AGENT_METHODS);
  demand((await client.getRules(ids.agent))?.rules_version === versionBefore, "rules_version changed after the agent key attempts");
  demand((await provider.viewAccount({ accountId: ids.owner })).amount === ownerBefore, "owner balance changed after the agent key attempts");
  print("agent key: transfer REJECTED, set_rules REJECTED, add_key REJECTED");
}

// ---------------------------------------------------------------------------
// Simulated attacker key (sandbox only)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Add a full-access key to `accountId` with the sandbox-only RPC `sandbox_patch_state` (it
 * rewrites state directly; no key of the account signs anything). Refuses any non-loopback RPC.
 */
export async function patchInFullAccessKey(rpcUrl: string, accountId: string, publicKey: string, fetchImpl: FetchLike = fetch): Promise<void> {
  if (!LOOPBACK_HOSTS.has(new URL(rpcUrl).hostname)) throw new Error("sandbox_patch_state is only sent to a local sandbox node");
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "clawguard-demo",
      method: "sandbox_patch_state",
      params: {
        records: [{ AccessKey: { account_id: accountId, public_key: publicKey, access_key: { nonce: 0, permission: "FullAccess" } } }],
      },
    }),
  });
  const body = (await res.json()) as { error?: unknown };
  if (!res.ok || body.error !== undefined) throw new Error(`sandbox_patch_state failed: HTTP ${res.status} ${JSON.stringify(body.error ?? null)}`);
}

async function waitForFullAccessKey(dep: SandboxDeployment, accountId: string, publicKey: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const keys = await viewAccessKeyList(dep.provider, accountId);
    if (keys.some((k) => k.publicKey === publicKey && k.kind === "FullAccess")) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new DemoFailure(`the patched key never appeared on ${accountId}`);
}

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

export interface DemoSummary {
  allowed: number;
  blocked: number;
}

/** Steps 1-6, each asserted as it happens; returns the report and receipt #1 (verified). */
async function injection(dep: SandboxDeployment, port: AgentPort, nonces: HlNonceClock): Promise<{ report: InjectionReport; first: Receipt }> {
  let allowedSoFar = 0;
  let first: Receipt | undefined;
  const report = await runInjectionScenario(port, print, {
    nonces,
    onResult: async (result) => {
      checkStep(dep, result);
      if (result.outcome.decision.allowed) allowedSoFar += 1;
      demand((await signCount(dep)) === allowedSoFar, `step ${result.step.label}: mock-mpc sign_count is not the number of allowed orders`);
      if (result.step.label === "1") {
        const verified = await verifySigLine(dep, result.outcome.decision.receipt_id);
        print(verified.line);
        first = verified.receipt;
      }
    },
  });
  demand(report.mismatches.length === 0, report.mismatches.join("; "));
  demand(report.fillAllowed === 2, `step 6: expected 2 in-cap orders before the daily cap, got ${report.fillAllowed}`);
  demand(first !== undefined, "the scenario produced no receipt #1");
  return { report, first };
}

async function watchAndPause(dep: SandboxDeployment, port: AgentPort, nonces: HlNonceClock, firstLabel: number): Promise<StepResult[]> {
  const { ids, provider, client, guardian, guardianPublicKey } = dep;
  const guardianId = ids.guardian;
  demand(guardian !== null && guardianId !== null && guardianPublicKey !== null, "the demo needs a guardian");
  // Least privilege: autopause only with a guardian key that can call pause and nothing else.
  await assertPauseOnlyGuardianKey(provider, guardianId, guardianPublicKey, ids.contract);
  // Watched accounts: owner, agent, contract and guardian (D-10); only a new key may pause.
  const watch = createClawWatch({
    provider,
    client,
    network: "sandbox",
    accounts: [ids.owner, ids.agent, ids.contract, guardianId],
    autopause: { pauser: client.as(guardian), on: ["near_key_added"] },
  });
  print(`Claw Watch: watching the access keys of ${[ids.owner, ids.agent, ids.contract, guardianId].join(", ")}; autopause through ${guardianId} (pause only)`);
  const baseline = await watch.pollOnce();
  demand(baseline.errors.length === 0, `Claw Watch baseline: ${baseline.errors.join("; ")}`);
  for (const [, line] of reportLines(baseline)) print(line);

  const attacker = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  await patchInFullAccessKey(dep.rpcUrl, ids.agent, attacker);
  await waitForFullAccessKey(dep, ids.agent, attacker);
  print(`simulated attacker: a full-access key was added to ${ids.agent} (sandbox_patch_state)`);

  const report = await watch.pollOnce();
  for (const [, line] of reportLines(report)) print(line);
  demand(report.errors.length === 0, `Claw Watch: ${report.errors.join("; ")}`);
  const expectedAlert = `Public signal: new full-access key on ${ids.agent}`;
  demand(report.alerts.some((a) => a.text === expectedAlert), `Claw Watch did not raise "${expectedAlert}"`);
  demand(
    report.autopause?.status === "paused" && report.autopause.reason === WATCH_PAUSE_REASON,
    `Claw Watch autopause: ${JSON.stringify(report.autopause ?? null)}`,
  );
  const status = await client.getStatus();
  demand(status.paused && status.pause_reason === WATCH_PAUSE_REASON, "the guard is not paused after the guardian pause");

  const results: StepResult[] = [];
  const signsBefore = await signCount(dep);
  const probe = await runStep(port, pausedProbeStep(nonces, String(firstLabel)), print);
  checkStep(dep, probe);
  results.push(probe);

  await client.as(dep.owner).unpause();
  demand(!(await client.getStatus()).paused, "the guard is still paused after the owner's unpause");
  print(`owner ${ids.owner} unpauses (1 yoctoNEAR, signed with the owner's full-access key)`);

  const resumed = await runStep(port, resumedStep(nonces, String(firstLabel + 1)), print);
  checkStep(dep, resumed);
  results.push(resumed);
  demand((await signCount(dep)) === signsBefore + 1, "after the pause: mock-mpc sign_count does not match the allowed orders");
  return results;
}

export async function runDemo(dep: SandboxDeployment): Promise<DemoSummary> {
  print(readyLine(dep.ids));
  const port = chainAgentPort(dep.provider, dep.ids.contract, dep.agent);
  const nonces = new HlNonceClock(port);

  const { report: scenario, first: receipt } = await injection(dep, port, nonces);
  const [sentence, detail, ...rest] = describeReceipt(receipt, dep.rules);
  demand(sentence !== undefined && detail !== undefined && rest.length === 0, `receipt #${receipt.id}: the signed body does not match the proposal`);
  print(`what #${receipt.id} signed (decoded from its signed body): ${sentence}`);
  print(`  ${detail}`);

  await agentKeyIsLocked(dep);
  const tail = await watchAndPause(dep, port, nonces, scenario.results.length + 1);

  const all = [...scenario.results, ...tail];
  const allowed = all.filter((r) => r.outcome.decision.allowed).length;
  const blocked = all.length - allowed;
  const status = await dep.client.getStatus();
  demand(status.receipts_count === all.length, `receipts_count is ${status.receipts_count}, expected ${all.length}`);
  demand((await signCount(dep)) === allowed, "mock-mpc sign_count does not equal the allowed orders");
  await checkReceiptLog(dep.client, all);
  return { allowed, blocked };
}

/** The on-chain receipts tell the same story: one receipt per step, in order, nothing signed when blocked. */
async function checkReceiptLog(client: ClawGuardClient, results: readonly StepResult[]): Promise<void> {
  const receipts = await client.getReceipts(1, results.length);
  demand(receipts.length === results.length, `expected ${results.length} receipts, found ${receipts.length}`);
  results.forEach((result, i) => {
    const r = receipts[i];
    const d = result.outcome.decision;
    demand(r !== undefined && r.id === d.receipt_id && r.message === d.message && r.rule_code === d.rule_code, `receipt #${i + 1} differs from its decision`);
    demand(
      d.allowed ? r.status === "Signed" && r.signature !== null : r.status === "Blocked" && r.signature === null && r.payload_hash === null,
      `receipt #${r.id} has status ${r.status}`,
    );
    const path = r.derivation_path;
    demand(path === null || path === DERIVATION_PATHS[r.target], `receipt #${r.id} has derivation path ${String(path)}`);
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  parseFlags({}, argv);
  // The demo never reads offchain/.env: it needs no keys. The testnet guards still apply to the environment.
  const config = loadConfig({ envFile: false });
  if (config.nearNetwork !== "sandbox") {
    log.error("npm run demo runs only on the local sandbox; unset NEAR_NETWORK (testnet: make demo-testnet)");
    return 2;
  }
  const started = Date.now();
  print("Claw Guard demo on a local NEAR sandbox. Prototype. Testnet only. Not audited.");
  print("The server never holds mainnet keys or signs for users.");

  const guard = new SandboxSignalGuard();
  let dep: SandboxDeployment | undefined;
  let summary: DemoSummary | undefined;
  try {
    dep = await setupSandbox({ progress: print, onNodeStarted: (tearDown) => guard.track(tearDown) });
    summary = await runDemo(dep);
  } catch (err) {
    log.error(`DEMO FAILED: ${err instanceof Error ? err.message : String(err)}`);
    const tail = dep?.nodeLogTail() ?? [];
    if (!(err instanceof DemoFailure) && tail.length > 0) log.error(`Sandbox node log (last ${tail.length} lines):\n${tail.join("\n")}`);
  } finally {
    await dep?.tearDown();
    guard.dispose();
  }
  if (summary === undefined) return 1;
  print(`Sandbox stopped and deleted. Demo took ${Math.round((Date.now() - started) / 1000)} s.`);
  print(`DEMO OK (${summary.allowed} allowed, ${summary.blocked} blocked, keys locked, pause works)`);
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());

