// Claw Watch orchestration: the in-process API the demo uses (baseline, alert,
// guardian autopause), source isolation, the state file and the `watch --once` CLI. All RPC and
// HTTP traffic is served from test/fixtures (no network).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { main as watchMain, watchedAccounts } from "../src/cli/watch.js";
import { ClawGuardClient } from "../src/near.js";
import type { ClawGuardEvent } from "../src/types.js";
import {
  type ChainIdentity,
  ClawWatch,
  type Pauser,
  assertPauseOnlyGuardianKey,
  createClawWatch,
  pauseReason,
  readWatchState,
  reportLines,
  writeWatchState,
} from "../src/watch/index.js";
import { HlWatch } from "../src/watch/hl.js";
import { ReceiptsWatch } from "../src/watch/receipts.js";
import {
  type AccessKeyFixture,
  type HlFixture,
  type NearRpcState,
  type RpcEnvelope,
  type ViewsFixture,
  hlInfoFetch,
  loadFixture,
  nearRpcFetch,
  withGlobalFetch,
} from "./fixtures/replay.js";

const keys = loadFixture<AccessKeyFixture>("near_rpc_access_keys.json").steps;
const views = loadFixture<ViewsFixture>("clawguard_views.json").steps;
const hlFixture = loadFixture<HlFixture>("hl_info.json");
const ACCOUNTS = ["owner.test.near", "agent-1.test.near", "clawguard.test.near"];
const GUARDIAN = "guardian.test.near";
/** What the CLI watches since owner decision D-10: owner, agent, contract and guardian. */
const WITH_GUARDIAN = [...ACCOUNTS, GUARDIAN];
const CONTRACT = "clawguard.test.near";
const need = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error("missing fixture step");
  return x;
};

const pausedEvent = (by: string, reason: string): ClawGuardEvent => ({
  standard: "clawguard",
  version: "1.0.0",
  event: "paused",
  data: [{ by, reason }],
});

/** A guardian stand-in that records the reasons it was asked to pause with. */
function fakeGuardian(fail = false) {
  const pause = vi.fn((reason: string) =>
    fail ? Promise.reject(new Error("guardian key rejected")) : Promise.resolve({ events: [pausedEvent("guardian.test.near", reason)] }),
  );
  return { pauser: { pause } satisfies Pauser, pause };
}

function demoSetup(options: { autopause?: Pauser; hl?: boolean; accounts?: readonly string[] } = {}) {
  const state: NearRpcState = { keys: need(keys.baseline), views: need(views.baseline) };
  const hlState = { user: hlFixture.user, step: need(hlFixture.steps.baseline) };
  const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
  const watch = createClawWatch({
    provider,
    client: new ClawGuardClient(provider, CONTRACT),
    network: "sandbox",
    accounts: options.accounts ?? ACCOUNTS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...(options.autopause === undefined ? {} : { autopause: { pauser: options.autopause } }),
    ...(options.hl === true
      ? { hl: { apiUrl: "https://api.hyperliquid-testnet.xyz", user: hlFixture.user, fetchImpl: hlInfoFetch(hlState) } }
      : {}),
  });
  const poll = () => withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
  return { state, hlState, watch, poll };
}

describe("ClawWatch in-process (the demo flow)", () => {
  it("baseline, then a new full-access key on the agent -> alert -> guardian pause('watch: new full-access key')", async () => {
    const guardian = fakeGuardian();
    const { state, poll } = demoSetup({ autopause: guardian.pauser });
    const first = await poll();
    expect(first).toEqual({ alerts: [], errors: [], baselines: ["near_keys", "receipts"] });
    expect(guardian.pause).not.toHaveBeenCalled();

    state.keys = need(keys.agent_full_access_key_added);
    const report = await poll();
    expect(guardian.pause).toHaveBeenCalledExactlyOnceWith("watch: new full-access key");
    expect(report.autopause).toEqual({ status: "paused", reason: "watch: new full-access key" });
    expect(report.alerts.map((a) => a.text)).toEqual([
      "Public signal: new full-access key on agent-1.test.near",
      "Public signal: agent paused by guardian.test.near (watch: new full-access key)",
    ]);
    expect(reportLines(report)).toContainEqual(["info", "Claw Watch: guardian pause sent (watch: new full-access key)"]);

    // The chain now says paused with the same reason: no repeated pause alert, no second pause.
    state.views = need(views.paused);
    const after = await poll();
    expect(after.alerts.map((a) => a.text)).toEqual([
      "Order #2 by agent-1.test.near: Blocked by your rule: market DOGE is not on your list",
      "Order #3 by agent-1.test.near: Blocked by your rule: order is above your per-order cap",
      "Order #4 by agent-1.test.near: Blocked by your rule: leverage 50x is above your limit of 3x",
      "Order #5 by agent-1.test.near: Blocked by your rule: receiver 0xbadbadbadbadbadbadbadbadbadbadbadbadbad0 is not on your list",
      "Order #6 by agent-1.test.near: Blocked by your rule: this order would go over your daily cap",
      "Order #7 by agent-1.test.near: Blocked by your rule: agent is paused (watch: new full-access key)",
      "Public signal: 6 orders blocked in the last 10 min",
    ]);
    // The burst would justify a pause, but the guard is already paused.
    expect(after.autopause).toMatchObject({ status: "skipped", detail: "the guard is already paused" });
    expect(guardian.pause).toHaveBeenCalledTimes(1);
  });

  it("autopause off -> never pauses", async () => {
    const { state, poll, watch } = demoSetup();
    expect(watch.autopauseEnabled).toBe(false);
    await poll();
    state.keys = need(keys.agent_full_access_key_added);
    const report = await poll();
    expect(report.autopause).toBeUndefined();
    expect(report.alerts.map((a) => a.text)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
  });

  it("a new full-access key wins over a burst of blocked orders for the pause reason", async () => {
    const guardian = fakeGuardian();
    const { state, poll } = demoSetup({ autopause: guardian.pauser });
    await poll();
    state.keys = need(keys.agent_full_access_key_added);
    state.views = need(views.injection);
    const report = await poll();
    expect(report.alerts.map((a) => a.kind)).toContain("blocked_burst");
    expect(guardian.pause).toHaveBeenCalledExactlyOnceWith("watch: new full-access key");
  });

  it("only selected alert kinds trigger the pause", async () => {
    const guardian = fakeGuardian();
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const state: NearRpcState = { keys: need(keys.baseline), views: need(views.baseline) };
    const watch = createClawWatch({
      provider,
      client: new ClawGuardClient(provider, CONTRACT),
      network: "sandbox",
      accounts: ACCOUNTS,
      autopause: { pauser: guardian.pauser, on: ["near_key_added"] },
    });
    await withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
    state.views = need(views.injection);
    const report = await withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
    expect(report.alerts.map((a) => a.kind)).toContain("blocked_burst");
    expect(guardian.pause).not.toHaveBeenCalled();
  });

  it("a failed pause is reported, never thrown", async () => {
    const guardian = fakeGuardian(true);
    const { state, poll } = demoSetup({ autopause: guardian.pauser });
    await poll();
    state.keys = need(keys.agent_full_access_key_added);
    const report = await poll();
    expect(report.autopause).toEqual({ status: "failed", reason: "watch: new full-access key", error: "guardian key rejected" });
    expect(report.errors).toEqual(["autopause: guardian key rejected"]);
    expect(reportLines(report)).toContainEqual([
      "error",
      "Claw Watch: guardian pause failed (watch: new full-access key): guardian key rejected",
    ]);
  });

  it("if the guard's status could not be read, it pauses anyway (fail closed)", async () => {
    const guardian = fakeGuardian();
    const { state, poll } = demoSetup({ autopause: guardian.pauser });
    state.views = need(views.paused);
    await poll();
    delete state.views; // get_status now fails
    state.keys = need(keys.agent_full_access_key_added);
    const report = await poll();
    expect(report.errors.some((e) => e.startsWith("receipts: "))).toBe(true);
    expect(guardian.pause).toHaveBeenCalledOnce();
  });

  it("one failing source does not hide the others", async () => {
    const { state, hlState, poll } = demoSetup({ hl: true });
    await poll();
    hlState.step = { extraAgents: "garbage", approvedBuilders: [] };
    state.keys = need(keys.agent_full_access_key_added);
    const report = await poll();
    expect(report.errors).toEqual(["hl: extraAgents: expected a list"]);
    expect(report.alerts.map((a) => a.text)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
    hlState.step = need(hlFixture.steps.new_api_wallet);
    expect((await poll()).alerts.map((a) => a.text)).toEqual([
      "Public signal: new API wallet 0x00000000000000000000000000000000000b0b01 on your Hyperliquid testnet account",
    ]);
  });

  it("sinks get every alert; a failing sink is logged and does not stop the cycle", async () => {
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const state: NearRpcState = { keys: need(keys.baseline) };
    const seen: string[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const watch = createClawWatch({
      provider,
      network: "sandbox",
      accounts: ACCOUNTS,
      logger,
      sinks: [{ notify: () => Promise.reject(new Error("sink down")) }, { notify: (alerts) => void seen.push(...alerts.map((a) => a.text)) }],
    });
    await withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
    state.keys = need(keys.agent_full_access_key_added);
    await withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
    expect(seen).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
    expect(logger.error).toHaveBeenCalledWith("Claw Watch: alert sink failed: sink down");
  });

  it("refuses overlapping polls and needs a source", async () => {
    expect(() => new ClawWatch({})).toThrow(/at least one source/);
    const { state, watch } = demoSetup();
    const run = withGlobalFetch(nearRpcFetch(state), async () => {
      const first = watch.pollOnce();
      await expect(watch.pollOnce()).rejects.toThrow(/already running/);
      return first;
    });
    await expect(run).resolves.toMatchObject({ baselines: ["near_keys", "receipts"] });
  });

  it("run() polls until aborted, then flushes", async () => {
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const flush = vi.fn(() => Promise.resolve());
    const watch = createClawWatch({ provider, network: "sandbox", accounts: ACCOUNTS, sinks: [{ notify: () => undefined, flush }] });
    const stop = new AbortController();
    let cycles = 0;
    await withGlobalFetch(nearRpcFetch({ keys: need(keys.baseline) }), () =>
      watch.run({
        intervalSec: 1,
        signal: stop.signal,
        onReport: () => {
          cycles += 1;
          if (cycles === 2) stop.abort();
        },
      }),
    );
    expect(cycles).toBe(2);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("pause reasons always fit the contract's 140-byte limit", () => {
    expect(pauseReason("watch: new full-access key")).toBe("watch: new full-access key");
    const long = pauseReason(`watch: ${"é".repeat(300)}\nsecond line`);
    expect(Buffer.byteLength(long)).toBe(140);
    expect(long).toBe(`watch: ${"é".repeat(65)}…`);
    expect(long).not.toContain("\n");
    expect(Buffer.byteLength(pauseReason("\u{1F600}".repeat(36)))).toBeLessThanOrEqual(140);
    expect(pauseReason("x".repeat(140))).toBe("x".repeat(140));
  });
});

describe("guardian account keys are watched too (owner decision D-10)", () => {
  it("first poll is a baseline only, for the guardian as for the other accounts", async () => {
    const guardian = fakeGuardian();
    const { poll, watch } = demoSetup({ autopause: guardian.pauser, accounts: WITH_GUARDIAN });
    expect(await poll()).toEqual({ alerts: [], errors: [], baselines: ["near_keys", "receipts"] });
    expect(Object.keys(watch.baselines().near_keys?.accounts ?? {})).toContain(GUARDIAN);
    expect((await poll()).alerts).toEqual([]);
    expect(guardian.pause).not.toHaveBeenCalled();
  });

  it("a new full-access key on the guardian -> alert -> guardian pause('watch: new full-access key')", async () => {
    const guardian = fakeGuardian();
    const { state, poll } = demoSetup({ autopause: guardian.pauser, accounts: WITH_GUARDIAN });
    await poll();
    state.keys = need(keys.guardian_full_access_key_added);
    const report = await poll();
    expect(report.alerts.map((a) => a.text)).toEqual([
      "Public signal: new full-access key on guardian.test.near",
      "Public signal: agent paused by guardian.test.near (watch: new full-access key)",
    ]);
    expect(report.alerts[0]).toMatchObject({ kind: "near_key_added", account: GUARDIAN, keyKind: "FullAccess" });
    expect(guardian.pause).toHaveBeenCalledExactlyOnceWith("watch: new full-access key");
    expect(report.autopause).toEqual({ status: "paused", reason: "watch: new full-access key" });
  });

  it("a new function-call key on the guardian -> alert -> guardian pause('watch: new function-call key')", async () => {
    const guardian = fakeGuardian();
    const { state, poll } = demoSetup({ autopause: guardian.pauser, accounts: WITH_GUARDIAN });
    await poll();
    state.keys = need(keys.guardian_function_call_key_added);
    const report = await poll();
    expect(report.alerts.map((a) => a.text)[0]).toBe("Public signal: new function-call key on guardian.test.near");
    expect(guardian.pause).toHaveBeenCalledExactlyOnceWith("watch: new function-call key");
  });

  it("without autopause a new guardian key only alerts", async () => {
    const { state, poll } = demoSetup({ accounts: WITH_GUARDIAN });
    await poll();
    state.keys = need(keys.guardian_function_call_key_added);
    const report = await poll();
    expect(report.alerts.map((a) => a.text)).toEqual(["Public signal: new function-call key on guardian.test.near"]);
    expect(report.autopause).toBeUndefined();
  });

  it("a key removed from the guardian alerts but never pauses", async () => {
    const guardian = fakeGuardian();
    const { state, poll } = demoSetup({ autopause: guardian.pauser, accounts: WITH_GUARDIAN });
    state.keys = need(keys.guardian_full_access_key_added);
    await poll();
    state.keys = need(keys.baseline);
    const report = await poll();
    expect(report.alerts.map((a) => a.text)).toEqual(["Public signal: key removed from guardian.test.near"]);
    expect(report.autopause).toBeUndefined();
    expect(guardian.pause).not.toHaveBeenCalled();
  });

  it("the guardian's own pause call (nonce and allowance change) is not a new key", async () => {
    const { state, poll } = demoSetup({ accounts: WITH_GUARDIAN });
    state.keys = need(keys.agent_full_access_key_added);
    await poll();
    state.keys = need(keys.owner_function_call_key_added);
    expect((await poll()).alerts.map((a) => a.text)).toEqual(["Public signal: new function-call key on owner.test.near"]);
  });
});

describe("guardian key check", () => {
  const guardianKeys = (permission: unknown): RpcEnvelope => ({
    jsonrpc: "2.0",
    id: "x",
    result: { block_hash: "h", block_height: 1, keys: [{ public_key: "ed25519:G1", access_key: { nonce: 1, permission } }] },
  });
  const check = (permission: unknown, publicKey = "ed25519:G1") =>
    withGlobalFetch(nearRpcFetch({ keys: { "guardian.test.near": guardianKeys(permission) } }), () =>
      assertPauseOnlyGuardianKey(new JsonRpcProvider({ url: "http://127.0.0.1:3030" }), "guardian.test.near", publicKey, CONTRACT),
    );
  const fc = (methods: string[], receiver = CONTRACT) => ({
    FunctionCall: { allowance: "1", method_names: methods, receiver_id: receiver },
  });

  it("accepts a function-call key for the contract with only `pause`", async () => {
    await expect(check(fc(["pause"]))).resolves.toBeUndefined();
  });

  it("refuses a full-access key, extra methods, another receiver, or an unknown key", async () => {
    await expect(check("FullAccess")).rejects.toThrow(/method pause only \(it is a FullAccess key\)/);
    await expect(check(fc(["pause", "unpause"]))).rejects.toThrow(/autopause refused/);
    await expect(check(fc([]))).rejects.toThrow(/autopause refused/);
    await expect(check(fc(["pause"], "other.test.near"))).rejects.toThrow(/autopause refused/);
    await expect(check(fc(["pause"]), "ed25519:Other")).rejects.toThrow(/not an access key of guardian.test.near/);
  });
});

describe("state file", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const chain: ChainIdentity = { network: "sandbox", genesis_hash: "G1", contract_id: CONTRACT };

  it("round-trips baselines, so a restarted watcher compares with the last run", async () => {
    dir = mkdtempSync(join(tmpdir(), "claw-watch-"));
    const path = join(dir, "nested", "watch.json");
    const a = demoSetup({ hl: true });
    await a.poll();
    writeWatchState(path, chain, a.watch.baselines());
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const restored = readWatchState(path, chain, logger);
    expect(Object.keys(restored).sort()).toEqual(["hl", "near_keys", "receipts"]);
    expect(logger.warn).not.toHaveBeenCalled();

    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const b = createClawWatch({ provider, client: new ClawGuardClient(provider, CONTRACT), network: "sandbox", accounts: ACCOUNTS, baselines: restored });
    const report = await withGlobalFetch(nearRpcFetch({ keys: need(keys.agent_full_access_key_added), views: need(views.baseline) }), () =>
      b.pollOnce(),
    );
    expect(report.baselines).toEqual([]);
    expect(report.alerts.map((x) => x.text)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
  });

  it("another chain, a missing file or a damaged baseline -> new baseline", async () => {
    dir = mkdtempSync(join(tmpdir(), "claw-watch-"));
    const path = join(dir, "watch.json");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(readWatchState(path, chain, logger)).toEqual({});
    const a = demoSetup();
    await a.poll();
    writeWatchState(path, chain, a.watch.baselines());
    expect(readWatchState(path, { ...chain, genesis_hash: "G2" }, logger)).toEqual({});
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/another chain or contract/));
    const file = JSON.parse(readFileSync(path, "utf8")) as { near_keys: { accounts: Record<string, unknown[]> } };
    file.near_keys.accounts["agent-1.test.near"] = [];
    writeFileSync(path, JSON.stringify(file));
    expect(Object.keys(readWatchState(path, chain, logger))).toEqual(["receipts"]);
    expect(logger.warn).toHaveBeenCalledWith("Claw Watch: stored near_keys baseline failed its check; recording a new one");
    writeFileSync(path, "{not json");
    expect(readWatchState(path, chain, logger)).toEqual({});
  });
});

describe("watch CLI (--once)", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const sandboxConfig = (extra: Record<string, string> = {}) =>
    loadConfig({ envFile: false, env: { NEAR_NETWORK: "sandbox", CLAWGUARD_CONTRACT_ID: CONTRACT, ...extra } });

  it("first run records a baseline, the next run reports what changed", async () => {
    dir = mkdtempSync(join(tmpdir(), "claw-watch-cli-"));
    const statePath = join(dir, "state.json");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void out.push(`WARN ${String(line)}`));
    const args = ["--once", "--rpc", "http://127.0.0.1:3030", "--state", statePath];
    const state: NearRpcState = { keys: need(keys.baseline), views: need(views.baseline) };

    const first = await withGlobalFetch(nearRpcFetch(state), () => watchMain(args, { config: sandboxConfig() }));
    expect(first).toBe(0);
    expect(out).toEqual([
      "Claw Watch on NEAR sandbox: access keys of owner.test.near, agent-1.test.near, clawguard.test.near, guardian.test.near; receipts, pause state and storage reserve of clawguard.test.near",
      "Claw Watch: Hyperliquid testnet source off; autopause off; Telegram alerts off",
      "Claw Watch: baseline recorded (near_keys, receipts, storage)",
    ]);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ version: 1, chain: { network: "sandbox", contract_id: CONTRACT } });

    out.length = 0;
    state.keys = need(keys.agent_full_access_key_added);
    expect(await withGlobalFetch(nearRpcFetch(state), () => watchMain(args, { config: sandboxConfig() }))).toBe(0);
    expect(out.slice(2)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);

    out.length = 0;
    expect(await withGlobalFetch(nearRpcFetch(state), () => watchMain(args, { config: sandboxConfig() }))).toBe(0);
    expect(out.slice(2)).toEqual(["Claw Watch: no changes"]);

    // D-10: a new key on the guardian account is reported like any other.
    out.length = 0;
    state.keys = { ...need(keys.agent_full_access_key_added), [GUARDIAN]: need(need(keys.guardian_full_access_key_added)[GUARDIAN]) };
    expect(await withGlobalFetch(nearRpcFetch(state), () => watchMain(args, { config: sandboxConfig() }))).toBe(0);
    expect(out.slice(2)).toEqual(["Public signal: new full-access key on guardian.test.near"]);
  });

  it("refuses a mainnet-looking RPC before any request", async () => {
    await expect(watchMain(["--once", "--rpc", "https://rpc.mainnet.near.org"], { config: sandboxConfig() })).rejects.toThrow(
      /ERR_MAINNET_REFUSED/,
    );
  });

  it("autopause needs the guardian account and its key", async () => {
    const state: NearRpcState = { keys: need(keys.baseline), views: need(views.baseline) };
    const config = sandboxConfig({ CLAW_WATCH_AUTOPAUSE: "1" });
    await expect(
      withGlobalFetch(nearRpcFetch(state), () => watchMain(["--once", "--rpc", "http://127.0.0.1:3030"], { config })),
    ).rejects.toThrow(/GUARDIAN_ACCOUNT_ID is required/);
    const withKey = sandboxConfig({
      CLAW_WATCH_AUTOPAUSE: "1",
      GUARDIAN_ACCOUNT_ID: "guardian.test.near",
      GUARDIAN_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
    });
    // The fixture guardian holds only its own pause-only key, not this one: refused before watching starts.
    await expect(
      withGlobalFetch(nearRpcFetch(state), () => watchMain(["--once", "--rpc", "http://127.0.0.1:3030"], { config: withKey })),
    ).rejects.toThrow(/GUARDIAN_PRIVATE_KEY is not an access key of guardian\.test\.near/);
    // No key list for the guardian at all: refused too.
    const noGuardian: NearRpcState = { ...state, keys: { ...state.keys } };
    delete noGuardian.keys?.[GUARDIAN];
    await expect(
      withGlobalFetch(nearRpcFetch(noGuardian), () => watchMain(["--once", "--rpc", "http://127.0.0.1:3030"], { config: withKey })),
    ).rejects.toThrow(/UNKNOWN_ACCOUNT|does not exist/);
  });

  it("watches owner, agent, contract and guardian (sandbox defaults)", () => {
    expect(watchedAccounts(sandboxConfig(), CONTRACT)).toEqual(WITH_GUARDIAN);
    expect(watchedAccounts(sandboxConfig({ GUARDIAN_ACCOUNT_ID: "pauser.test.near" }), CONTRACT)).toEqual([
      ...ACCOUNTS,
      "pauser.test.near",
    ]);
  });

  it("on testnet the guardian is watched when GUARDIAN_ACCOUNT_ID is set, and left out when not (D-10)", () => {
    const testnet = (extra: Record<string, string> = {}) =>
      loadConfig({
        envFile: false,
        env: { NEAR_NETWORK: "testnet", OWNER_ACCOUNT_ID: "me.testnet", AGENT_ACCOUNT_ID: "agent-1.me.testnet", ...extra },
      });
    expect(watchedAccounts(testnet(), "clawguard.me.testnet")).toEqual(["me.testnet", "agent-1.me.testnet", "clawguard.me.testnet"]);
    expect(watchedAccounts(testnet({ GUARDIAN_ACCOUNT_ID: "guardian.me.testnet" }), "clawguard.me.testnet")).toEqual([
      "me.testnet",
      "agent-1.me.testnet",
      "clawguard.me.testnet",
      "guardian.me.testnet",
    ]);
    // An account named twice is watched once.
    expect(watchedAccounts(testnet({ GUARDIAN_ACCOUNT_ID: "me.testnet" }), "clawguard.me.testnet")).toEqual([
      "me.testnet",
      "agent-1.me.testnet",
      "clawguard.me.testnet",
    ]);
  });
});

describe("sources are usable on their own", () => {
  it("HlWatch + ReceiptsWatch without NEAR keys", async () => {
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const hlState = { user: hlFixture.user, step: need(hlFixture.steps.baseline) };
    const watch = new ClawWatch({
      hl: new HlWatch({ apiUrl: "https://api.hyperliquid-testnet.xyz", user: hlFixture.user, fetchImpl: hlInfoFetch(hlState) }),
      receipts: new ReceiptsWatch({ reader: new ClawGuardClient(provider, CONTRACT) }),
    });
    expect(watch.sourceNames).toEqual(["hl", "receipts"]);
    const report = await withGlobalFetch(nearRpcFetch({ views: need(views.baseline) }), () => watch.pollOnce());
    expect(report.baselines).toEqual(["hl", "receipts"]);
  });
});
