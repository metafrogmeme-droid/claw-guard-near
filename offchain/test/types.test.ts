// Contract JSON parsers: accept the spec'd wire shapes, reject everything else.
import { describe, expect, it } from "vitest";
import {
  ParseError,
  orderKind,
  parseAgentState,
  parseDecision,
  parseEventLog,
  parseGuardStatus,
  parsePaths,
  parsePreviewResult,
  parseReceipt,
  toU64,
} from "../src/types.js";
import { evmReceipt, evmTransfers, first, hlOrderReceipt, hlOrders } from "./helpers.js";

const rules = {
  targets: ["HlTestnet", "BaseSepolia"],
  markets: [{ name: "BTC", asset: 3, max_order_sz: "0.01", sz_decimals: 5 }],
  max_order_notional: "1000000000",
  max_leverage: 3,
  tokens: [{ symbol: "USDC", address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", decimals: 6, max_per_order: "5000000" }],
  receivers: ["0x1111111111111111111111111111111111111111"],
  daily_cap: "10000000",
  max_orders_per_day: 10,
  expires_at_ns: "1794000000000000000",
  reduce_only_required: false,
};

describe("receipts", () => {
  it("round-trips the fixture receipts (as JSON)", () => {
    for (const r of [hlOrderReceipt(first(hlOrders())), evmReceipt(first(evmTransfers()))]) {
      expect(parseReceipt(JSON.parse(JSON.stringify(r)))).toEqual(r);
    }
  });

  it("normalises hex case and treats a missing memo as null", () => {
    const r = JSON.parse(JSON.stringify(hlOrderReceipt(first(hlOrders())))) as Record<string, unknown>;
    r.payload_hash = String(r.payload_hash).toUpperCase().replace("0X", "0x");
    delete (r.proposal as Record<string, unknown>).memo;
    const parsed = parseReceipt(r);
    expect(parsed.payload_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parsed.proposal.memo).toBeNull();
  });

  it.each([
    ["unknown status", { status: "Approved" }],
    ["U64 as a number", { id: 1 }],
    ["unknown target", { target: "Ethereum" }],
    ["short signature r", { signature: { r: "0x12", s: `0x${"00".repeat(32)}`, v: 27 } }],
    ["order with two tags", { proposal: { target: "HlTestnet", order: { HlOrder: {}, EvmTransfer: {} } } }],
    ["unknown order kind", { proposal: { target: "HlTestnet", order: { Withdraw: {} } } }],
  ])("rejects %s", (_name, patch) => {
    expect(() => parseReceipt({ ...hlOrderReceipt(first(hlOrders())), ...patch })).toThrow(ParseError);
  });

  it("orderKind", () => {
    expect(orderKind(hlOrderReceipt(first(hlOrders())).proposal.order)).toBe("HlOrder");
    expect(orderKind(evmReceipt(first(evmTransfers())).proposal.order)).toBe("EvmTransfer");
  });
});

describe("views", () => {
  it("GuardStatus accepts counts as numbers or U64 strings", () => {
    const s = parseGuardStatus({
      owner: "owner.test.near",
      guardian: null,
      paused: true,
      pause_reason: "watch: new full-access key",
      mpc_contract_id: "mock-mpc.test.near",
      agents_count: 1,
      receipts_count: "7",
    });
    expect(s).toMatchObject({ paused: true, agents_count: 1, receipts_count: 7, guardian: null });
  });

  it("AgentState with and without pending rules", () => {
    const base = { rules, rules_version: 2, pending: null, day: 20756, spent_today: "0", orders_today: 0 };
    expect(parseAgentState(base)).toMatchObject({ pending: null, last_hl_nonce_ms: null, last_evm_nonce: null });
    expect(parseAgentState({ ...base, last_hl_nonce_ms: "1793318400000", last_evm_nonce: null }).last_hl_nonce_ms).toBe("1793318400000");
    const withPending = parseAgentState({ ...base, pending: [{ ...rules, max_leverage: 5 }, "1793318700000000000"] });
    expect(withPending.pending?.[0].max_leverage).toBe(5);
    expect(withPending.pending?.[1]).toBe("1793318700000000000");
    expect(() => parseAgentState({ ...base, pending: [rules] })).toThrow(ParseError);
  });

  it("MarketRule needs sz_decimals in 0..=6", () => {
    const market = (sz_decimals: unknown) => ({ ...rules, markets: [{ name: "BTC", asset: 3, max_order_sz: "0.01", sz_decimals }] });
    expect(parseAgentState({ rules: market(0), rules_version: 1, pending: null, day: 1, spent_today: "0", orders_today: 0 }).rules.markets[0]?.sz_decimals).toBe(0);
    for (const bad of [7, -1, 1.5, "5", undefined]) {
      expect(() => parseAgentState({ rules: market(bad), rules_version: 1, pending: null, day: 1, spent_today: "0", orders_today: 0 })).toThrow(ParseError);
    }
  });

  it("Decision", () => {
    expect(
      parseDecision({ allowed: false, receipt_id: "2", rule_code: "PAUSED", message: "Blocked by your rule: agent is paused (x)", signature: null }),
    ).toEqual({ allowed: false, receipt_id: "2", rule_code: "PAUSED", message: "Blocked by your rule: agent is paused (x)", signature: null });
    // "0": blocked, no receipt stored (the contract kept its storage reserve).
    expect(parseDecision({ allowed: false, receipt_id: "0", rule_code: "PAUSED", message: "Blocked by your rule: x", signature: null }).receipt_id).toBe("0");
  });

  it("PreviewResult and paths", () => {
    expect(parsePreviewResult({ Ok: `0x${"ab".repeat(32)}` })).toEqual({ Ok: `0x${"ab".repeat(32)}` });
    expect(parsePreviewResult({ Err: "Blocked by your rule: market DOGE is not on your list" })).toEqual({
      Err: "Blocked by your rule: market DOGE is not on your list",
    });
    expect(() => parsePreviewResult({ Ok: "0x12" })).toThrow(ParseError);
    expect(() => parsePreviewResult("0x12")).toThrow(ParseError);
    expect(
      parsePaths([
        ["HlTestnet", "hl-testnet-1"],
        ["BaseSepolia", "base-sepolia-1"],
      ]),
    ).toEqual([
      ["HlTestnet", "hl-testnet-1"],
      ["BaseSepolia", "base-sepolia-1"],
    ]);
  });
});

describe("events and helpers", () => {
  it("parses NEP-297 EVENT_JSON lines only", () => {
    const line = `EVENT_JSON:${JSON.stringify({
      standard: "clawguard",
      version: "1.0.0",
      event: "order_blocked",
      data: [{ receipt_id: "2", agent_id: "agent-1.test.near", target: "HlTestnet", rule_code: "MARKET_NOT_ALLOWED", message: "m" }],
    })}`;
    expect(parseEventLog(line)).toMatchObject({ standard: "clawguard", event: "order_blocked", data: [{ receipt_id: "2" }] });
    expect(parseEventLog("hello")).toBeUndefined();
    expect(parseEventLog("EVENT_JSON:{broken")).toBeUndefined();
    expect(parseEventLog('EVENT_JSON:{"standard":"clawguard","version":"1.0.0","event":"x","data":[1]}')).toBeUndefined();
  });

  it("toU64", () => {
    expect(toU64(12)).toBe("12");
    expect(toU64(12n)).toBe("12");
    expect(toU64("007")).toBe("7");
    expect(() => toU64(-1)).toThrow(RangeError);
    expect(() => toU64("18446744073709551616")).toThrow(RangeError);
  });
});
