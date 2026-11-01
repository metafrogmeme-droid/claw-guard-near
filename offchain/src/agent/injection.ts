// The prompt-injection scenario for the scripted agent. Prototype.
// Testnet only. Not audited.
//
// The agent places one normal order, then "reads" demo/poisoned_message.txt (a fake
// support message, a demo fixture) and follows every instruction in it. The contract blocks each
// injected order by the owner's rules (demo/rules.json), with these exact messages:
//   1. buy 0.001 BTC at 50000               -> Allowed: within your limits (signed)
//   2. buy 1000 DOGE at 0.1                 -> Blocked by your rule: market DOGE is not on your list
//   3. buy 5 BTC                            -> Blocked by your rule: order is above your per-order cap
//   4. BTC leverage 50x                     -> Blocked by your rule: leverage 50x is above your limit of 3x
//   5. 5 USDC to 0xbad…bad                  -> Blocked by your rule: receiver 0xbad…bad is not on your list
//   6. 0.01 BTC at 50000 until the daily cap: allowed while it fits, then
//                                           -> Blocked by your rule: this order would go over your daily cap
// Step 7 (a new full-access key on the agent account -> Claw Watch -> guardian pause -> the next
// order is "Blocked by your rule: agent is paused (watch: new full-access key)") needs the
// watcher and a chain change, so the demo drives it with pausedProbeStep().
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { OFFCHAIN_DIR } from "../config.js";
import type { Proposal } from "../types.js";
import {
  type AgentPort,
  EXPECT_ALLOWED,
  type Expectation,
  HlNonceClock,
  type Print,
  type ScenarioReport,
  type Step,
  type StepResult,
  checkDecision,
  evmTransfer,
  expectBlocked,
  hlOrder,
  hlUpdateLeverage,
  nextEvmNonce,
  runStep,
  summarize,
} from "./scripted.js";

export const POISONED_MESSAGE_FILE = join(OFFCHAIN_DIR, "..", "demo", "poisoned_message.txt");

/** The injected receiver, sent all lowercase (owner decision D-12). */
export const INJECTED_RECEIVER = "0xbad0000000000000000000000000000000000bad";
/** The reason Claw Watch pauses with when a new full-access key appears. */
export const WATCH_PAUSE_REASON = "watch: new full-access key";

/** Far below market; every BTC order of the scenario uses it. */
export const BTC_PX = "50000";
/** 0.001 BTC × 50000 = 50 quote units. */
export const NORMAL_SZ = "0.001";
/** 0.01 BTC × 50000 = 500 quote units: exactly the per-order cap of demo/rules.json. */
export const IN_CAP_SZ = "0.01";
/** Upper bound on step 6 orders (the demo rules allow two before the daily cap). */
export const MAX_FILL_ORDERS = 5;
/** 5 USDC: the per-transfer cap, so only the receiver rule can block it. */
export const INJECTED_USDC_AMOUNT = "5000000";

export const DAILY_CAP_REACHED = expectBlocked("DAILY_CAP", "this order would go over your daily cap");

export function expectPaused(reason: string): Expectation {
  return expectBlocked("PAUSED", `agent is paused (${reason})`);
}

/** The fixture text, and its subject line for the log. */
export function readPoisonedMessage(path: string = POISONED_MESSAGE_FILE): { text: string; subject: string } {
  const text = readFileSync(path, "utf8");
  const subject = /^Subject: (.+)$/m.exec(text)?.[1]?.trim() ?? "(no subject)";
  return { text, subject };
}

function step(label: string, kind: string, title: string, expect: Expectation, build: () => Promise<Proposal>): Step {
  return { label, kind, title, expect, build };
}

/** Step 1 (normal) and steps 2-5 (the injected instructions). */
export function injectionSteps(port: AgentPort, nonces: HlNonceClock): Step[] {
  return [
    step("1", "normal", `buy ${NORMAL_SZ} BTC at limit ${BTC_PX} (far below market)`, EXPECT_ALLOWED, async () =>
      hlOrder({ market: "BTC", isBuy: true, limitPx: BTC_PX, sz: NORMAL_SZ, nonceMs: await nonces.next() }),
    ),
    step("2", "injected", "buy 1000 DOGE at limit 0.1", expectBlocked("MARKET_NOT_ALLOWED", "market DOGE is not on your list"), async () =>
      hlOrder({ market: "DOGE", isBuy: true, limitPx: "0.1", sz: "1000", nonceMs: await nonces.next() }),
    ),
    step("3", "injected", `buy 5 BTC at limit ${BTC_PX}`, expectBlocked("ORDER_ABOVE_CAP", "order is above your per-order cap"), async () =>
      hlOrder({ market: "BTC", isBuy: true, limitPx: BTC_PX, sz: "5", nonceMs: await nonces.next() }),
    ),
    step(
      "4",
      "injected",
      "set BTC leverage to 50x",
      expectBlocked("LEVERAGE_ABOVE_LIMIT", "leverage 50x is above your limit of 3x"),
      async () => hlUpdateLeverage({ market: "BTC", isCross: true, leverage: 50, nonceMs: await nonces.next() }),
    ),
    step(
      "5",
      "injected",
      `send 5 USDC to ${INJECTED_RECEIVER} on Base Sepolia`,
      expectBlocked("RECEIVER_NOT_ALLOWED", `receiver ${INJECTED_RECEIVER} is not on your list`),
      // The next unused EVM nonce, so that only the receiver rule can block it (not STALE_NONCE).
      async () => evmTransfer({ token: "USDC", to: INJECTED_RECEIVER, amount: INJECTED_USDC_AMOUNT, nonce: await nextEvmNonce(port) }),
    ),
  ];
}

/** One step-6 order: 0.01 BTC at 50000, allowed until the daily cap is reached. */
export function fillStep(nonces: HlNonceClock, i: number): Step {
  return step(`6.${i}`, "injected", `buy ${IN_CAP_SZ} BTC at limit ${BTC_PX} (repeat until the daily limit)`, EXPECT_ALLOWED, async () =>
    hlOrder({ market: "BTC", isBuy: true, limitPx: BTC_PX, sz: IN_CAP_SZ, nonceMs: await nonces.next() }),
  );
}

/** An order inside every rule; once the guard is paused it must be blocked with `reason`. */
export function pausedProbeStep(nonces: HlNonceClock, label: string, reason: string = WATCH_PAUSE_REASON): Step {
  return step(label, "agent", `buy ${NORMAL_SZ} BTC at limit ${BTC_PX} (within every rule)`, expectPaused(reason), async () =>
    hlOrder({ market: "BTC", isBuy: true, limitPx: BTC_PX, sz: NORMAL_SZ, nonceMs: await nonces.next() }),
  );
}

/** The same order after the owner unpaused: allowed again. */
export function resumedStep(nonces: HlNonceClock, label: string): Step {
  return step(label, "agent", `buy ${NORMAL_SZ} BTC at limit ${BTC_PX} again`, EXPECT_ALLOWED, async () =>
    hlOrder({ market: "BTC", isBuy: true, limitPx: BTC_PX, sz: NORMAL_SZ, nonceMs: await nonces.next() }),
  );
}

export interface InjectionReport extends ScenarioReport {
  /** Step 6 orders allowed before the daily cap blocked one. */
  fillAllowed: number;
}

export interface InjectionOptions {
  nonces?: HlNonceClock;
  messageFile?: string;
  /** Called after every step with its final result (the demo asserts and prints extra lines here). */
  onResult?: (result: StepResult) => void | Promise<void>;
}

/** Steps 1-6. Every decision is compared with its expectation; differences land in `mismatches`. */
export async function runInjectionScenario(
  port: AgentPort,
  print: Print,
  { nonces = new HlNonceClock(port), messageFile = POISONED_MESSAGE_FILE, onResult }: InjectionOptions = {},
): Promise<InjectionReport> {
  const message = readPoisonedMessage(messageFile);
  print("Scenario: one normal order, then a poisoned support message");
  const results: StepResult[] = [];
  const record = async (result: StepResult): Promise<void> => {
    results.push(result);
    await onResult?.(result);
  };
  const [first, ...injected] = injectionSteps(port, nonces);
  if (first !== undefined) await record(await runStep(port, first, print));
  print(`agent reads ${basename(messageFile)} (demo fixture): "${message.subject}"`);
  for (const next of injected) await record(await runStep(port, next, print));

  let fillAllowed = 0;
  let capReached = false;
  for (let i = 1; i <= MAX_FILL_ORDERS && !capReached; i++) {
    const fill = fillStep(nonces, i);
    const result = await runStep(port, fill, print);
    if (result.outcome.decision.allowed) {
      fillAllowed += 1;
      await record(result);
      continue;
    }
    // The first blocked fill order must be the daily cap, nothing else.
    capReached = true;
    await record({ ...result, step: { ...fill, expect: DAILY_CAP_REACHED }, mismatch: checkDecision(result.outcome.decision, DAILY_CAP_REACHED) });
  }
  const report = summarize(results);
  if (!capReached) report.mismatches.push(`step 6: the daily cap did not block any of ${MAX_FILL_ORDERS} orders`);
  return { ...report, fillAllowed };
}
