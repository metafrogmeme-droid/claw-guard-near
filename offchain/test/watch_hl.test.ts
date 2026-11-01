// Claw Watch Hyperliquid testnet source: /info fixtures through a mocked fetch.
import { describe, expect, it } from "vitest";
import { MainnetRefusedError } from "../src/config.js";
import type { Alert } from "../src/watch/alerts.js";
import { HlWatch, parseApprovedBuilders, parseExtraAgents, restoreHlSnapshot } from "../src/watch/hl.js";
import { type HlFixture, type HlStep, type RecordedRequest, hlInfoFetch, loadFixture } from "./fixtures/replay.js";
import { BANNED_COPY } from "./helpers.js";

const fixture = loadFixture<HlFixture>("hl_info.json");
const HL = "https://api.hyperliquid-testnet.xyz";
const step = (name: string): HlStep => {
  const s = fixture.steps[name];
  if (s === undefined) throw new Error(`no fixture step ${name}`);
  return s;
};

function setup() {
  const state = { user: fixture.user, step: step("baseline") };
  const requests: RecordedRequest[] = [];
  const watch = new HlWatch({ apiUrl: HL, user: fixture.user, fetchImpl: hlInfoFetch(state, requests), now: () => 7 });
  return { state, requests, watch, goTo: (name: string) => (state.step = step(name)) };
}
const texts = (alerts: readonly Alert[]) => alerts.map((a) => a.text);

describe("HlWatch", () => {
  it("first poll records the baseline only, with both /info queries", async () => {
    const { watch, requests } = setup();
    expect(await watch.poll()).toEqual({ alerts: [], errors: [], baseline: true });
    expect(requests).toEqual([
      { url: `${HL}/info`, body: { type: "extraAgents", user: fixture.user } },
      { url: `${HL}/info`, body: { type: "approvedBuilders", user: fixture.user } },
    ]);
    expect(watch.snapshot?.api_wallets.map((w) => w.address)).toEqual(["0x3f1c6e0a52b4d7a8e9f0c1b2a3d4e5f60718293a"]);
  });

  it("new API wallet -> alert", async () => {
    const { watch, goTo } = setup();
    await watch.poll();
    goTo("new_api_wallet");
    const { alerts } = await watch.poll();
    expect(texts(alerts)).toEqual([
      "Public signal: new API wallet 0x00000000000000000000000000000000000b0b01 on your Hyperliquid testnet account",
    ]);
    expect(alerts[0]).toMatchObject({ kind: "hl_api_wallet_added", autopauseReason: "watch: new API wallet" });
  });

  it("builder approval and API wallet removal -> alerts", async () => {
    const { watch, goTo } = setup();
    goTo("new_api_wallet");
    await watch.poll();
    goTo("builder_approved");
    expect(texts((await watch.poll()).alerts)).toEqual([
      "Public signal: new builder fee approval for 0x1b2d000000000000000000000000000000000b1d on your Hyperliquid testnet account",
    ]);
    goTo("api_wallet_removed");
    const { alerts } = await watch.poll();
    expect(texts(alerts)).toEqual([
      "Public signal: API wallet 0x3f1c6e0a52b4d7a8e9f0c1b2a3d4e5f60718293a removed from your Hyperliquid testnet account",
    ]);
    expect(alerts[0]?.autopauseReason).toBeUndefined();
  });

  it("a renamed / re-dated API wallet is not a new one", async () => {
    const { watch, state } = setup();
    await watch.poll();
    state.step = {
      extraAgents: [{ name: "renamed", address: "0x3F1C6E0A52B4D7A8E9F0C1B2A3D4E5F60718293A", validUntil: 1 }],
      approvedBuilders: [],
    };
    expect((await watch.poll()).alerts).toEqual([]);
  });

  it("refuses any URL but the Hyperliquid testnet one", () => {
    expect(() => new HlWatch({ apiUrl: "https://api.hyperliquid.xyz", user: fixture.user })).toThrow(MainnetRefusedError);
    expect(() => new HlWatch({ apiUrl: "https://example.org", user: fixture.user })).toThrow(/ERR_MAINNET_REFUSED/);
  });

  it("an unexpected response fails the poll and keeps the old baseline", async () => {
    const { watch, state, goTo } = setup();
    await watch.poll();
    const before = watch.snapshot;
    state.step = { extraAgents: { not: "a list" }, approvedBuilders: [] };
    await expect(watch.poll()).rejects.toThrow(/extraAgents: expected a list/);
    expect(watch.snapshot).toBe(before);
    goTo("new_api_wallet");
    expect((await watch.poll()).alerts).toHaveLength(1);
  });

  it("an HTTP error fails the poll", async () => {
    const watch = new HlWatch({
      apiUrl: HL,
      user: fixture.user,
      fetchImpl: () => Promise.resolve(new Response("busy", { status: 503 })),
    });
    await expect(watch.poll()).rejects.toThrow(/returned HTTP 503/);
  });

  it("parsers are fail-closed and normalise addresses", () => {
    expect(parseExtraAgents([{ name: "a", address: "0xABCDEF0000000000000000000000000000000001", validUntil: 5 }])).toEqual([
      { address: "0xabcdef0000000000000000000000000000000001", name: "a", valid_until: 5 },
    ]);
    expect(() => parseExtraAgents([{ address: "0x12" }])).toThrow(/expected a 0x address/);
    expect(() => parseExtraAgents([{ address: "0xabcdef0000000000000000000000000000000001", validUntil: "soon" }])).toThrow(
      /validUntil/,
    );
    expect(parseApprovedBuilders(["0xB000000000000000000000000000000000000001", { builder: "0xb000000000000000000000000000000000000001" }])).toEqual([
      "0xb000000000000000000000000000000000000001",
    ]);
    expect(() => parseApprovedBuilders("0xb000000000000000000000000000000000000001")).toThrow(/expected a list/);
  });

  it("restoreHlSnapshot checks the stored hash", async () => {
    const { watch } = setup();
    await watch.poll();
    const stored = JSON.parse(JSON.stringify(watch.snapshot)) as Record<string, unknown>;
    expect(restoreHlSnapshot(stored)).toEqual(watch.snapshot);
    expect(restoreHlSnapshot({ ...stored, builders: ["0xb000000000000000000000000000000000000001"] })).toBeUndefined();
  });

  it("no banned words in any HL alert", async () => {
    const { watch, goTo } = setup();
    await watch.poll();
    goTo("api_wallet_removed");
    const { alerts } = await watch.poll();
    expect(alerts.length).toBe(3);
    for (const a of alerts) {
      expect(a.text).not.toMatch(BANNED_COPY);
      expect(a.text.startsWith("Public signal: ")).toBe(true);
    }
  });
});
