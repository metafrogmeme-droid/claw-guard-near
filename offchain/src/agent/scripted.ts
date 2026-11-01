// Scripted demo agent: proposal builders, nonce sources, a step runner and the
// "normal" scenario. Prototype. Testnet only. Not audited.
//
// The agent can only PROPOSE: everything it does goes through `AgentPort.propose`, which signs
// propose_order with the agent's function-call key (receiver = claw-guard, methods =
// [propose_order], no deposit). The contract decides; the agent prints each Decision as
//   #12 Allowed: within your limits sig=0x9db86c17…8d61
//   #13 Blocked by your rule: market DOGE is not on your list
import type { Account, Provider, TxExecutionStatus } from "near-api-js";
import { ClawGuardClient, PROPOSE_GAS_TGAS, callFunction } from "../near.js";
import { formatDecisionLine } from "../receipts_view.js";
import {
  ALLOWED_MESSAGE,
  BLOCKED_PREFIX,
  type AgentState,
  type ClawGuardEvent,
  type Decision,
  type Proposal,
  parseDecision,
} from "../types.js";

// ---------------------------------------------------------------------------
// Chain access
// ---------------------------------------------------------------------------

/** One propose_order transaction and what it did. */
export interface ProposalOutcome {
  decision: Decision;
  txHash: string;
  /** Accounts on which receipts of this transaction ran (an allowed order reaches the MPC signer). */
  receiptExecutors: string[];
  /** NEP-297 events logged by claw-guard itself. */
  events: ClawGuardEvent[];
}

/** Everything the agent can do: propose with its function-call key, and read views. */
export interface AgentPort {
  readonly agentId: string;
  readonly contractId: string;
  propose(proposal: Proposal): Promise<ProposalOutcome>;
  /** Latest block time in ms (the contract checks HL nonces against block time). */
  blockTimeMs(): Promise<bigint>;
  agentState(): Promise<AgentState | null>;
}

/**
 * AgentPort backed by the claw-guard contract; `agent` must sign with the agent's function-call
 * key. propose_order attaches 300 Tgas and no deposit.
 *
 * `waitUntil` defaults to FINAL, which also waits for the gas refund receipt: each proposal
 * reserves 300 Tgas of the agent's balance (0.3 NEAR at the sandbox gas price, out of 0.5 NEAR),
 * so the next one must not start before the refund of the previous one has landed.
 */
export function chainAgentPort(
  provider: Provider,
  contractId: string,
  agent: Account,
  { waitUntil = "FINAL" }: { waitUntil?: TxExecutionStatus } = {},
): AgentPort {
  const client = new ClawGuardClient(provider, contractId);
  return {
    agentId: agent.accountId,
    contractId,
    async propose(proposal) {
      const res = await callFunction(agent, contractId, "propose_order", { proposal }, { gasTgas: PROPOSE_GAS_TGAS, waitUntil });
      return {
        decision: parseDecision(res.value),
        txHash: res.txHash,
        receiptExecutors: res.outcome.receipts_outcome.map((r) => r.outcome.executor_id),
        events: res.events,
      };
    },
    async blockTimeMs() {
      const block = await provider.viewBlock({ finality: "optimistic" });
      return BigInt(block.header.timestamp_nanosec) / 1_000_000n;
    },
    agentState: () => client.getRules(agent.accountId),
  };
}

// ---------------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------------

/**
 * Hyperliquid nonces the guard accepts: the current block time in ms (inside the contract's
 * ±5 min window) and strictly above the agent's last HL nonce (read once from get_rules, then
 * tracked locally). Blocked orders do not consume a nonce on chain; skipping values is fine.
 */
export class HlNonceClock {
  #last: bigint | undefined;
  constructor(private readonly port: Pick<AgentPort, "blockTimeMs" | "agentState">) {}

  async next(): Promise<string> {
    if (this.#last === undefined) {
      const onChain = (await this.port.agentState())?.last_hl_nonce_ms;
      this.#last = onChain === null || onChain === undefined ? 0n : BigInt(onChain);
    }
    const now = await this.port.blockTimeMs();
    const nonce = now > this.#last ? now : this.#last + 1n;
    this.#last = nonce;
    return nonce.toString();
  }
}

/** Next EVM nonce: one above the agent's last EVM nonce on chain (0 if none was used yet). */
export async function nextEvmNonce(port: Pick<AgentPort, "agentState">): Promise<string> {
  const last = (await port.agentState())?.last_evm_nonce ?? null;
  return last === null ? "0" : (BigInt(last) + 1n).toString();
}

// ---------------------------------------------------------------------------
// Proposal builders (wire shapes of types.ts)
// ---------------------------------------------------------------------------

/** Fees of the shared EVM vectors (tests/common/mod.rs evm_transfer). */
export const EVM_DEFAULT_TX = { gas_limit: "65000", max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "1000000" } as const;

export function hlOrder(o: {
  market: string;
  isBuy: boolean;
  limitPx: string;
  sz: string;
  nonceMs: string;
  reduceOnly?: boolean;
  tif?: string;
  memo?: string | null;
}): Proposal {
  return {
    target: "HlTestnet",
    order: {
      HlOrder: {
        market: o.market,
        is_buy: o.isBuy,
        limit_px: o.limitPx,
        sz: o.sz,
        reduce_only: o.reduceOnly ?? false,
        tif: o.tif ?? "Gtc",
        nonce_ms: o.nonceMs,
      },
    },
    memo: o.memo ?? null,
  };
}

export function hlUpdateLeverage(o: { market: string; isCross: boolean; leverage: number; nonceMs: string; memo?: string | null }): Proposal {
  return {
    target: "HlTestnet",
    order: { HlUpdateLeverage: { market: o.market, is_cross: o.isCross, leverage: o.leverage, nonce_ms: o.nonceMs } },
    memo: o.memo ?? null,
  };
}

export function evmTransfer(o: { token: string; to: string; amount: string; nonce: string; memo?: string | null }): Proposal {
  return {
    target: "BaseSepolia",
    order: { EvmTransfer: { token: o.token, to: o.to, amount: o.amount, nonce: o.nonce, ...EVM_DEFAULT_TX } },
    memo: o.memo ?? null,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type Expectation = { allowed: true } | { allowed: false; ruleCode: string; message: string };

export const EXPECT_ALLOWED: Expectation = { allowed: true };

export function expectBlocked(ruleCode: string, ruleText: string): Expectation {
  return { allowed: false, ruleCode, message: `${BLOCKED_PREFIX}${ruleText}` };
}

/** Builds the proposal at run time (nonces come from the chain). */
export interface Step {
  /** "1", "6.2", … */
  label: string;
  /** "normal" | "injected" | … (printed with the step). */
  kind: string;
  /** What the agent was told to do, in plain words. */
  title: string;
  build(): Promise<Proposal>;
  expect: Expectation;
}

export interface StepResult {
  step: Step;
  proposal: Proposal;
  outcome: ProposalOutcome;
  /** Why the decision differs from the expectation; undefined when it matches. */
  mismatch: string | undefined;
}

/** undefined when `decision` is what `expect` says, else a one-line reason. */
export function checkDecision(decision: Decision, expect: Expectation): string | undefined {
  if (expect.allowed) {
    if (!decision.allowed) return `expected "${ALLOWED_MESSAGE}", got "${decision.message}"`;
    if (decision.message !== ALLOWED_MESSAGE) return `allowed with an unexpected message "${decision.message}"`;
    if (decision.rule_code !== null) return `allowed with rule_code ${decision.rule_code}`;
    if (decision.signature === null) return "allowed without a signature";
    return undefined;
  }
  if (decision.allowed) return `expected "${expect.message}", but the order was allowed`;
  if (decision.rule_code !== expect.ruleCode || decision.message !== expect.message) {
    return `expected ${expect.ruleCode} "${expect.message}", got ${String(decision.rule_code)} "${decision.message}"`;
  }
  if (decision.signature !== null) return "blocked but carries a signature";
  return undefined;
}

export type Print = (line: string) => void;

/** Propose one step, print the step and its decision line, and compare with the expectation. */
export async function runStep(port: AgentPort, step: Step, print: Print): Promise<StepResult> {
  const proposal = await step.build();
  print(`step ${step.label} (${step.kind}): ${step.title}`);
  const outcome = await port.propose(proposal);
  print(formatDecisionLine(outcome.decision));
  return { step, proposal, outcome, mismatch: checkDecision(outcome.decision, step.expect) };
}

export interface ScenarioReport {
  results: StepResult[];
  allowed: number;
  blocked: number;
  /** "step <label>: <reason>" for every decision that differs from its expectation. */
  mismatches: string[];
}

export function summarize(results: readonly StepResult[]): ScenarioReport {
  return {
    results: [...results],
    allowed: results.filter((r) => r.outcome.decision.allowed).length,
    blocked: results.filter((r) => !r.outcome.decision.allowed).length,
    mismatches: results.flatMap((r) => (r.mismatch === undefined ? [] : [`step ${r.step.label}: ${r.mismatch}`])),
  };
}

export async function runSteps(port: AgentPort, steps: readonly Step[], print: Print): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) results.push(await runStep(port, step, print));
  return results;
}

// ---------------------------------------------------------------------------
// The normal scenario
// ---------------------------------------------------------------------------

/** The owner test address allowed by demo/rules.json. */
export const OWNER_TEST_RECEIVER = "0x1111111111111111111111111111111111111111";

/**
 * Ordinary trading inside demo/rules.json: 4 orders, 71 quote units of the daily cap (BTC 50,
 * ETH 20, USDC 1, leverage 0). That stays inside what the injection scenario leaves room for
 * when both run on the same UTC day (at most 100 units and 6 orders).
 */
export function normalSteps(port: AgentPort, nonces: HlNonceClock = new HlNonceClock(port)): Step[] {
  const step = (label: string, title: string, build: () => Promise<Proposal>): Step => ({
    label,
    kind: "normal",
    title,
    build,
    expect: EXPECT_ALLOWED,
  });
  return [
    step("1", "buy 0.001 BTC at limit 50000 (far below market)", async () =>
      hlOrder({ market: "BTC", isBuy: true, limitPx: "50000", sz: "0.001", nonceMs: await nonces.next() }),
    ),
    step("2", "set BTC leverage to 3x (cross margin)", async () =>
      hlUpdateLeverage({ market: "BTC", isCross: true, leverage: 3, nonceMs: await nonces.next() }),
    ),
    step("3", "sell 0.01 ETH at limit 2000", async () =>
      hlOrder({ market: "ETH", isBuy: false, limitPx: "2000", sz: "0.01", nonceMs: await nonces.next() }),
    ),
    step("4", `send 1 USDC (1000000 raw units) to the owner test address ${OWNER_TEST_RECEIVER} on Base Sepolia`, async () =>
      evmTransfer({ token: "USDC", to: OWNER_TEST_RECEIVER, amount: "1000000", nonce: await nextEvmNonce(port) }),
    ),
  ];
}

export async function runNormalScenario(port: AgentPort, print: Print, nonces: HlNonceClock = new HlNonceClock(port)): Promise<ScenarioReport> {
  print("Scenario: normal trading inside the owner's rules");
  return summarize(await runSteps(port, normalSteps(port, nonces), print));
}

/**
 * Hyperliquid spike: one tiny limit order far below market, so that relaying it
 * shows whether Hyperliquid testnet accepts the MPC-derived signer without risking a fill.
 */
export function spikeSteps(nonces: HlNonceClock): Step[] {
  return [
    {
      label: "1",
      kind: "spike",
      title: "buy 0.001 BTC at limit 1000 (far below market, for the Hyperliquid signature check)",
      expect: EXPECT_ALLOWED,
      build: async () => hlOrder({ market: "BTC", isBuy: true, limitPx: "1000", sz: "0.001", nonceMs: await nonces.next() }),
    },
  ];
}
