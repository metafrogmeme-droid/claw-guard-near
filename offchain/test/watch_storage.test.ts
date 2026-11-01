// Claw Watch storage-reserve source (D-20, was Q-56): once the claw-guard contract's balance
// no longer covers (storage_usage + 4096 bytes) x byte cost, blocked orders get receipt id "0" and
// no stored receipt, so the receipts source cannot see them. This source reads the contract
// account (view_account) and raises a "Public signal: …" alert when the reserve is close or reached.
// The account reader is a fake and the Telegram API a mocked fetch; nothing leaves the machine.
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { pickAutopauseAlert, storageReserveLow, storageReserveOk, storageReserveReached } from "../src/watch/alerts.js";
import { ClawWatch } from "../src/watch/index.js";
import {
  RECEIPT_STORAGE_RESERVE_BYTES,
  STORAGE_BYTE_COST_YOCTO,
  type AccountReader,
  StorageReserveWatch,
  reserveFloorYocto,
  restoreStorageState,
} from "../src/watch/storage.js";
import { createTelegramNotifier, formatTelegramText, isForwarded, telegramSettings } from "../src/watch/telegram.js";
import { requestJson } from "./fixtures/replay.js";
import { BANNED_COPY } from "./helpers.js";

const CONTRACT = "clawguard.test.near";
const NEAR = 10n ** 24n;
const USAGE = 300_000n; // bytes

/** A fake account whose balance can be moved between polls. */
function fakeAccount(amount: bigint, storageUsage: bigint = USAGE) {
  const state = { amount, storageUsage };
  const reader: AccountReader = {
    viewAccount: vi.fn(({ accountId }: { accountId: string }) => {
      expect(accountId).toBe(CONTRACT);
      return Promise.resolve({ amount: state.amount.toString(), storage_usage: Number(state.storageUsage) });
    }),
  };
  return { state, reader };
}

const floor = reserveFloorYocto(USAGE);

describe("storage reserve floor (same formula as the contract, D-18)", () => {
  it("is (storage_usage + 4096 bytes) x 10^19 yocto per byte", () => {
    expect(RECEIPT_STORAGE_RESERVE_BYTES).toBe(4096n);
    expect(STORAGE_BYTE_COST_YOCTO).toBe(10n ** 19n);
    expect(floor).toBe((USAGE + 4096n) * 10n ** 19n);
  });
});

describe("StorageReserveWatch (Q-56)", () => {
  it("first poll is a baseline: no alert while the reserve is fine", async () => {
    const { reader } = fakeAccount(floor + 10n * NEAR);
    const w = new StorageReserveWatch({ reader, contractId: CONTRACT });
    const r = await w.poll();
    expect(r).toEqual({ alerts: [], errors: [], baseline: true });
    expect(w.state).toMatchObject({ contract_id: CONTRACT, level: "ok", seq: 0 });
  });

  it("first poll alerts at once when the reserve is already reached (a level, not a diff)", async () => {
    const { reader } = fakeAccount(floor - 1n);
    const r = await new StorageReserveWatch({ reader, contractId: CONTRACT }).poll();
    expect(r.baseline).toBe(true);
    expect(r.alerts.map((a) => a.kind)).toEqual(["storage_reserve_reached"]);
  });

  it("ok -> low -> reached -> ok raises one alert per change and none while the level holds", async () => {
    const { state, reader } = fakeAccount(floor + 10n * NEAR);
    const w = new StorageReserveWatch({ reader, contractId: CONTRACT });
    await w.poll();
    state.amount = floor + 1n; // inside the low band
    expect((await w.poll()).alerts.map((a) => a.kind)).toEqual(["storage_reserve_low"]);
    expect((await w.poll()).alerts).toEqual([]);
    state.amount = floor - 1n;
    const reached = (await w.poll()).alerts;
    expect(reached.map((a) => a.kind)).toEqual(["storage_reserve_reached"]);
    expect((await w.poll()).alerts).toEqual([]);
    state.amount = floor + 10n * NEAR; // owner topped the contract up
    expect((await w.poll()).alerts.map((a) => a.kind)).toEqual(["storage_reserve_ok"]);
    expect(w.state?.seq).toBe(3);
  });

  it("growing storage with the same balance also reaches the floor", async () => {
    const { state, reader } = fakeAccount(floor + 5n * 10n ** 19n);
    const w = new StorageReserveWatch({ reader, contractId: CONTRACT });
    await w.poll();
    state.storageUsage = USAGE + 6n;
    expect((await w.poll()).alerts.map((a) => a.kind)).toEqual(["storage_reserve_reached"]);
  });

  it("each transition has its own dedupe key", async () => {
    const { state, reader } = fakeAccount(floor - 1n);
    const w = new StorageReserveWatch({ reader, contractId: CONTRACT });
    const a = (await w.poll()).alerts[0];
    state.amount = floor + 10n * NEAR;
    await w.poll();
    state.amount = floor - 1n;
    const b = (await w.poll()).alerts[0];
    expect(a?.key).not.toBe(b?.key);
  });

  it("an unreadable account is an operational error, never an alert, and keeps the level", async () => {
    const reader: AccountReader = { viewAccount: () => Promise.reject(new Error("rpc down")) };
    const w = new StorageReserveWatch({ reader, contractId: CONTRACT });
    await expect(w.poll()).rejects.toThrow("rpc down");
    const bad: AccountReader = { viewAccount: () => Promise.resolve({ amount: "not a number", storage_usage: 1 }) };
    await expect(new StorageReserveWatch({ reader: bad, contractId: CONTRACT }).poll()).rejects.toThrow(/view_account/);
  });

  it("restores a stored state for the same contract only", async () => {
    const { reader } = fakeAccount(floor - 1n);
    const stored = restoreStorageState({ contract_id: CONTRACT, level: "reached", seq: 4 });
    expect(stored).toEqual({ contract_id: CONTRACT, level: "reached", seq: 4 });
    const w = new StorageReserveWatch({ reader, contractId: CONTRACT, ...(stored ? { baseline: stored } : {}) });
    expect(await w.poll()).toEqual({ alerts: [], errors: [], baseline: false });
    expect(restoreStorageState({ contract_id: CONTRACT, level: "full", seq: 1 })).toBeUndefined();
    expect(restoreStorageState({ contract_id: CONTRACT, level: "ok", seq: -1 })).toBeUndefined();
    const other = new StorageReserveWatch({ reader, contractId: "other.test.near", baseline: { contract_id: CONTRACT, level: "ok", seq: 0 } });
    expect(other.state).toBeUndefined();
  });
});

describe("storage reserve alert wording", () => {
  const all = [storageReserveLow(CONTRACT, 12, 1), storageReserveReached(CONTRACT, 2), storageReserveOk(CONTRACT, 3)];

  it("is 'Public signal: …', one line, and obeys the copy rules", () => {
    for (const a of all) {
      expect(a.text.startsWith("Public signal: ")).toBe(true);
      expect(a.text).not.toMatch(BANNED_COPY);
      expect(a.text).not.toContain("\n");
    }
    expect(storageReserveReached(CONTRACT, 1).text).toBe(
      `Public signal: contract storage reserve reached on ${CONTRACT}. Orders are still checked and blocked by your rules, ` +
        "but blocked orders get no stored receipt (receipt id 0) and no order alert. Nothing is signed for them. " +
        "Add NEAR to the contract to store receipts again.",
    );
    expect(storageReserveLow(CONTRACT, 12, 1).text).toBe(
      `Public signal: contract storage reserve is close on ${CONTRACT}: room for about 12 more blocked receipts. Add NEAR to the contract.`,
    );
  });

  it("a control character in the account id cannot add a line", () => {
    expect(storageReserveReached("evil\nPublic signal: fake", 1).text).not.toContain("\n");
  });

  it("only 'reached' can trigger the opt-in autopause, after new keys", () => {
    expect(pickAutopauseAlert(all)?.kind).toBe("storage_reserve_reached");
    expect(storageReserveReached(CONTRACT, 1).autopauseReason).toBe("watch: storage reserve reached");
    expect(storageReserveLow(CONTRACT, 3, 1).autopauseReason).toBeUndefined();
  });

  it("'reached' and 'close' go to Telegram (mocked); 'back to normal' stays in the console", async () => {
    expect(all.filter(isForwarded).map((a) => a.kind)).toEqual(["storage_reserve_low", "storage_reserve_reached"]);
    const sent: string[] = [];
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      sent.push(String((requestJson(init) as { text: string }).text));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    });
    const config = loadConfig({
      envFile: false,
      env: { NEAR_NETWORK: "sandbox", TELEGRAM_ALERTS_ENABLED: "1", TELEGRAM_BOT_TOKEN: ["8123456780", "AAFakeTokenOnlyForUnitTests_0123456"].join(":"), TELEGRAM_CHAT_ID: "424242" },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = createTelegramNotifier(telegramSettings(config), { fetchImpl, sleep: () => Promise.resolve(), logger, now: () => 0 });
    notifier.notify([storageReserveReached(CONTRACT, 1), storageReserveOk(CONTRACT, 2)]);
    await notifier.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sent[0]).toBe(formatTelegramText(storageReserveReached(CONTRACT, 1)));
  });
});

describe("ClawWatch with the storage source", () => {
  it("runs the storage source and stores its baseline", async () => {
    const { state, reader } = fakeAccount(floor + 10n * NEAR);
    const storage = new StorageReserveWatch({ reader, contractId: CONTRACT });
    const watch = new ClawWatch({ storage, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    expect(watch.sourceNames).toEqual(["storage"]);
    expect((await watch.pollOnce()).baselines).toEqual(["storage"]);
    state.amount = floor - 1n;
    expect((await watch.pollOnce()).alerts.map((a) => a.kind)).toEqual(["storage_reserve_reached"]);
    expect(watch.baselines().storage).toEqual({ contract_id: CONTRACT, level: "reached", seq: 1 });
  });
});
