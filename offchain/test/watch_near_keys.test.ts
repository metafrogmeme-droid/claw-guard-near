// Claw Watch NEAR key source: fixture view_access_key_list responses replayed through
// near-api-js's real JsonRpcProvider (global fetch routed to the fixture; no network).
import { JsonRpcProvider } from "near-api-js";
import { describe, expect, it } from "vitest";
import type { Alert } from "../src/watch/alerts.js";
import {
  NearKeysWatch,
  type WatchedKey,
  buildKeySnapshot,
  diffKeySnapshots,
  restoreKeySnapshot,
  toWatchedKey,
} from "../src/watch/near_keys.js";
import { type AccessKeyFixture, type NearRpcState, loadFixture, nearRpcFetch, withGlobalFetch } from "./fixtures/replay.js";
import { BANNED_COPY } from "./helpers.js";

const fixture = loadFixture<AccessKeyFixture>("near_rpc_access_keys.json");
const ACCOUNTS = ["owner.test.near", "agent-1.test.near", "clawguard.test.near"];
const step = (name: string) => {
  const s = fixture.steps[name];
  if (s === undefined) throw new Error(`no fixture step ${name}`);
  return s;
};

/** A watcher on a fake node; `goTo(step)` changes what the node answers. */
function setup(network: "sandbox" | "testnet" = "sandbox") {
  const state: NearRpcState = { keys: step("baseline") };
  const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
  const watch = new NearKeysWatch({ provider, accounts: ACCOUNTS, network, now: () => 1_793_318_400_000 });
  const poll = () => withGlobalFetch(nearRpcFetch(state), () => watch.poll());
  return { state, watch, poll, goTo: (name: string) => (state.keys = step(name)) };
}

const texts = (alerts: readonly Alert[]) => alerts.map((a) => a.text);

describe("NearKeysWatch with recorded-format RPC fixtures", () => {
  it("first poll records the baseline only", async () => {
    const { poll, watch } = setup();
    const first = await poll();
    expect(first).toEqual({ alerts: [], errors: [], baseline: true });
    expect(Object.keys(watch.snapshot?.accounts ?? {})).toEqual([...ACCOUNTS].sort());
    expect(watch.snapshot?.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Unchanged chain: nothing to report, same hash.
    const hash = watch.snapshot?.snapshot_sha256;
    expect(await poll()).toEqual({ alerts: [], errors: [], baseline: false });
    expect(watch.snapshot?.snapshot_sha256).toBe(hash);
  });

  it("new full-access key on the agent account -> one alert (nonce and allowance changes are ignored)", async () => {
    const { poll, goTo } = setup();
    await poll();
    goTo("agent_full_access_key_added");
    const { alerts } = await poll();
    expect(texts(alerts)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
    expect(alerts[0]).toMatchObject({
      kind: "near_key_added",
      keyKind: "FullAccess",
      account: "agent-1.test.near",
      autopauseReason: "watch: new full-access key",
    });
    expect(alerts[0]?.explorerUrl).toBeUndefined(); // sandbox: no explorer
  });

  it("new function-call key -> alert", async () => {
    const { poll, goTo } = setup();
    goTo("agent_full_access_key_added");
    await poll();
    goTo("owner_function_call_key_added");
    const { alerts } = await poll();
    expect(texts(alerts)).toEqual(["Public signal: new function-call key on owner.test.near"]);
    expect(alerts[0]).toMatchObject({ keyKind: "FunctionCall", autopauseReason: "watch: new function-call key" });
  });

  it("key removed -> alert (no pause reason)", async () => {
    const { poll, goTo } = setup();
    goTo("owner_function_call_key_added");
    await poll();
    goTo("contract_key_removed");
    const { alerts } = await poll();
    expect(texts(alerts)).toEqual(["Public signal: key removed from clawguard.test.near"]);
    expect(alerts[0]?.autopauseReason).toBeUndefined();
  });

  it("all steps from the baseline at once -> every change reported", async () => {
    const { poll, goTo } = setup();
    await poll();
    goTo("contract_key_removed");
    expect(texts((await poll()).alerts).sort()).toEqual([
      "Public signal: key removed from clawguard.test.near",
      "Public signal: new full-access key on agent-1.test.near",
      "Public signal: new function-call key on owner.test.near",
    ]);
  });

  it("testnet alerts carry the testnet explorer link", async () => {
    const { poll, goTo } = setup("testnet");
    await poll();
    goTo("agent_full_access_key_added");
    const [alert] = (await poll()).alerts;
    expect(alert?.explorerUrl).toBe("https://testnet.nearblocks.io/address/agent-1.test.near");
  });

  it("an account that cannot be read keeps its baseline (no silent re-baseline)", async () => {
    const { state, poll, watch } = setup();
    await poll();
    const baselineAgentKeys = watch.snapshot?.accounts["agent-1.test.near"];
    // The agent account disappears from the node for one poll.
    state.keys = { ...step("agent_full_access_key_added") };
    delete state.keys["agent-1.test.near"];
    const failed = await poll();
    expect(failed.alerts).toEqual([]);
    expect(failed.errors).toEqual([expect.stringMatching(/^cannot read access keys of agent-1\.test\.near: /)]);
    expect(watch.snapshot?.accounts["agent-1.test.near"]).toEqual(baselineAgentKeys);
    // Back again, with the attacker key: still compared with the old baseline.
    state.keys = step("agent_full_access_key_added");
    expect(texts((await poll()).alerts)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
  });

  it("an account never read before is a baseline, not a new key", async () => {
    const { state, poll } = setup();
    state.keys = { ...step("baseline") };
    delete state.keys["owner.test.near"];
    await poll();
    state.keys = step("owner_function_call_key_added");
    // owner.test.near is seen for the first time: baseline; agent-1 changed: alert.
    expect(texts((await poll()).alerts)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
  });

  it("guardian account (D-10): baseline first, then a new key of either kind alerts with a pause reason", async () => {
    const state: NearRpcState = { keys: step("baseline") };
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    const watch = new NearKeysWatch({ provider, accounts: [...ACCOUNTS, "guardian.test.near"], network: "testnet" });
    const poll = () => withGlobalFetch(nearRpcFetch(state), () => watch.poll());
    expect(await poll()).toEqual({ alerts: [], errors: [], baseline: true });
    expect(watch.snapshot?.accounts["guardian.test.near"]).toEqual([
      expect.objectContaining({ kind: "FunctionCall", receiver_id: "clawguard.test.near", method_names: ["pause"] }),
    ]);
    state.keys = step("guardian_full_access_key_added");
    const full = (await poll()).alerts;
    expect(texts(full)).toEqual(["Public signal: new full-access key on guardian.test.near"]);
    expect(full[0]).toMatchObject({
      account: "guardian.test.near",
      autopauseReason: "watch: new full-access key",
      explorerUrl: "https://testnet.nearblocks.io/address/guardian.test.near",
    });
    state.keys = step("guardian_function_call_key_added");
    const changed = (await poll()).alerts;
    // The full-access key went away and a function-call key arrived.
    expect(texts(changed).sort()).toEqual([
      "Public signal: key removed from guardian.test.near",
      "Public signal: new function-call key on guardian.test.near",
    ]);
    expect(changed.find((a) => a.kind === "near_key_added")?.autopauseReason).toBe("watch: new function-call key");
    expect(changed.find((a) => a.kind === "near_key_removed")?.autopauseReason).toBeUndefined();
    for (const a of [...full, ...changed]) expect(a.text).not.toMatch(BANNED_COPY);
  });

  it("no banned words in any alert", async () => {
    const { poll, goTo } = setup("testnet");
    await poll();
    goTo("contract_key_removed");
    const { alerts } = await poll();
    expect(alerts.length).toBe(3);
    for (const a of alerts) {
      expect(a.text).not.toMatch(BANNED_COPY);
      expect(a.text.startsWith("Public signal: ")).toBe(true);
    }
  });
});

describe("key snapshots", () => {
  const fak = (pk: string): WatchedKey => ({ public_key: pk, kind: "FullAccess" });
  const fc = (pk: string, methods: string[]): WatchedKey => ({
    public_key: pk,
    kind: "FunctionCall",
    receiver_id: "clawguard.test.near",
    method_names: methods,
  });

  it("hash ignores order, changes with content", () => {
    const a = buildKeySnapshot({ "x.test.near": [fak("ed25519:A"), fak("ed25519:B")] }, 1);
    const b = buildKeySnapshot({ "x.test.near": [fak("ed25519:B"), fak("ed25519:A")] }, 2);
    const c = buildKeySnapshot({ "x.test.near": [fak("ed25519:A")] }, 3);
    expect(a.snapshot_sha256).toBe(b.snapshot_sha256);
    expect(a.snapshot_sha256).not.toBe(c.snapshot_sha256);
  });

  it("a key whose permission changed is reported as a new key of its new kind", () => {
    const prev = buildKeySnapshot({ "agent-1.test.near": [fc("ed25519:K", ["propose_order"])] }, 1);
    const next = buildKeySnapshot({ "agent-1.test.near": [fak("ed25519:K")] }, 2);
    expect(texts(diffKeySnapshots(prev, next, "sandbox"))).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
    const widened = buildKeySnapshot({ "agent-1.test.near": [fc("ed25519:K", ["propose_order", "pause"])] }, 2);
    expect(texts(diffKeySnapshots(prev, widened, "sandbox"))).toEqual([
      "Public signal: new function-call key on agent-1.test.near",
    ]);
  });

  it("unknown permission kinds are reported, never ignored", () => {
    const other = toWatchedKey({ publicKey: "ed25519:G", kind: "Other", nonce: "0", permission: { GasKeyFullAccess: { balance: "1" } } });
    const prev = buildKeySnapshot({ "owner.test.near": [] }, 1);
    const next = buildKeySnapshot({ "owner.test.near": [other] }, 2);
    const [alert] = diffKeySnapshots(prev, next, "sandbox");
    expect(alert?.text).toBe("Public signal: new access key of an unrecognised type on owner.test.near");
    expect(alert?.autopauseReason).toBe("watch: new access key");
    // Its balance changing with use is not a new key; a different variant is.
    const used = toWatchedKey({ publicKey: "ed25519:G", kind: "Other", nonce: "9", permission: { GasKeyFullAccess: { balance: "0" } } });
    expect(diffKeySnapshots(next, buildKeySnapshot({ "owner.test.near": [used] }, 3), "sandbox")).toEqual([]);
    const changed = toWatchedKey({ publicKey: "ed25519:G", kind: "Other", nonce: "9", permission: { GasKeyFunctionCall: {} } });
    expect(diffKeySnapshots(next, buildKeySnapshot({ "owner.test.near": [changed] }, 3), "sandbox")).toHaveLength(1);
  });

  it("restoreKeySnapshot accepts its own output and rejects tampering", () => {
    const snap = buildKeySnapshot({ "owner.test.near": [fak("ed25519:A")] }, 5);
    expect(restoreKeySnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    const tampered = JSON.parse(JSON.stringify(snap)) as typeof snap;
    tampered.accounts["owner.test.near"] = [];
    expect(restoreKeySnapshot(tampered)).toBeUndefined();
    expect(restoreKeySnapshot({ accounts: "nope" })).toBeUndefined();
    expect(restoreKeySnapshot(null)).toBeUndefined();
  });

  it("needs at least one account", () => {
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:3030" });
    expect(() => new NearKeysWatch({ provider, accounts: [], network: "sandbox" })).toThrow(/at least one account/);
  });
});
