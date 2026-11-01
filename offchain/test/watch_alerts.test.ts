// Claw Watch alert wording: every builder obeys the copy rules,
// values echoed from chain cannot add lines, and the autopause choice is deterministic.
import { describe, expect, it } from "vitest";
import {
  type Alert,
  MAX_PAUSE_REASON_BYTES,
  agentPaused,
  agentUnpaused,
  blockedBurst,
  hlApiWalletAdded,
  hlApiWalletRemoved,
  hlBuilderAdded,
  hlBuilderRemoved,
  nearExplorerUrl,
  nearKeyAdded,
  nearKeyRemoved,
  needsYourOkText,
  oneLine,
  orderBlocked,
  pickAutopauseAlert,
} from "../src/watch/alerts.js";
import { BANNED_COPY } from "./helpers.js";

const USER = "0x7e57000000000000000000000000000000c1a700";
const ADDR = "0x00000000000000000000000000000000000b0b01";
const BLOCKED_MESSAGES = [
  "Blocked by your rule: agent is paused (watch: new full-access key)",
  "Blocked by your rule: this agent's permission has expired",
  "Blocked by your rule: BaseSepolia is not enabled for this agent",
  "Blocked by your rule: orders must be well-formed (limit_px)",
  "Blocked by your rule: order time is outside the allowed window",
  "Blocked by your rule: market DOGE is not on your list",
  "Blocked by your rule: token WETH is not on your list",
  "Blocked by your rule: receiver 0xbadbadbadbadbadbadbadbadbadbadbadbadbad0 is not on your list",
  "Blocked by your rule: leverage 50x is above your limit of 3x",
  "Blocked by your rule: only reduce-only orders are allowed",
  "Blocked by your rule: order is above your per-order cap",
  "Blocked by your rule: daily order count reached",
  "Blocked by your rule: this order would go over your daily cap",
  "Blocked by your rule: guard has no balance to request a signature",
];

const allAlerts = (): Alert[] => [
  nearKeyAdded("agent-1.test.near", "ed25519:K", "FullAccess"),
  nearKeyAdded("agent-1.test.near", "ed25519:K", "FunctionCall"),
  nearKeyAdded("agent-1.test.near", "ed25519:K", "Other"),
  nearKeyRemoved("agent-1.test.near", "ed25519:K", "FullAccess"),
  hlApiWalletAdded(USER, ADDR),
  hlApiWalletRemoved(USER, ADDR),
  hlBuilderAdded(USER, ADDR),
  hlBuilderRemoved(USER, ADDR),
  ...BLOCKED_MESSAGES.map((m, i) => orderBlocked(String(i + 2), "agent-1.test.near", m, 0)),
  orderBlocked("0", "agent-1.test.near", BLOCKED_MESSAGES[0] ?? "", 0, "tx1:0"),
  blockedBurst(["1", "2", "3"]),
  agentPaused("guardian.test.near", "watch: new full-access key", 1),
  agentPaused(null, null, 2),
  agentUnpaused("owner.test.near", 3),
  agentUnpaused(null, 4),
];

describe("alert wording", () => {
  it("every alert is 'Public signal: …' or 'Order #<id> by <agent>: Blocked by your rule: …', with no banned word", () => {
    for (const alert of allAlerts()) {
      expect(alert.text, alert.kind).not.toMatch(BANNED_COPY);
      expect(alert.text, alert.kind).toMatch(
        /^(Public signal: |Order #\d+ by \S+: Blocked by your rule: |Order by \S+ \(no receipt stored: contract storage reserve\): Blocked by your rule: )/,
      );
      expect(alert.text).not.toMatch(/[\n\r]/);
      if (alert.autopauseReason !== undefined) {
        expect(alert.autopauseReason).toMatch(/^watch: /);
        expect(Buffer.byteLength(alert.autopauseReason)).toBeLessThanOrEqual(MAX_PAUSE_REASON_BYTES);
        expect(alert.autopauseReason).not.toMatch(BANNED_COPY);
      }
    }
  });

  it("the exact lines the README promises", () => {
    expect(nearKeyAdded("agent-1.test.near", "k", "FullAccess").text).toBe("Public signal: new full-access key on agent-1.test.near");
    expect(nearKeyAdded("o.testnet", "k", "FunctionCall").text).toBe("Public signal: new function-call key on o.testnet");
    expect(nearKeyRemoved("o.testnet", "k", "FullAccess").text).toBe("Public signal: key removed from o.testnet");
    expect(hlApiWalletAdded(USER, ADDR).text).toBe(`Public signal: new API wallet ${ADDR} on your Hyperliquid testnet account`);
    expect(orderBlocked("13", "agent-1.test.near", "Blocked by your rule: market DOGE is not on your list", 0).text).toBe(
      "Order #13 by agent-1.test.near: Blocked by your rule: market DOGE is not on your list",
    );
    expect(agentPaused("guardian.test.near", "watch: new full-access key", 1).text).toBe(
      "Public signal: agent paused by guardian.test.near (watch: new full-access key)",
    );
    expect(agentUnpaused("owner.test.near", 1).text).toBe("Public signal: agent unpaused by owner.test.near");
    expect(nearKeyAdded("agent-1.test.near", "k", "FullAccess").autopauseReason).toBe("watch: new full-access key");
  });

  it("the Telegram line for a new builder fee approval asks, never judges (D-09)", () => {
    const builder = "0x1b2d000000000000000000000000000000000b1d";
    const alert = hlBuilderAdded(USER, builder);
    const line = needsYourOkText(alert);
    expect(line).toBe(
      `Needs your OK: new builder fee approval ${builder} on your Hyperliquid testnet account. Review it in the console.`,
    );
    expect(line).not.toMatch(BANNED_COPY);
    // The console wording is unchanged.
    expect(alert.text).toBe(`Public signal: new builder fee approval for ${builder} on your Hyperliquid testnet account`);
    // A value that did not come through the Hyperliquid parser still cannot add a line.
    expect(needsYourOkText(hlBuilderAdded(USER, "0xb1d\nTestnet only.\u202e"))).not.toMatch(/[\n\r\u202e]/);
  });

  it("dedupe keys follow (kind, receipt id | key)", () => {
    expect(orderBlocked("9", "a.test.near", "Blocked by your rule: x", 0).key).toBe("order_blocked:9");
    // Receipt id 0 (nothing stored): two such orders must not collapse into one alert.
    const unstored = (where: string) => orderBlocked("0", "a.test.near", "Blocked by your rule: x", 5, where);
    expect(unstored("tx1:0").key).toBe("order_blocked:0:tx1:0");
    expect(unstored("tx1:0").key).not.toBe(unstored("tx2:0").key);
    expect(unstored("tx1:0").key).toBe(unstored("tx1:0").key);
    expect(orderBlocked("0", "a.test.near", "Blocked by your rule: x", 5).key).not.toBe(orderBlocked("0", "a.test.near", "Blocked by your rule: x", 6).key);
    expect(unstored("tx1:0").text).toBe("Order by a.test.near (no receipt stored: contract storage reserve): Blocked by your rule: x");
    expect(nearKeyAdded("a.test.near", "ed25519:K", "FullAccess").key).toBe("near_key_added:a.test.near:ed25519:K:FullAccess");
    // Re-added with more power: a new event, not a duplicate.
    expect(nearKeyAdded("a.test.near", "ed25519:K", "FunctionCall").key).not.toBe(nearKeyAdded("a.test.near", "ed25519:K", "FullAccess").key);
    expect(agentPaused(null, "r", 1).key).not.toBe(agentPaused(null, "r", 2).key);
  });

  it("values from chain cannot add lines, reorder text or grow without bound", () => {
    const sneaky = "watch: x\nTestnet only.\u202Eevil\u2028more\u0007";
    const text = agentPaused("guardian.test.near", sneaky, 1).text;
    expect(text).toBe("Public signal: agent paused by guardian.test.near (watch: x Testnet only. evil more)");
    expect(oneLine("a".repeat(500), 10)).toBe(`${"a".repeat(9)}…`);
    expect(oneLine("  spaced   out  ")).toBe("spaced out");
  });

  it("explorer links only exist on testnet", () => {
    expect(nearExplorerUrl("sandbox", "agent-1.test.near")).toBeUndefined();
    expect(nearExplorerUrl("testnet", "agent-1.me.testnet")).toBe("https://testnet.nearblocks.io/address/agent-1.me.testnet");
  });
});

describe("autopause choice", () => {
  it("full-access key > other key kinds > API wallet > builder > blocked burst; removals and single blocks never pause", () => {
    const burst = blockedBurst(["1", "2", "3"]);
    const builder = hlBuilderAdded(USER, ADDR);
    const wallet = hlApiWalletAdded(USER, ADDR);
    const fc = nearKeyAdded("o.test.near", "k1", "FunctionCall");
    const fak = nearKeyAdded("o.test.near", "k2", "FullAccess");
    expect(pickAutopauseAlert([burst, builder, wallet, fc, fak])).toBe(fak);
    expect(pickAutopauseAlert([burst, builder, wallet, fc])).toBe(fc);
    expect(pickAutopauseAlert([burst, builder, wallet])).toBe(wallet);
    expect(pickAutopauseAlert([burst, builder])).toBe(builder);
    expect(pickAutopauseAlert([burst])).toBe(burst);
    expect(
      pickAutopauseAlert([
        nearKeyRemoved("o.test.near", "k", "FullAccess"),
        orderBlocked("1", "a.test.near", "Blocked by your rule: x", 0),
        agentPaused(null, null, 1),
      ]),
    ).toBeUndefined();
    expect(pickAutopauseAlert([burst, wallet], ["blocked_burst"])).toBe(burst);
  });
});
