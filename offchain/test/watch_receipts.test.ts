// Claw Watch receipts / pause source: the prompt-injection scenario fixtures served as
// claw-guard views through near-api-js + ClawGuardClient (global fetch routed to the fixture).
import { JsonRpcProvider } from "near-api-js";
import { describe, expect, it } from "vitest";
import { ClawGuardClient } from "../src/near.js";
import { type GuardStatus, type Receipt, parseReceipt } from "../src/types.js";
import type { Alert } from "../src/watch/alerts.js";
import { type ReceiptsReader, ReceiptsWatch, restoreReceiptsState } from "../src/watch/receipts.js";
import { type NearRpcState, type ViewsFixture, type ViewsStep, loadFixture, nearRpcFetch, withGlobalFetch } from "./fixtures/replay.js";
import { BANNED_COPY } from "./helpers.js";

const fixture = loadFixture<ViewsFixture>("clawguard_views.json");
const step = (name: string): ViewsStep => {
  const s = fixture.steps[name];
  if (s === undefined) throw new Error(`no fixture step ${name}`);
  return s;
};
const texts = (alerts: readonly Alert[]) => alerts.map((a) => a.text);

function setup() {
  const state: NearRpcState = { views: step("baseline") };
  const client = new ClawGuardClient(new JsonRpcProvider({ url: "http://127.0.0.1:3030" }), fixture.contract_id);
  const watch = new ReceiptsWatch({ reader: client });
  const poll = () => withGlobalFetch(nearRpcFetch(state), () => watch.poll());
  return { watch, poll, goTo: (name: string) => (state.views = step(name)) };
}

const INJECTION_LINES = [
  "Order #2 by agent-1.test.near: Blocked by your rule: market DOGE is not on your list",
  "Order #3 by agent-1.test.near: Blocked by your rule: order is above your per-order cap",
  "Order #4 by agent-1.test.near: Blocked by your rule: leverage 50x is above your limit of 3x",
  "Order #5 by agent-1.test.near: Blocked by your rule: receiver 0xbadbadbadbadbadbadbadbadbadbadbadbadbad0 is not on your list",
  "Order #6 by agent-1.test.near: Blocked by your rule: this order would go over your daily cap",
];

describe("ReceiptsWatch on the injection scenario", () => {
  it("first poll records the baseline only", async () => {
    const { poll, watch } = setup();
    expect(await poll()).toEqual({ alerts: [], errors: [], baseline: true });
    expect(watch.state).toMatchObject({ contract_id: "clawguard.test.near", last_seen_id: 1, paused: false });
  });

  it("each new Blocked receipt is an alert with the receipt message verbatim, plus one burst alert", async () => {
    const { poll, goTo } = setup();
    await poll();
    goTo("injection");
    const { alerts, errors } = await poll();
    expect(errors).toEqual([]);
    expect(texts(alerts)).toEqual([...INJECTION_LINES, "Public signal: 5 orders blocked in the last 10 min"]);
    const receipts = step("injection").receipts.map((r) => parseReceipt(r));
    for (const alert of alerts.filter((a) => a.kind === "order_blocked")) {
      const receipt = receipts.find((r) => r.id === alert.receiptId) as Receipt;
      expect(alert.text.endsWith(`: ${receipt.message}`)).toBe(true);
      expect(alert.text).toContain(": Blocked by your rule: ");
    }
    expect(alerts.at(-1)).toMatchObject({ kind: "blocked_burst", count: 5, autopauseReason: "watch: 5 blocked orders in 10 min" });
  });

  it("pause and unpause from get_status", async () => {
    const { poll, goTo } = setup();
    goTo("injection");
    await poll();
    goTo("paused");
    expect(texts((await poll()).alerts)).toEqual([
      "Order #7 by agent-1.test.near: Blocked by your rule: agent is paused (watch: new full-access key)",
      "Public signal: agent paused (watch: new full-access key)",
    ]);
    expect(await poll()).toEqual({ alerts: [], errors: [], baseline: false });
    goTo("unpaused");
    expect(texts((await poll()).alerts)).toEqual(["Public signal: agent unpaused"]);
  });

  it("paused / unpaused events name who did it, and the next status poll does not repeat them", async () => {
    const { poll, goTo, watch } = setup();
    goTo("injection");
    await poll();
    const event = (name: string, data: Record<string, unknown>) => ({ standard: "clawguard", version: "1.0.0", event: name, data: [data] });
    const paused = watch.observeEvents([event("paused", { by: "guardian.test.near", reason: "watch: new full-access key" })]);
    expect(texts(paused)).toEqual(["Public signal: agent paused by guardian.test.near (watch: new full-access key)"]);
    expect(watch.paused).toBe(true);
    goTo("paused");
    expect(texts((await poll()).alerts)).toEqual([
      "Order #7 by agent-1.test.near: Blocked by your rule: agent is paused (watch: new full-access key)",
    ]);
    const unpaused = watch.observeEvents([event("unpaused", { by: "owner.test.near", reason: "watch: new full-access key" })]);
    expect(texts(unpaused)).toEqual(["Public signal: agent unpaused by owner.test.near"]);
    expect(watch.observeEvents([event("order_blocked", { receipt_id: "9" })])).toEqual([]);
    expect(new Set([...paused, ...unpaused].map((a) => a.key)).size).toBe(2);
  });

  it("no banned words in any receipts alert", async () => {
    const { poll, goTo } = setup();
    await poll();
    goTo("paused");
    const { alerts } = await poll();
    expect(alerts.length).toBe(8);
    for (const a of alerts) {
      expect(a.text).not.toMatch(BANNED_COPY);
      expect(a.text).toMatch(/^(Public signal: |Order #\d+ by \S+: Blocked by your rule: )/);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases with an in-memory reader
// ---------------------------------------------------------------------------

const MIN = 60_000;
function blocked(id: number, atMs: number, agent = "agent-1.test.near"): Receipt {
  return {
    id: String(id),
    agent_id: agent,
    target: "HlTestnet",
    proposal: {
      target: "HlTestnet",
      order: { HlOrder: { market: "DOGE", is_buy: true, limit_px: "1", sz: "1", reduce_only: false, tif: "Gtc", nonce_ms: "1" } },
      memo: null,
    },
    status: "Blocked",
    rule_code: "MARKET_NOT_ALLOWED",
    message: "Blocked by your rule: market DOGE is not on your list",
    payload_hash: null,
    signed_body: null,
    derivation_path: null,
    signature: null,
    rules_version: 1,
    block_height: String(id),
    timestamp_ns: (BigInt(atMs) * 1_000_000n).toString(),
  };
}

class MemoryReader implements ReceiptsReader {
  readonly contractId = "clawguard.test.near";
  receipts: Receipt[] = [];
  paused = false;
  reason: string | null = null;
  count: number | undefined;
  failPageFrom: number | undefined;
  getStatus(): Promise<GuardStatus> {
    return Promise.resolve({
      owner: "owner.test.near",
      guardian: null,
      paused: this.paused,
      pause_reason: this.reason,
      mpc_contract_id: "mock-mpc.test.near",
      agents_count: 1,
      receipts_count: this.count ?? this.receipts.length,
    });
  }
  getReceipts(fromId: number, limit: number): Promise<Receipt[]> {
    if (this.failPageFrom !== undefined && fromId >= this.failPageFrom) return Promise.reject(new Error("RPC timeout"));
    return Promise.resolve(this.receipts.filter((r) => Number(r.id) >= fromId).slice(0, limit));
  }
}

describe("ReceiptsWatch edge cases", () => {
  it("two blocked receipts are not a burst; a third within 10 min is; then a cooldown of one window", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader });
    await watch.poll();
    reader.receipts.push(blocked(1, 0), blocked(2, MIN));
    expect((await watch.poll()).alerts.map((a) => a.kind)).toEqual(["order_blocked", "order_blocked"]);
    reader.receipts.push(blocked(3, 2 * MIN));
    const third = await watch.poll();
    expect(texts(third.alerts)).toContain("Public signal: 3 orders blocked in the last 10 min");
    reader.receipts.push(blocked(4, 5 * MIN), blocked(5, 6 * MIN));
    expect((await watch.poll()).alerts.map((a) => a.kind)).toEqual(["order_blocked", "order_blocked"]); // cooldown
    reader.receipts.push(blocked(6, 12 * MIN));
    const later = await watch.poll();
    // Window (2 min, 12 min]: receipts 4, 5, 6.
    expect(later.alerts.find((a) => a.kind === "blocked_burst")).toMatchObject({ count: 3, receiptIds: ["4", "5", "6"] });
  });

  it("blocked receipts spread over more than 10 min are not a burst", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader });
    await watch.poll();
    reader.receipts.push(blocked(1, 0), blocked(2, 11 * MIN), blocked(3, 22 * MIN));
    expect((await watch.poll()).alerts.some((a) => a.kind === "blocked_burst")).toBe(false);
  });

  it("reads more than one page and never re-reports a receipt", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader, burstThreshold: 1000 });
    await watch.poll();
    for (let i = 1; i <= 120; i += 1) reader.receipts.push(blocked(i, i));
    expect((await watch.poll()).alerts).toHaveLength(120);
    expect((await watch.poll()).alerts).toHaveLength(0);
  });

  it("a page that fails keeps the alerts already read and resumes after them", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader, burstThreshold: 1000 });
    await watch.poll();
    for (let i = 1; i <= 60; i += 1) reader.receipts.push(blocked(i, i));
    reader.failPageFrom = 51;
    const partial = await watch.poll();
    expect(partial.alerts).toHaveLength(50);
    expect(partial.errors).toEqual(["cannot read receipts after #50: RPC timeout"]);
    reader.failPageFrom = undefined;
    const rest = await watch.poll();
    expect(rest.alerts.map((a) => (a.kind === "order_blocked" ? a.receiptId : "")).slice(0, 2)).toEqual(["51", "52"]);
    expect(rest.alerts).toHaveLength(10);
  });

  it("receipts that left the ring buffer are reported as a gap, not as alerts", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader, burstThreshold: 10_000 });
    await watch.poll();
    for (let i = 1; i <= 1200; i += 1) reader.receipts.push(blocked(i, i));
    reader.receipts = reader.receipts.slice(200); // ids 201..1200 still held
    reader.count = 1200; // receipts_count = total ever created
    const result = await watch.poll();
    expect(result.errors).toEqual(["200 receipts left the contract's ring buffer before they were read"]);
    expect(result.alerts).toHaveLength(1000);
  });

  it("a receipt count that goes down means a new contract: new baseline", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader });
    reader.receipts.push(blocked(1, 0), blocked(2, 1));
    await watch.poll();
    reader.receipts = [];
    const result = await watch.poll();
    expect(result).toMatchObject({ alerts: [], baseline: true });
    expect(result.errors[0]).toMatch(/receipt count went down from 2 to 0/);
  });

  it("re-pausing with a new reason is a new pause alert; the same reason is not", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader });
    await watch.poll();
    reader.paused = true;
    reader.reason = "maintenance";
    expect(texts((await watch.poll()).alerts)).toEqual(["Public signal: agent paused (maintenance)"]);
    expect((await watch.poll()).alerts).toEqual([]);
    reader.reason = "watch: new API wallet";
    expect(texts((await watch.poll()).alerts)).toEqual(["Public signal: agent paused (watch: new API wallet)"]);
  });

  it("restoreReceiptsState validates a stored state; a baseline for another contract is ignored", async () => {
    const reader = new MemoryReader();
    const watch = new ReceiptsWatch({ reader });
    await watch.poll();
    const stored = JSON.parse(JSON.stringify(watch.state)) as unknown;
    expect(restoreReceiptsState(stored)).toEqual(watch.state);
    expect(restoreReceiptsState({ ...(stored as object), last_seen_id: -1 })).toBeUndefined();
    expect(restoreReceiptsState({ ...(stored as object), recent_blocked: [["1"]] })).toBeUndefined();
    const other = restoreReceiptsState({ ...(stored as object), contract_id: "other.test.near" });
    expect(other).toBeDefined();
    const fresh = new ReceiptsWatch({ reader, ...(other === undefined ? {} : { baseline: other }) });
    expect(fresh.state).toBeUndefined();
  });

  it("a status read failure fails the poll (the watcher reports it)", async () => {
    const reader = new MemoryReader();
    reader.getStatus = () => Promise.reject(new Error("RPC down"));
    await expect(new ReceiptsWatch({ reader }).poll()).rejects.toThrow("RPC down");
  });
});
