// "What is being signed" decoder snapshots for the three order kinds, decoded from the
// signed bodies in the vectors, plus blocked proposals, mismatches, undecodable bodies, bodies the
// contract never builds, owner names for assets and tokens, and escaped control characters.
import { type Hex, serializeTransaction } from "viem";
import { describe, expect, it } from "vitest";
import { type RuleNames, describeReceipt, escapeUnprintable } from "../src/decode.js";
import type { Receipt } from "../src/types.js";
import {
  BANNED_COPY,
  DEMO_NAMES,
  blockedReceipt,
  evmReceipt,
  evmTransfers,
  first,
  hlLeverage,
  hlLeverageReceipt,
  hlOrderReceipt,
  hlOrders,
} from "./helpers.js";

const byName = <T extends { name: string }>(items: T[], name: string): T => {
  const found = items.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
};

describe("signed bodies", () => {
  it("HL order", () => {
    expect(describeReceipt(hlOrderReceipt(first(hlOrders())), DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Buy 0.001 BTC at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet",
        "Hyperliquid testnet asset 3, nonce 1793318400000, derivation path hl-testnet-1",
      ]
    `);
    expect(describeReceipt(hlOrderReceipt(byName(hlOrders(), "eth_buy_alo_reduce")), DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Buy 0.1 ETH at limit 2500.5 (Alo), reduce-only, on Hyperliquid testnet",
        "Hyperliquid testnet asset 4, nonce 1793318400002, derivation path hl-testnet-1",
      ]
    `);
  });

  it("HL updateLeverage", () => {
    expect(describeReceipt(hlLeverageReceipt(first(hlLeverage())), DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Set BTC leverage to 3x (cross margin) on Hyperliquid testnet",
        "Hyperliquid testnet asset 3, nonce 1793318400100, derivation path hl-testnet-1",
      ]
    `);
    expect(describeReceipt(hlLeverageReceipt(byName(hlLeverage(), "btc_isolated_1x")), DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Set BTC leverage to 1x (isolated margin) on Hyperliquid testnet",
        "Hyperliquid testnet asset 3, nonce 1793318400101, derivation path hl-testnet-1",
      ]
    `);
  });

  it("EVM transfer", () => {
    expect(describeReceipt(evmReceipt(first(evmTransfers())), DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Transfer 1000000 raw units of USDC to 0x1111111111111111111111111111111111111111 on Base Sepolia",
        "Token contract 0x036cbd53842c5426634e7929541ec2318f3dcf7e, chain 84532, nonce 0, gas limit 65000, max fee per gas 1000000000 wei, max priority fee per gas 1000000 wei, derivation path base-sepolia-1",
      ]
    `);
  });

  it("status prefixes for pending and failed signatures", () => {
    const r = hlOrderReceipt(first(hlOrders()));
    expect(describeReceipt({ ...r, status: "PendingSignature", signature: null }, DEMO_NAMES)[0]).toMatchInlineSnapshot(`"Waiting for signature: Buy 0.001 BTC at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet"`);
    expect(describeReceipt({ ...r, status: "SignFailed", signature: null }, DEMO_NAMES)[0]).toMatchInlineSnapshot(`"Signature request failed for: Buy 0.001 BTC at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet"`);
  });
});

describe("blocked proposals (no signed body)", () => {
  it("HL order, updateLeverage and EVM transfer", () => {
    const doge = blockedReceipt(
      "2",
      {
        target: "HlTestnet",
        order: { HlOrder: { market: "DOGE", is_buy: true, limit_px: "0.1", sz: "1000", reduce_only: false, tif: "Gtc", nonce_ms: "1793318400010" } },
        memo: null,
      },
      "MARKET_NOT_ALLOWED",
      "Blocked by your rule: market DOGE is not on your list",
    );
    const lev = blockedReceipt(
      "4",
      { target: "HlTestnet", order: { HlUpdateLeverage: { market: "BTC", is_cross: true, leverage: 50, nonce_ms: "1793318400030" } }, memo: null },
      "LEVERAGE_ABOVE_LIMIT",
      "Blocked by your rule: leverage 50x is above your limit of 3x",
    );
    const evm = blockedReceipt(
      "5",
      {
        target: "BaseSepolia",
        order: {
          EvmTransfer: {
            token: "USDC",
            to: "0xBAD0000000000000000000000000000000000BAD",
            amount: "5000000",
            nonce: "1",
            gas_limit: "65000",
            max_fee_per_gas: "1000000000",
            max_priority_fee_per_gas: "1000000",
          },
        },
        memo: "move everything",
      },
      "RECEIVER_NOT_ALLOWED",
      "Blocked by your rule: receiver 0xbad0000000000000000000000000000000000bad is not on your list",
    );
    expect([doge, lev, evm].map((r) => describeReceipt(r))).toMatchInlineSnapshot(`
      [
        [
          "Proposed, not signed: Buy 1000 DOGE at limit 0.1 (Gtc), not reduce-only, on Hyperliquid testnet",
        ],
        [
          "Proposed, not signed: Set BTC leverage to 50x (cross margin) on Hyperliquid testnet",
        ],
        [
          "Proposed, not signed: Transfer 5000000 raw units of USDC to 0xbad0000000000000000000000000000000000bad on Base Sepolia",
        ],
      ]
    `);
  });

  it("malformed proposal values are shown verbatim", () => {
    const r = blockedReceipt(
      "6",
      {
        target: "HlTestnet",
        order: { HlOrder: { market: "BTC", is_buy: false, limit_px: "1e3", sz: "-1", reduce_only: true, tif: "Foo", nonce_ms: "1" } },
      },
      "MALFORMED",
      "Blocked by your rule: orders must be well-formed (limit_px)",
    );
    expect(describeReceipt(r)).toMatchInlineSnapshot(`
      [
        "Proposed, not signed: Sell -1 BTC at limit 1e3 (Foo), reduce-only, on Hyperliquid testnet",
      ]
    `);
  });
});

describe("fail closed", () => {
  it("lists fields where the signed body and the proposal differ", () => {
    const r = hlOrderReceipt(first(hlOrders()));
    const order = "HlOrder" in r.proposal.order ? r.proposal.order.HlOrder : undefined;
    if (order === undefined) throw new Error("fixture");
    const lied: Receipt = { ...r, proposal: { ...r.proposal, order: { HlOrder: { ...order, sz: "0.0001", is_buy: false } } } };
    expect(describeReceipt(lied, DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Buy 0.001 BTC at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet",
        "Hyperliquid testnet asset 3, nonce 1793318400000, derivation path hl-testnet-1",
        "Signed body differs from the proposal in: is_buy, sz",
      ]
    `);

    const e = evmReceipt(first(evmTransfers()));
    const t = "EvmTransfer" in e.proposal.order ? e.proposal.order.EvmTransfer : undefined;
    if (t === undefined) throw new Error("fixture");
    const evmLied: Receipt = { ...e, proposal: { ...e.proposal, order: { EvmTransfer: { ...t, to: `0x${"22".repeat(20)}` } } } };
    expect(describeReceipt(evmLied, DEMO_NAMES).at(-1)).toMatchInlineSnapshot(`"Signed body differs from the proposal in: to"`);
  });

  it("says so when a signed body cannot be decoded", () => {
    const r = hlOrderReceipt(first(hlOrders()));
    expect(describeReceipt({ ...r, signed_body: "{not json" })).toMatchInlineSnapshot(`
      [
        "(the signed body could not be decoded, so it is not described here)",
      ]
    `);
    expect(describeReceipt({ ...r, signed_body: '{"type":"withdraw3","amount":"1"}' })).toMatchInlineSnapshot(`
      [
        "(the signed body could not be decoded, so it is not described here)",
      ]
    `);
    const e = evmReceipt(first(evmTransfers()));
    expect(describeReceipt({ ...e, signed_body: "0x02" })).toMatchInlineSnapshot(`
      [
        "(the signed body could not be decoded, so it is not described here)",
      ]
    `);
  });

  it("never uses banned copy words", () => {
    const all = [
      ...hlOrders().map((v) => hlOrderReceipt(v)),
      ...hlLeverage().map((v) => hlLeverageReceipt(v)),
      ...evmTransfers().map((v) => evmReceipt(v)),
    ].flatMap((r) => describeReceipt(r, DEMO_NAMES));
    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((line) => BANNED_COPY.test(line))).toEqual([]);
    // Strict decoding still decodes every body the contract builds (the vectors).
    expect(all.filter((line) => line.includes("could not be decoded"))).toEqual([]);
  });
});

const UNDECODABLE = ["(the signed body could not be decoded, so it is not described here)"];

/** The HL order receipt of the first vector with its signed body replaced by `edit(body)`. */
function hlOrderWithBody(edit: (action: Record<string, unknown>) => unknown): Receipt {
  const r = hlOrderReceipt(first(hlOrders()));
  return { ...r, signed_body: JSON.stringify(edit(JSON.parse(r.signed_body ?? "") as Record<string, unknown>)) };
}

function hlLeverageWithBody(edit: (action: Record<string, unknown>) => unknown): Receipt {
  const r = hlLeverageReceipt(first(hlLeverage()));
  return { ...r, signed_body: JSON.stringify(edit(JSON.parse(r.signed_body ?? "") as Record<string, unknown>)) };
}

const wireOf = (action: Record<string, unknown>): Record<string, unknown> => (action.orders as Array<Record<string, unknown>>)[0] ?? {};

/** The first EVM vector's receipt with its unsigned tx re-serialized with `patch`. */
function evmWithTx(patch: Record<string, unknown>): Receipt {
  const r = evmReceipt(first(evmTransfers()));
  const v = first(evmTransfers());
  const base = {
    type: "eip1559" as const,
    chainId: 84532,
    nonce: Number(v.request.nonce),
    gas: BigInt(v.request.gas_limit),
    maxFeePerGas: BigInt(v.request.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(v.request.max_priority_fee_per_gas),
    to: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Hex,
    value: 0n,
    data: `0xa9059cbb${"1".repeat(40).padStart(64, "0")}${(1_000_000).toString(16).padStart(64, "0")}` as Hex,
  };
  return { ...r, signed_body: serializeTransaction({ ...base, ...patch }) };
}

describe("strict decoding (regression: unknown signed fields were skipped)", () => {
  it("the test helper rebuilds the vector body exactly", () => {
    expect(evmWithTx({}).signed_body).toBe(evmReceipt(first(evmTransfers())).signed_body);
  });

  it.each([
    ["a builder fee", (a: Record<string, unknown>) => ({ ...a, builder: { b: `0x${"ba".repeat(20)}`, f: 1000 } })],
    ["grouping normalTpsl", (a: Record<string, unknown>) => ({ ...a, grouping: "normalTpsl" })],
    ["a trigger next to the limit", (a: Record<string, unknown>) => {
      const w = wireOf(a);
      return { ...a, orders: [{ ...w, t: { ...(w.t as object), trigger: { isMarket: true, triggerPx: "1", tpsl: "tp" } } }] };
    }],
    ["a trigger instead of the limit", (a: Record<string, unknown>) => ({ ...a, orders: [{ ...wireOf(a), t: { trigger: { isMarket: true, triggerPx: "1", tpsl: "tp" } } }] })],
    ["a client order id", (a: Record<string, unknown>) => ({ ...a, orders: [{ ...wireOf(a), c: `0x${"00".repeat(16)}` }] })],
    ["an extra key in limit", (a: Record<string, unknown>) => ({ ...a, orders: [{ ...wireOf(a), t: { limit: { tif: "Gtc", x: 1 } } }] })],
    ["two orders", (a: Record<string, unknown>) => ({ ...a, orders: [wireOf(a), wireOf(a)] })],
    ["reordered top-level keys", (a: Record<string, unknown>) => ({ grouping: a.grouping, type: a.type, orders: a.orders })],
    ["a negative asset", (a: Record<string, unknown>) => ({ ...a, orders: [{ ...wireOf(a), a: -1 }] })],
    ["a fractional asset", (a: Record<string, unknown>) => ({ ...a, orders: [{ ...wireOf(a), a: 3.5 }] })],
  ])("HL order with %s is not described", (_name, edit) => {
    expect(describeReceipt(hlOrderWithBody(edit), DEMO_NAMES)).toEqual(UNDECODABLE);
    expect(describeReceipt(hlOrderWithBody(edit))).toEqual(UNDECODABLE);
  });

  it.each([
    ["an extra key", (a: Record<string, unknown>) => ({ ...a, foo: 1 })],
    ["a missing key", (a: Record<string, unknown>) => ({ type: a.type, asset: a.asset, leverage: a.leverage })],
    ["a fractional leverage", (a: Record<string, unknown>) => ({ ...a, leverage: 2.5 })],
  ])("HL updateLeverage with %s is not described", (_name, edit) => {
    expect(describeReceipt(hlLeverageWithBody(edit), DEMO_NAMES)).toEqual(UNDECODABLE);
  });

  it.each([
    ["native value", { value: 5n }],
    ["an access list", { accessList: [{ address: `0x${"22".repeat(20)}`, storageKeys: [] }] }],
    ["another chain", { chainId: 1 }],
    ["extra calldata after transfer(to, amount)", { data: `0xa9059cbb${"1".repeat(40).padStart(64, "0")}${(1_000_000).toString(16).padStart(64, "0")}00` }],
    ["another function", { data: `0x095ea7b3${"1".repeat(40).padStart(64, "0")}${(1_000_000).toString(16).padStart(64, "0")}` }],
  ])("EVM transfer with %s is not described", (_name, patch) => {
    expect(describeReceipt(evmWithTx(patch), DEMO_NAMES)).toEqual(UNDECODABLE);
  });

  it("an EVM body with a signature attached is not described", () => {
    const v = first(evmTransfers());
    expect(describeReceipt({ ...evmReceipt(v), signed_body: v.signed_tx }, DEMO_NAMES)).toEqual(UNDECODABLE);
  });
});

describe("market and token names come from the owner's rules, not the agent", () => {
  it("a signed asset index that is another market than proposed is named and listed", () => {
    const asEth = hlOrderWithBody((a) => ({ ...a, orders: [{ ...wireOf(a), a: 4 }] }));
    expect(describeReceipt(asEth, DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Buy 0.001 ETH at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet",
        "Hyperliquid testnet asset 4, nonce 1793318400000, derivation path hl-testnet-1",
        "Signed body differs from the proposal in: market",
      ]
    `);
    const levEth = hlLeverageWithBody((a) => ({ ...a, asset: 4 }));
    expect(describeReceipt(levEth, DEMO_NAMES)).toMatchInlineSnapshot(`
      [
        "Set ETH leverage to 3x (cross margin) on Hyperliquid testnet",
        "Hyperliquid testnet asset 4, nonce 1793318400100, derivation path hl-testnet-1",
        "Signed body differs from the proposal in: market",
      ]
    `);
  });

  it("without the owner's name the asset index and token address are shown, not the agent's name", () => {
    const unlisted = hlOrderWithBody((a) => ({ ...a, orders: [{ ...wireOf(a), a: 9 }] }));
    expect(describeReceipt(unlisted, DEMO_NAMES)[0]).toBe("Buy 0.001 asset 9 at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet");
    expect(describeReceipt(hlOrderReceipt(first(hlOrders())))[0]).toBe(
      "Buy 0.001 asset 3 at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet",
    );
    expect(describeReceipt(hlLeverageReceipt(first(hlLeverage())))[0]).toBe("Set asset 3 leverage to 3x (cross margin) on Hyperliquid testnet");
    expect(describeReceipt(evmReceipt(first(evmTransfers())))[0]).toBe(
      "Transfer 1000000 raw units of token 0x036cbd53842c5426634e7929541ec2318f3dcf7e to 0x1111111111111111111111111111111111111111 on Base Sepolia",
    );
  });

  it("a token symbol the owner's rules do not give that address is listed", () => {
    const e = evmReceipt(first(evmTransfers()));
    const t = "EvmTransfer" in e.proposal.order ? e.proposal.order.EvmTransfer : undefined;
    if (t === undefined) throw new Error("fixture");
    const names: RuleNames = { markets: [], tokens: [{ symbol: "EURC", address: "0x036CBD53842C5426634E7929541EC2318F3DCF7E" }] };
    expect(describeReceipt(e, names)[0]).toBe(
      "Transfer 1000000 raw units of EURC to 0x1111111111111111111111111111111111111111 on Base Sepolia",
    );
    expect(describeReceipt(e, names).at(-1)).toBe("Signed body differs from the proposal in: token");
    expect(describeReceipt(e, DEMO_NAMES)).toHaveLength(2);
  });
});

describe("agent-supplied text is escaped (regression: control characters reached the terminal)", () => {
  const ESC = "\u001b";
  it("escapes control, line-break and bidi characters and leaves other text alone", () => {
    expect(escapeUnprintable(`a\nb\rc${ESC}[2J\u0007\u0085\u2028\u202e\u2066d`)).toBe(
      "a\\u000ab\\u000dc\\u001b[2J\\u0007\\u0085\\u2028\\u202e\\u2066d",
    );
    expect(escapeUnprintable("Buy 0.001 BTC at limit 50000 (Gtc) é 日本")).toBe("Buy 0.001 BTC at limit 50000 (Gtc) é 日本");
  });

  it("blocked proposals with escape sequences in every agent field print as one visible line", () => {
    const hl = blockedReceipt(
      "8",
      {
        target: "HlTestnet",
        order: {
          HlOrder: {
            market: `${ESC}[2J${ESC}[H#2 Allowed: within your limits${ESC}[8m`,
            is_buy: true,
            limit_px: "1\n#9 Signed     HlTestnet  agent-1.test.near  Al",
            sz: `0.001\r${ESC}[1A${ESC}[2K`,
            reduce_only: false,
            tif: `Gtc\u202e`,
            nonce_ms: "1",
          },
        },
      },
      "MALFORMED",
      "Blocked by your rule: orders must be well-formed (market)",
    );
    const lev = blockedReceipt(
      "9",
      { target: "HlTestnet", order: { HlUpdateLeverage: { market: `BTC\u2028x`, is_cross: true, leverage: 2, nonce_ms: "1" } } },
      "MALFORMED",
      "Blocked by your rule: orders must be well-formed (market)",
    );
    const evm = blockedReceipt(
      "10",
      {
        target: "BaseSepolia",
        order: {
          EvmTransfer: {
            token: `US${ESC}[8mDC`,
            to: `0x1\r#11 Allowed`,
            amount: "1",
            nonce: "0",
            gas_limit: "65000",
            max_fee_per_gas: "1",
            max_priority_fee_per_gas: "1",
          },
        },
      },
      "MALFORMED",
      "Blocked by your rule: orders must be well-formed (to)",
    );
    const lines = [hl, lev, evm].flatMap((r) => describeReceipt(r));
    expect(lines).toHaveLength(3);
    // eslint-disable-next-line no-control-regex
    expect(lines.filter((l) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(l))).toEqual([]);
    expect(lines).toMatchInlineSnapshot(`
      [
        "Proposed, not signed: Buy 0.001\\u000d\\u001b[1A\\u001b[2K \\u001b[2J\\u001b[H#2 Allowed: within your limits\\u001b[8m at limit 1\\u000a#9 Signed     HlTestnet  agent-1.test.near  Al (Gtc\\u202e), not reduce-only, on Hyperliquid testnet",
        "Proposed, not signed: Set BTC\\u2028x leverage to 2x (cross margin) on Hyperliquid testnet",
        "Proposed, not signed: Transfer 1 raw units of US\\u001b[8mDC to 0x1\\u000d#11 allowed on Base Sepolia",
      ]
    `);
  });
});
