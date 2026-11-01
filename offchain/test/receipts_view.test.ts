// Receipts table and decision-line formatting (pure functions).
import { describe, expect, it } from "vitest";
import { formatDecisionLine, formatReceiptsJson, formatReceiptsTable, shortHex } from "../src/receipts_view.js";
import type { Receipt } from "../src/types.js";
import { BANNED_COPY, DEMO_NAMES, blockedReceipt, evmReceipt, evmTransfers, first, hlLeverageReceipt, hlLeverage, hlOrderReceipt, hlOrders } from "./helpers.js";

const signedHl = hlOrderReceipt(first(hlOrders()), "1");
const doge: Receipt = blockedReceipt(
  "2",
  {
    target: "HlTestnet",
    order: { HlOrder: { market: "DOGE", is_buy: true, limit_px: "0.1", sz: "1000", reduce_only: false, tif: "Gtc", nonce_ms: "1793318400010" } },
    memo: null,
  },
  "MARKET_NOT_ALLOWED",
  "Blocked by your rule: market DOGE is not on your list",
);
const leverage = hlLeverageReceipt(first(hlLeverage()), "3");
const transfer = evmReceipt(first(evmTransfers()), "12");
const names = new Map([["agent-1.test.near", DEMO_NAMES]]);

describe("formatReceiptsTable", () => {
  it("renders a fixed-width table with decoded lines", () => {
    expect(formatReceiptsTable([signedHl, doge, leverage, transfer], names)).toMatchInlineSnapshot(`
      "ID   STATUS   TARGET       AGENT              DECISION
      #1   Signed   HlTestnet    agent-1.test.near  Allowed: within your limits
            Buy 0.001 BTC at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet
            Hyperliquid testnet asset 3, nonce 1793318400000, derivation path hl-testnet-1
            payload 0xb3b15673…ca39  sig r=0x9db86c17…8d61 v=28
      #2   Blocked  HlTestnet    agent-1.test.near  Blocked by your rule: market DOGE is not on your list
            Proposed, not signed: Buy 1000 DOGE at limit 0.1 (Gtc), not reduce-only, on Hyperliquid testnet
      #3   Signed   HlTestnet    agent-1.test.near  Allowed: within your limits
            Set BTC leverage to 3x (cross margin) on Hyperliquid testnet
            Hyperliquid testnet asset 3, nonce 1793318400100, derivation path hl-testnet-1
            payload 0x9fa4c052…cc1f  sig r=0xed6f2310…42c3 v=28
      #12  Signed   BaseSepolia  agent-1.test.near  Allowed: within your limits
            Transfer 1000000 raw units of USDC to 0x1111111111111111111111111111111111111111 on Base Sepolia
            Token contract 0x036cbd53842c5426634e7929541ec2318f3dcf7e, chain 84532, nonce 0, gas limit 65000, max fee per gas 1000000000 wei, max priority fee per gas 1000000 wei, derivation path base-sepolia-1
            payload 0x999b2508…c392  sig r=0xb2c40f30…6b94 v=1"
    `);
  });

  it("empty list", () => {
    expect(formatReceiptsTable([])).toBe("No receipts yet.");
  });

  it("names signed assets only from the owner's rules of that agent", () => {
    const other: Receipt = { ...signedHl, agent_id: "agent-2.test.near" };
    const table = formatReceiptsTable([signedHl, other], names);
    expect(table).toContain("      Buy 0.001 BTC at limit 1000 (Gtc)");
    expect(table).toContain("      Buy 0.001 asset 3 at limit 1000 (Gtc)");
  });

  // Regression: agent text in a blocked receipt (and a pause reason in a decision message) could
  // move the cursor, clear the screen or fake a "Signed" row in the owner's receipts table.
  it("prints control characters from receipts as visible escapes, one row per receipt", () => {
    const fake = blockedReceipt(
      "8",
      {
        target: "HlTestnet",
        order: {
          HlOrder: {
            market: "BTC",
            is_buy: true,
            limit_px: "1\n#9 Signed     HlTestnet  agent-1.test.near  Al",
            sz: "0.001",
            reduce_only: false,
            tif: "Gtc\u001b[1A\u001b[2K",
            nonce_ms: "1",
          },
        },
      },
      "MALFORMED",
      "Blocked by your rule: orders must be well-formed (limit_px)",
    );
    const paused = { ...doge, id: "9", rule_code: "PAUSED", message: "Blocked by your rule: agent is paused (x\u001b[2J\r#10 Allowed)" };
    const table = formatReceiptsTable([fake, paused], names);
    // eslint-disable-next-line no-control-regex
    expect(table).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    expect(table.split("\n")).toMatchInlineSnapshot(`
      [
        "ID  STATUS   TARGET     AGENT              DECISION",
        "#8  Blocked  HlTestnet  agent-1.test.near  Blocked by your rule: orders must be well-formed (limit_px)",
        "      Proposed, not signed: Buy 0.001 BTC at limit 1\\u000a#9 Signed     HlTestnet  agent-1.test.near  Al (Gtc\\u001b[1A\\u001b[2K), not reduce-only, on Hyperliquid testnet",
        "#9  Blocked  HlTestnet  agent-1.test.near  Blocked by your rule: agent is paused (x\\u001b[2J\\u000d#10 Allowed)",
        "      Proposed, not signed: Buy 1000 DOGE at limit 0.1 (Gtc), not reduce-only, on Hyperliquid testnet",
      ]
    `);
    expect(formatDecisionLine({ allowed: false, receipt_id: "9", rule_code: "PAUSED", message: paused.message, signature: null })).toBe(
      "#9 Blocked by your rule: agent is paused (x\\u001b[2J\\u000d#10 Allowed)",
    );
  });

  it("keeps decision messages verbatim and has no banned words", () => {
    const table = formatReceiptsTable([signedHl, doge, leverage, transfer]);
    expect(table).toContain("Allowed: within your limits");
    expect(table).toContain("Blocked by your rule: market DOGE is not on your list");
    expect(BANNED_COPY.test(table)).toBe(false);
  });
});

describe("formatDecisionLine", () => {
  it("allowed with signature and blocked without", () => {
    expect(
      formatDecisionLine({ allowed: true, receipt_id: "12", rule_code: null, message: "Allowed: within your limits", signature: signedHl.signature }),
    ).toBe("#12 Allowed: within your limits sig=0x9db86c17…8d61");
    expect(
      formatDecisionLine({
        allowed: false,
        receipt_id: "13",
        rule_code: "MARKET_NOT_ALLOWED",
        message: "Blocked by your rule: market DOGE is not on your list",
        signature: null,
      }),
    ).toBe("#13 Blocked by your rule: market DOGE is not on your list");
  });

  it("receipt id 0: says no receipt was stored instead of printing #0", () => {
    const line = formatDecisionLine({
      allowed: false,
      receipt_id: "0",
      rule_code: "MARKET_NOT_ALLOWED",
      message: "Blocked by your rule: market DOGE is not on your list",
      signature: null,
    });
    expect(line).toBe("no receipt stored (contract storage reserve) Blocked by your rule: market DOGE is not on your list");
    expect(line).not.toMatch(BANNED_COPY);
  });
});

describe("formatReceiptsJson", () => {
  it("adds the decoded lines and keeps every contract field", () => {
    const parsed = JSON.parse(formatReceiptsJson([signedHl, doge], names)) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ ...signedHl, what_is_signed: expect.any(Array) as unknown });
    expect((parsed[0]?.what_is_signed as string[])[0]).toBe("Buy 0.001 BTC at limit 1000 (Gtc), not reduce-only, on Hyperliquid testnet");
    expect(parsed[1]?.what_is_signed).toEqual([
      "Proposed, not signed: Buy 1000 DOGE at limit 0.1 (Gtc), not reduce-only, on Hyperliquid testnet",
    ]);
  });
});

it("shortHex", () => {
  expect(shortHex("0x1234")).toBe("0x1234");
  expect(shortHex(`0x${"ab".repeat(32)}`)).toBe("0xabababab…abab");
});
