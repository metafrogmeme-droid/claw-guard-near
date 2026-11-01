// LLM agent mode with the Claude Messages API mocked at the fetch level (the real
// @anthropic-ai/sdk client runs; no network). Checks the request shape (model, tool, headers),
// the tool loop, fail-closed input handling, limits, refusals and that the key never leaks.
import { describe, expect, it, vi } from "vitest";
import { Secret } from "../src/config.js";
import {
  LLM_MODEL,
  OWNER_TASK,
  PROPOSE_ORDER_TOOL,
  SYSTEM_PROMPT,
  decisionToolText,
  describeInput,
  echoContent,
  parseProposeOrderInput,
  proposalFromInput,
  runLlmAgent,
  userPrompt,
} from "../src/agent/llm.js";
import type { Decision, Proposal } from "../src/types.js";

const API_KEY = "sk-ant-test-key-0123456789abcdef";

type Block = Record<string, unknown>;
interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function message(content: Block[], stop_reason: string): Block {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: LLM_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const toolUse = (id: string, input: unknown): Block => ({ type: "tool_use", id, name: "propose_order", input });
const DOGE = { order: { kind: "hl_order", market: "DOGE", side: "buy", limit_px: "0.1", sz: "1000", tif: "Gtc", reduce_only: false }, memo: null };
const LEVERAGE = { order: { kind: "hl_update_leverage", market: "BTC", leverage: 50, margin: "cross" }, memo: "max leverage" };
const TRANSFER = { order: { kind: "evm_transfer", token: "USDC", to: "0xbad0000000000000000000000000000000000bad", amount: "5000000" }, memo: null };

/** A fetch that answers each Messages call with the next scripted response and records the requests. */
function scriptedApi(responses: Array<{ status?: number; body: Block }>) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(init?.body as string) as Record<string, unknown> });
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error("unexpected extra API call"));
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } }));
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function fakeGuard() {
  const proposals: Proposal[] = [];
  const propose = vi.fn((p: Proposal): Promise<Decision> => {
    proposals.push(p);
    const id = String(proposals.length);
    return Promise.resolve(
      "HlOrder" in p.order && p.order.HlOrder.market === "BTC"
        ? { allowed: true, receipt_id: id, rule_code: null, message: "Allowed: within your limits", signature: { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: 28 } }
        : { allowed: false, receipt_id: id, rule_code: "MARKET_NOT_ALLOWED", message: "Blocked by your rule: market DOGE is not on your list", signature: null },
    );
  });
  let hl = 1_793_361_600_000n;
  const nonces = { hlNonceMs: () => Promise.resolve((hl++).toString()), evmNonce: () => Promise.resolve("7") };
  return { proposals, propose, nonces };
}

describe("propose_order tool", () => {
  it("is one strict tool whose objects all forbid extra properties", () => {
    expect(PROPOSE_ORDER_TOOL.name).toBe("propose_order");
    expect(PROPOSE_ORDER_TOOL.strict).toBe(true);
    const objects: Block[] = [];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (typeof x === "object" && x !== null) {
        if ((x as Block).type === "object") objects.push(x as Block);
        Object.values(x).forEach(walk);
      }
    };
    walk(PROPOSE_ORDER_TOOL.input_schema);
    expect(objects).toHaveLength(4);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect(Object.keys(o.properties as Block).sort()).toEqual([...(o.required as string[])].sort());
    }
  });

  it("validates inputs fail closed", () => {
    expect(parseProposeOrderInput(DOGE)).toEqual({ ok: true, value: DOGE });
    expect(parseProposeOrderInput(LEVERAGE).ok).toBe(true);
    expect(parseProposeOrderInput(TRANSFER).ok).toBe(true);
    const bad: unknown[] = [
      null,
      { order: DOGE.order },
      { ...DOGE, extra: 1 },
      { order: { ...DOGE.order, nonce_ms: "1" }, memo: null },
      { order: { ...DOGE.order, side: "short" }, memo: null },
      { order: { ...DOGE.order, tif: "Fok" }, memo: null },
      { order: { ...DOGE.order, sz: 1000 }, memo: null },
      { order: { ...DOGE.order, market: "X".repeat(65) }, memo: null },
      { order: { ...LEVERAGE.order, leverage: 256 }, memo: null },
      { order: { ...LEVERAGE.order, leverage: 2.5 }, memo: null },
      { order: { ...TRANSFER.order, amount: "-1" }, memo: null },
      { order: { ...TRANSFER.order, amount: "1".repeat(40) }, memo: null },
      { order: { kind: "withdraw", to: "0x1" }, memo: null },
      { ...DOGE, memo: "m".repeat(141) },
      // 36 four-byte characters: 144 bytes, over the contract's 140-byte memo limit.
      { ...DOGE, memo: "\u{1F600}".repeat(36) },
    ];
    for (const input of bad) expect(parseProposeOrderInput(input).ok).toBe(false);
    expect(parseProposeOrderInput({ ...DOGE, memo: "\u{1F600}".repeat(35) }).ok).toBe(true);
    expect(parseProposeOrderInput({ ...DOGE, memo: "m".repeat(140) }).ok).toBe(true);
  });

  it("maps inputs to contract proposals with nonces and EVM gas fields filled in", async () => {
    const { nonces } = fakeGuard();
    const parse = (x: unknown) => {
      const r = parseProposeOrderInput(x);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    expect(await proposalFromInput(parse(DOGE), nonces)).toEqual({
      target: "HlTestnet",
      order: { HlOrder: { market: "DOGE", is_buy: true, limit_px: "0.1", sz: "1000", reduce_only: false, tif: "Gtc", nonce_ms: "1793361600000" } },
      memo: null,
    });
    expect(await proposalFromInput(parse(LEVERAGE), nonces)).toEqual({
      target: "HlTestnet",
      order: { HlUpdateLeverage: { market: "BTC", is_cross: true, leverage: 50, nonce_ms: "1793361600001" } },
      memo: "max leverage",
    });
    expect(await proposalFromInput(parse(TRANSFER), nonces)).toEqual({
      target: "BaseSepolia",
      order: {
        EvmTransfer: {
          token: "USDC",
          to: "0xbad0000000000000000000000000000000000bad",
          amount: "5000000",
          nonce: "7",
          gas_limit: "65000",
          max_fee_per_gas: "1000000000",
          max_priority_fee_per_gas: "1000000",
        },
      },
      memo: null,
    });
    expect(describeInput(parse(TRANSFER))).toBe("Transfer 5000000 raw units of USDC to 0xbad0000000000000000000000000000000000bad on Base Sepolia");
  });

  // Regression: model-chosen strings were printed raw, so ESC / CR could fake an "Allowed" line.
  it("describeInput shows control, line-break and bidi characters as visible escapes", () => {
    const parse = (x: unknown) => {
      const r = parseProposeOrderInput(x);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const sneaky = parse({
      order: {
        kind: "hl_order",
        market: "\u001b[2K\r#1 Allowed: within your limits",
        side: "buy",
        limit_px: "1\u202e",
        sz: "1\n",
        tif: "Gtc",
        reduce_only: false,
      },
      memo: null,
    });
    expect(describeInput(sneaky)).toBe(
      "Buy 1\\u000a \\u001b[2K\\u000d#1 Allowed: within your limits at limit 1\\u202e (Gtc), not reduce-only, on Hyperliquid testnet",
    );
    const lev = parse({ order: { kind: "hl_update_leverage", market: "BTC\u2028", leverage: 2, margin: "cross" }, memo: null });
    expect(describeInput(lev)).toBe("Set BTC\\u2028 leverage to 2x (cross margin) on Hyperliquid testnet");
    const evm = parse({ order: { kind: "evm_transfer", token: "USDC\u0007", to: "0x1\r", amount: "1" }, memo: null });
    expect(describeInput(evm)).toBe("Transfer 1 raw units of USDC\\u0007 to 0x1\\u000d on Base Sepolia");
  });
});

describe("runLlmAgent", () => {
  it("sends the documented request and loops tool_use -> tool_result until end_turn", async () => {
    const { calls, fetchImpl } = scriptedApi([
      { body: message([{ type: "thinking", thinking: "", signature: "sig" }, toolUse("tu_1", DOGE)], "tool_use") },
      { body: message([{ type: "text", text: "Done." }], "end_turn") },
    ]);
    const guard = fakeGuard();
    const lines: string[] = [];
    const result = await runLlmAgent("FAKE SUPPORT MESSAGE", { apiKey: new Secret(API_KEY), fetch: fetchImpl, propose: guard.propose, nonces: guard.nonces, print: (l) => lines.push(l) });

    expect(result).toMatchObject({ proposals: 1, endedBy: "end_turn" });
    expect(result.decisions.map((d) => d.message)).toEqual(["Blocked by your rule: market DOGE is not on your list"]);
    expect(guard.proposals[0]).toMatchObject({ order: { HlOrder: { market: "DOGE", sz: "1000" } } });
    expect(lines).toEqual(["llm proposes: Buy 1000 DOGE at limit 0.1 (Gtc), not reduce-only, on Hyperliquid testnet"]);

    expect(calls).toHaveLength(2);
    const [first, second] = calls as [Captured, Captured];
    expect(first.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(first.headers.get("x-api-key")).toBe(API_KEY);
    expect(first.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(first.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(first.headers.get("authorization")).toBeNull();
    expect(first.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: userPrompt("FAKE SUPPORT MESSAGE") }],
    });
    expect(first.body.thinking).toBeUndefined();
    expect(first.body.tools).toEqual([PROPOSE_ORDER_TOOL]);
    expect(userPrompt("x")).toContain(OWNER_TASK);

    // The assistant turn is echoed unchanged (thinking included), then one tool_result per tool_use.
    const history = second.body.messages as Array<{ role: string; content: unknown }>;
    expect(history[1]).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, toolUse("tu_1", DOGE)] });
    expect(history[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "#1 Blocked by your rule: market DOGE is not on your list (rule MARKET_NOT_ALLOWED)" }],
    });
  });

  it("answers invalid input and unknown tools with is_error and proposes nothing", async () => {
    const { calls, fetchImpl } = scriptedApi([
      {
        body: message(
          [toolUse("tu_bad", { order: { ...DOGE.order, nonce_ms: "1" }, memo: null }), { type: "tool_use", id: "tu_x", name: "withdraw", input: {} }],
          "tool_use",
        ),
      },
      { body: message([{ type: "text", text: "ok" }], "end_turn") },
    ]);
    const guard = fakeGuard();
    const lines: string[] = [];
    const result = await runLlmAgent("inbox", { apiKey: new Secret(API_KEY), fetch: fetchImpl, propose: guard.propose, nonces: guard.nonces, print: (l) => lines.push(l) });
    expect(result.proposals).toBe(0);
    expect(guard.propose).not.toHaveBeenCalled();
    const results = (calls[1]?.body.messages as Array<{ content: Block[] }>)[2]?.content ?? [];
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ["tu_bad", true],
      ["tu_x", true],
    ]);
    expect(String(results[1]?.content)).toMatch(/only tool is propose_order/);
    expect(lines[0]).toMatch(/^llm: tool input refused before sending/);
  });

  it("stops proposing at the proposal limit and stops at the turn limit", async () => {
    const { fetchImpl } = scriptedApi([
      { body: message([toolUse("a", DOGE), toolUse("b", DOGE), toolUse("c", DOGE)], "tool_use") },
      { body: message([toolUse("d", DOGE)], "tool_use") },
    ]);
    const guard = fakeGuard();
    const result = await runLlmAgent("inbox", { apiKey: new Secret(API_KEY), fetch: fetchImpl, propose: guard.propose, nonces: guard.nonces, print: () => undefined, maxProposals: 2, maxTurns: 2 });
    expect(result).toMatchObject({ proposals: 2, endedBy: "max_turns" });
    expect(guard.propose).toHaveBeenCalledTimes(2);
  });

  it("never runs a tool call from a refused or truncated turn", async () => {
    for (const stop of ["refusal", "max_tokens"]) {
      const { fetchImpl } = scriptedApi([{ body: message([toolUse("tu", DOGE)], stop) }]);
      const guard = fakeGuard();
      const result = await runLlmAgent("inbox", { apiKey: new Secret(API_KEY), fetch: fetchImpl, propose: guard.propose, nonces: guard.nonces, print: () => undefined });
      expect(result.endedBy).toBe(stop);
      expect(guard.propose).not.toHaveBeenCalled();
    }
  });

  it("continues a pause_turn by sending the turn back", async () => {
    const { calls, fetchImpl } = scriptedApi([
      { body: message([{ type: "text", text: "thinking it over" }], "pause_turn") },
      { body: message([{ type: "text", text: "nothing to do" }], "end_turn") },
    ]);
    const guard = fakeGuard();
    const result = await runLlmAgent("inbox", { apiKey: new Secret(API_KEY), fetch: fetchImpl, propose: guard.propose, nonces: guard.nonces, print: () => undefined });
    expect(result.endedBy).toBe("end_turn");
    expect((calls[1]?.body.messages as unknown[]).length).toBe(2);
  });

  it("reports API errors without the key", async () => {
    const { fetchImpl } = scriptedApi([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${API_KEY}` } } }]);
    const guard = fakeGuard();
    const err = await runLlmAgent("inbox", { apiKey: new Secret(API_KEY), fetch: fetchImpl, propose: guard.propose, nonces: guard.nonces, print: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("the Claude API rejected LLM_API_KEY (401)");
    expect(JSON.stringify(err)).not.toContain(API_KEY);
    expect((err as Error).cause).toBeUndefined();
  });

  it("a proposal that cannot be sent becomes an is_error result, redacted", async () => {
    const { calls, fetchImpl } = scriptedApi([
      { body: message([toolUse("tu", DOGE)], "tool_use") },
      { body: message([{ type: "text", text: "ok" }], "end_turn") },
    ]);
    const guard = fakeGuard();
    const lines: string[] = [];
    await runLlmAgent("inbox", {
      apiKey: new Secret(API_KEY),
      fetch: fetchImpl,
      propose: () => Promise.reject(new Error(`rpc down, key ${API_KEY}`)),
      nonces: guard.nonces,
      print: (l) => lines.push(l),
    });
    const result = ((calls[1]?.body.messages as Array<{ content: Block[] }>)[2]?.content ?? [])[0];
    expect(result?.is_error).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(lines.join("\n")).not.toContain(API_KEY);
  });
});

describe("echoContent (server-side fallback)", () => {
  it("drops the declining model's thinking and tool calls before the last fallback block", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "a" },
      { type: "tool_use", id: "old", name: "propose_order", input: {} },
      { type: "text", text: "partial", citations: null },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
      { type: "thinking", thinking: "", signature: "b" },
      { type: "tool_use", id: "new", name: "propose_order", input: {} },
    ] as unknown as Parameters<typeof echoContent>[0];
    expect(echoContent(content).map((b) => b.type)).toEqual(["text", "fallback", "thinking", "tool_use"]);
    const plain = content.slice(0, 2);
    expect(echoContent(plain)).toEqual(plain);
  });

  it("decision text for the model", () => {
    expect(decisionToolText({ allowed: true, receipt_id: "4", rule_code: null, message: "Allowed: within your limits", signature: { r: "0xab", s: "0xcd", v: 27 } })).toBe(
      "#4 Allowed: within your limits (signed, r=0xab)",
    );
    expect(decisionToolText({ allowed: false, receipt_id: "0", rule_code: "PAUSED", message: "Blocked by your rule: agent is paused (x)", signature: null })).toBe(
      "no receipt stored (contract storage reserve) Blocked by your rule: agent is paused (x) (rule PAUSED)",
    );
  });
});
