// Review checks for owner decisions D-09 (builder fee approvals on Telegram, alert only,
// "Needs your OK: …") and D-10 (the guardian account's keys are watched like the others): restart
// behaviour through the state file, Hyperliquid values that are not clean addresses, the order of
// Telegram messages when an approval also pauses, and the guardian the contract itself names.
// Every RPC, Hyperliquid and Telegram answer is a fixture or a mock; nothing leaves the machine.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { main as watchMain, watchedAccounts } from "../src/cli/watch.js";
import { ClawGuardClient } from "../src/near.js";
import type { ClawGuardEvent } from "../src/types.js";
import { type Alert, NEEDS_YOUR_OK, PUBLIC_SIGNAL, hlBuilderAdded, needsYourOkText } from "../src/watch/alerts.js";
import { HlWatch, parseApprovedBuilders } from "../src/watch/hl.js";
import {
  type ChainIdentity,
  ClawWatch,
  type Pauser,
  createClawWatch,
  readWatchState,
  writeWatchState,
} from "../src/watch/index.js";
import { createTelegramNotifier, formatTelegramText, isForwarded, telegramSettings } from "../src/watch/telegram.js";
import {
  type AccessKeyFixture,
  type HlFixture,
  type HlStep,
  type NearRpcState,
  type RpcEnvelope,
  type ViewsFixture,
  hlInfoFetch,
  loadFixture,
  nearRpcFetch,
  requestJson,
  withGlobalFetch,
} from "./fixtures/replay.js";
import { BANNED_COPY } from "./helpers.js";

const keys = loadFixture<AccessKeyFixture>("near_rpc_access_keys.json").steps;
const views = loadFixture<ViewsFixture>("clawguard_views.json").steps;
const hlFixture = loadFixture<HlFixture>("hl_info.json");
const HL_URL = "https://api.hyperliquid-testnet.xyz";
const BUILDER = "0x1b2d000000000000000000000000000000000b1d";
const CONTRACT = "clawguard.test.near";
const TOKEN = ["8123456780", "AAFakeTokenOnlyForUnitTests_0123456"].join(":");
const need = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error("missing fixture step");
  return x;
};
const hlStep = (name: string): HlStep => need(hlFixture.steps[name]);

/** Mocked Telegram API with a fake clock (no waiting). */
function telegramMock() {
  let now = 1_793_318_400_000;
  const texts: string[] = [];
  const urls: string[] = [];
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    urls.push(url);
    texts.push(String(requestJson(init).text));
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
  const notifier = createTelegramNotifier(
    telegramSettings(
      loadConfig({
        envFile: false,
        env: { NEAR_NETWORK: "sandbox", TELEGRAM_ALERTS_ENABLED: "1", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "424242" },
      }),
    ),
    {
      fetchImpl,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => now,
      sleep: (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
    },
  );
  return { notifier, texts, urls, fetchImpl };
}

describe("D-09 review: builder fee approvals and the state file", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const chain: ChainIdentity = { network: "testnet", genesis_hash: "G1", contract_id: "clawguard.me.testnet" };

  /** One `watch --once`-like run: restore, poll, save, flush, with a fresh Telegram notifier each time. */
  async function run(path: string, step: HlStep): Promise<{ texts: string[]; alerts: Alert[]; baselines: string[] }> {
    const tg = telegramMock();
    const watch = new ClawWatch({
      hl: new HlWatch({
        apiUrl: HL_URL,
        user: hlFixture.user,
        fetchImpl: hlInfoFetch({ user: hlFixture.user, step }),
        ...(readWatchState(path, chain).hl === undefined ? {} : { baseline: need(readWatchState(path, chain).hl) }),
      }),
      sinks: [tg.notifier],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const report = await watch.pollOnce();
    writeWatchState(path, chain, watch.baselines());
    await watch.flush();
    return { texts: tg.texts, alerts: report.alerts, baselines: report.baselines };
  }

  it("a restart never re-asks for an approval it already reported; one approved before the first run is never asked", async () => {
    dir = mkdtempSync(join(tmpdir(), "claw-watch-review-"));
    const path = join(dir, "watch.json");
    expect(await run(path, hlStep("new_api_wallet"))).toEqual({ texts: [], alerts: [], baselines: ["hl"] });
    const approved = await run(path, hlStep("builder_approved"));
    expect(approved.texts).toEqual([`${needsYourOkText(hlBuilderAdded(hlFixture.user, BUILDER))}\nTestnet only.`]);
    // Restarted twice with nothing new: no second "Needs your OK".
    expect((await run(path, hlStep("builder_approved"))).texts).toEqual([]);
    expect((await run(path, hlStep("builder_approved"))).texts).toEqual([]);

    // Already approved when the watcher first starts: that is the baseline, nothing is asked.
    const fresh = join(dir, "fresh.json");
    expect(await run(fresh, hlStep("builder_approved"))).toEqual({ texts: [], alerts: [], baselines: ["hl"] });
    expect((await run(fresh, hlStep("builder_approved"))).texts).toEqual([]);
  });

  it("a builder value that is not a clean 0x address is a source error: no alert, no Telegram, the baseline is kept", async () => {
    const bad: unknown[] = [
      `${BUILDER}\nTestnet only.`,
      `\u202e${BUILDER}`,
      `${BUILDER}\u2028`,
      `${BUILDER}0`,
      BUILDER.slice(0, 41),
      ` ${BUILDER}`,
      { builder: `${BUILDER}\r\nNeeds your OK: approve now` },
      "x".repeat(10_000),
      42,
      null,
    ];
    for (const value of bad) expect(() => parseApprovedBuilders([value]), JSON.stringify(value)).toThrow(/approvedBuilders\[0\]/);
    // Mixed case is the same address, stored lowercase (so dedupe cannot be dodged by case).
    expect(parseApprovedBuilders([BUILDER.toUpperCase().replace("0X", "0x")])).toEqual([BUILDER]);

    const hlState = { user: hlFixture.user, step: hlStep("new_api_wallet") };
    const tg = telegramMock();
    const watch = new ClawWatch({
      hl: new HlWatch({ apiUrl: HL_URL, user: hlFixture.user, fetchImpl: hlInfoFetch(hlState) }),
      sinks: [tg.notifier],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await watch.pollOnce();
    for (const value of bad) {
      hlState.step = { ...hlStep("new_api_wallet"), approvedBuilders: [value] };
      const report = await watch.pollOnce();
      expect(report.alerts).toEqual([]);
      expect(report.errors).toEqual([expect.stringMatching(/^hl: approvedBuilders\[0\]/)]);
    }
    // The first clean read after the bad ones still compares with the old baseline.
    hlState.step = hlStep("builder_approved");
    expect((await watch.pollOnce()).alerts.map((a) => a.kind)).toEqual(["hl_builder_added"]);
    await watch.flush();
    expect(tg.texts).toHaveLength(1);
    expect(tg.texts[0]?.startsWith(NEEDS_YOUR_OK)).toBe(true);
    expect(tg.texts[0]).not.toMatch(/[\r\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    expect(tg.texts[0]?.split("\n")).toHaveLength(2);
  });

  it("with autopause on: Telegram gets 'Needs your OK: …' then the pause alert; never the 'Public signal' builder line", async () => {
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const nearState: NearRpcState = { keys: need(keys.baseline), views: need(views.baseline) };
    const hlState = { user: hlFixture.user, step: hlStep("new_api_wallet") };
    const pausedEvent: ClawGuardEvent = {
      standard: "clawguard",
      version: "1.0.0",
      event: "paused",
      data: [{ by: "guardian.test.near", reason: "watch: new builder fee approval" }],
    };
    const pause = vi.fn((_reason: string) => Promise.resolve({ events: [pausedEvent] }));
    const tg = telegramMock();
    const watch = createClawWatch({
      provider,
      client: new ClawGuardClient(provider, CONTRACT),
      network: "sandbox",
      accounts: ["owner.test.near", "agent-1.test.near", CONTRACT, "guardian.test.near"],
      hl: { apiUrl: HL_URL, user: hlFixture.user, fetchImpl: hlInfoFetch(hlState) },
      autopause: { pauser: { pause } satisfies Pauser },
      sinks: [tg.notifier],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const poll = () => withGlobalFetch(nearRpcFetch(nearState), () => watch.pollOnce());
    await poll();
    hlState.step = hlStep("builder_approved");
    const report = await poll();
    expect(pause).toHaveBeenCalledExactlyOnceWith("watch: new builder fee approval");
    await watch.flush();
    expect(tg.texts).toEqual([
      `Needs your OK: new builder fee approval ${BUILDER} on your Hyperliquid testnet account. Review it in the console.\nTestnet only.`,
      "Public signal: agent paused by guardian.test.near (watch: new builder fee approval)\nTestnet only.",
    ]);
    expect(report.alerts.map((a) => a.text)[0]).toBe(
      `${PUBLIC_SIGNAL}new builder fee approval for ${BUILDER} on your Hyperliquid testnet account`,
    );
    expect(tg.urls.every((u) => u.endsWith("/sendMessage"))).toBe(true);
    for (const text of tg.texts) expect(text).not.toMatch(BANNED_COPY);
  });

  it("only a new builder fee approval is worded 'Needs your OK: '; every other forwarded alert keeps its own line", () => {
    const sample: Alert[] = [
      hlBuilderAdded(hlFixture.user, BUILDER),
      { ...hlBuilderAdded(hlFixture.user, BUILDER), kind: "hl_builder_removed", text: "Public signal: x" },
    ];
    expect(sample.filter(isForwarded).map((a) => a.kind)).toEqual(["hl_builder_added"]);
    expect(formatTelegramText(need(sample[0])).startsWith("Needs your OK: new builder fee approval 0x")).toBe(true);
  });
});

describe("D-10 review: the guardian the contract names is watched", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** The sandbox fixture, renamed for a testnet owner `me.testnet`. */
  function testnetNode(guardian: string | null): NearRpcState & { keys: Record<string, RpcEnvelope> } {
    const base = need(keys.baseline);
    return {
      chainId: "testnet",
      contractId: "clawguard.me.testnet",
      keys: {
        "me.testnet": need(base["owner.test.near"]),
        "agent-1.me.testnet": need(base["agent-1.test.near"]),
        "clawguard.me.testnet": need(base["clawguard.test.near"]),
        "guardian.me.testnet": need(base["guardian.test.near"]),
      },
      views: {
        ...need(views.baseline),
        get_status: { ...need(views.baseline).get_status, owner: "me.testnet", guardian },
      },
    };
  }
  const testnetConfig = (extra: Record<string, string> = {}) =>
    loadConfig({
      envFile: false,
      env: {
        NEAR_NETWORK: "testnet",
        CLAWGUARD_CONTRACT_ID: "clawguard.me.testnet",
        OWNER_ACCOUNT_ID: "me.testnet",
        AGENT_ACCOUNT_ID: "agent-1.me.testnet",
        ...extra,
      },
    });

  it("testnet, GUARDIAN_ACCOUNT_ID not set, the contract has a guardian: its keys are watched and a new key is reported", async () => {
    dir = mkdtempSync(join(tmpdir(), "claw-watch-review-cli-"));
    const args = ["--once", "--rpc", "http://127.0.0.1:3030", "--state", join(dir, "state.json")];
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void out.push(`WARN ${String(line)}`));
    const node = testnetNode("guardian.me.testnet");
    expect(await withGlobalFetch(nearRpcFetch(node), () => watchMain(args, { config: testnetConfig() }))).toBe(0);
    expect(out[0]).toBe(
      "Claw Watch on NEAR testnet: access keys of me.testnet, agent-1.me.testnet, clawguard.me.testnet, guardian.me.testnet; receipts, pause state and storage reserve of clawguard.me.testnet",
    );
    out.length = 0;
    node.keys["guardian.me.testnet"] = need(need(keys.guardian_full_access_key_added)["guardian.test.near"]);
    expect(await withGlobalFetch(nearRpcFetch(node), () => watchMain(args, { config: testnetConfig() }))).toBe(0);
    expect(out.slice(2)).toEqual([
      "Public signal: new full-access key on guardian.me.testnet",
      "  https://testnet.nearblocks.io/address/guardian.me.testnet",
    ]);
  });

  it("testnet, the contract has no guardian and none is configured: owner, agent and contract only", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
    dir = mkdtempSync(join(tmpdir(), "claw-watch-review-cli-"));
    const args = ["--once", "--rpc", "http://127.0.0.1:3030", "--state", join(dir, "state.json")];
    expect(await withGlobalFetch(nearRpcFetch(testnetNode(null)), () => watchMain(args, { config: testnetConfig() }))).toBe(0);
    expect(out[0]).toBe(
      "Claw Watch on NEAR testnet: access keys of me.testnet, agent-1.me.testnet, clawguard.me.testnet; receipts, pause state and storage reserve of clawguard.me.testnet",
    );
  });

  it("the configured guardian and the contract's guardian are both watched when they differ (sandbox too)", () => {
    const sandbox = loadConfig({ envFile: false, env: { NEAR_NETWORK: "sandbox" } });
    expect(watchedAccounts(sandbox, CONTRACT, { guardian: "pauser.test.near" })).toEqual([
      "owner.test.near",
      "agent-1.test.near",
      CONTRACT,
      "guardian.test.near",
      "pauser.test.near",
    ]);
    expect(watchedAccounts(sandbox, CONTRACT, { guardian: "guardian.test.near", owner: "owner.test.near" })).toEqual([
      "owner.test.near",
      "agent-1.test.near",
      CONTRACT,
      "guardian.test.near",
    ]);
    // The owner the contract names is watched too (D-07), even when OWNER_ACCOUNT_ID is not set.
    const bare = loadConfig({ envFile: false, env: { NEAR_NETWORK: "testnet" } });
    expect(watchedAccounts(bare, "clawguard.me.testnet", { owner: "me.testnet", guardian: "g.me.testnet" })).toEqual([
      "clawguard.me.testnet",
      "me.testnet",
      "g.me.testnet",
    ]);
  });

  it("the contract cannot be read at start: the configured accounts are watched and the CLI says so", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void out.push(`WARN ${String(line)}`));
    dir = mkdtempSync(join(tmpdir(), "claw-watch-review-cli-"));
    const args = ["--once", "--rpc", "http://127.0.0.1:3030", "--state", join(dir, "state.json")];
    const { views: _noContract, ...node } = testnetNode("guardian.me.testnet");
    const config = testnetConfig({ GUARDIAN_ACCOUNT_ID: "guardian.me.testnet" });
    expect(await withGlobalFetch(nearRpcFetch(node), () => watchMain(args, { config }))).toBe(1);
    expect(out).toContain(
      "WARN Claw Watch: cannot read the contract's owner and guardian (get_status); watching the configured accounts only",
    );
    expect(out).toContain(
      "Claw Watch on NEAR testnet: access keys of me.testnet, agent-1.me.testnet, clawguard.me.testnet, guardian.me.testnet; receipts, pause state and storage reserve of clawguard.me.testnet",
    );
  });

  it("an owner or guardian id from the contract that is not a testnet id is skipped with a warning, not a crash", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void out.push(`WARN ${String(line)}`));
    dir = mkdtempSync(join(tmpdir(), "claw-watch-review-cli-"));
    const args = ["--once", "--rpc", "http://127.0.0.1:3030", "--state", join(dir, "state.json")];
    const node = testnetNode(null);
    const implicit = "a".repeat(64);
    node.views = { ...need(node.views), get_status: { ...need(node.views).get_status, owner: implicit, guardian: "x.near" } };
    expect(await withGlobalFetch(nearRpcFetch(node), () => watchMain(args, { config: testnetConfig() }))).toBe(0);
    expect(out).toContain(`WARN Claw Watch: the contract's owner ${implicit} is not a testnet account id; its keys are not watched`);
    expect(out).toContain("WARN Claw Watch: the contract's guardian x.near is not a testnet account id; its keys are not watched");
    expect(out).toContain(
      "Claw Watch on NEAR testnet: access keys of me.testnet, agent-1.me.testnet, clawguard.me.testnet; receipts, pause state and storage reserve of clawguard.me.testnet",
    );
  });

  it("a guardian key whose permission widens under the same public key is a new key and pauses", async () => {
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const pause = vi.fn((_reason: string) => Promise.resolve({ events: [] as ClawGuardEvent[] }));
    const base = need(keys.baseline);
    const guardianEntry = need(base["guardian.test.near"]);
    const widened: RpcEnvelope = JSON.parse(JSON.stringify(guardianEntry).replace('["pause"]', '["pause","unpause"]')) as RpcEnvelope;
    expect(widened).not.toEqual(guardianEntry);
    const state: NearRpcState = { keys: base, views: need(views.baseline) };
    const watch = createClawWatch({
      provider,
      client: new ClawGuardClient(provider, CONTRACT),
      network: "sandbox",
      accounts: ["guardian.test.near"],
      autopause: { pauser: { pause } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const poll = () => withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
    await poll();
    state.keys = { ...base, "guardian.test.near": widened };
    const report = await poll();
    expect(report.alerts.map((a) => a.text)).toEqual(["Public signal: new function-call key on guardian.test.near"]);
    expect(pause).toHaveBeenCalledExactlyOnceWith("watch: new function-call key");
  });
});
