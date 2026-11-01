// Telegram alert module: the 10 required tests plus timeout, rate limit and
// settings checks, and the builder fee approval alert of owner decision D-09 ("Needs your OK: …",
// alert only, approval stays in the console). The Telegram API is a mocked fetch; nothing leaves
// the machine.
import { readFileSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  type Alert,
  agentPaused,
  agentUnpaused,
  blockedBurst,
  hlApiWalletAdded,
  hlApiWalletRemoved,
  hlBuilderAdded,
  hlBuilderRemoved,
  nearKeyAdded,
  nearKeyRemoved,
  orderBlocked,
} from "../src/watch/alerts.js";
import { HlWatch } from "../src/watch/hl.js";
import { ClawWatch, createClawWatch, reportLines } from "../src/watch/index.js";
import * as telegram from "../src/watch/telegram.js";
import {
  MISSING_SETTINGS_WARNING,
  TELEGRAM_TIMEOUT_MS,
  createTelegramNotifier,
  formatBlockedBatch,
  formatTelegramText,
  telegramSettings,
} from "../src/watch/telegram.js";
import {
  type AccessKeyFixture,
  type HlFixture,
  type NearRpcState,
  hlInfoFetch,
  loadFixture,
  nearRpcFetch,
  requestJson,
  withGlobalFetch,
} from "./fixtures/replay.js";
import { BANNED_COPY } from "./helpers.js";

// A token-shaped fake, assembled at runtime so no bot-token-shaped literal is committed.
const TOKEN = ["8123456780", "AAFakeTokenOnlyForUnitTests_0123456"].join(":");
const CHAT_ID = "424242";
const NOW = 1_793_318_400_000;
const HL_USER = "0x7e57000000000000000000000000000000c1a700";
const BUILDER = "0x1b2d000000000000000000000000000000000b1d";
const NEEDS_YOUR_OK_LINE = `Needs your OK: new builder fee approval ${BUILDER} on your Hyperliquid testnet account. Review it in the console.`;

const env = (overrides: Record<string, string>) =>
  loadConfig({ envFile: false, env: { NEAR_NETWORK: "sandbox", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID, ...overrides } });

interface Sent {
  url: string;
  body: { chat_id: string; text: string; disable_web_page_preview: boolean } & Record<string, unknown>;
  at: number;
  signal: unknown;
}

/** Mocked Telegram API + fake clock. `answer` decides each response (default 200 ok). */
function harness(answer: (n: number) => Response | Promise<Response> = () => okResponse()) {
  let now = NOW;
  const sent: Sent[] = [];
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    sent.push({ url, body: requestJson(init) as Sent["body"], at: now, signal: init?.signal });
    return Promise.resolve(answer(sent.length));
  });
  const sleep = vi.fn((ms: number) => {
    now += ms;
    return Promise.resolve();
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = { fetchImpl, sleep, logger, now: () => now };
  const logged = () => [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].flat().map(String);
  return { sent, fetchImpl, sleep, logger, deps, logged, advance: (ms: number) => (now += ms) };
}

const okResponse = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
const errResponse = (status: number, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: false, error_code: status, ...body }), { status });

const blockedAt = (id: number, message = "Blocked by your rule: market DOGE is not on your list") =>
  orderBlocked(String(id), "agent-1.test.near", message, NOW - 60_000);

/** One alert of every kind the watcher can build. */
const everyAlert = (): Alert[] => [
  nearKeyAdded("agent-1.test.near", "ed25519:K1", "FullAccess", "https://testnet.nearblocks.io/address/agent-1.test.near"),
  nearKeyAdded("owner.test.near", "ed25519:K2", "FunctionCall"),
  nearKeyAdded("owner.test.near", "ed25519:K3", "Other"),
  nearKeyRemoved("clawguard.test.near", "ed25519:K4", "FullAccess"),
  hlApiWalletAdded("0x7e57000000000000000000000000000000c1a700", "0x00000000000000000000000000000000000b0b01"),
  hlApiWalletRemoved("0x7e57000000000000000000000000000000c1a700", "0x00000000000000000000000000000000000b0b01"),
  hlBuilderAdded("0x7e57000000000000000000000000000000c1a700", "0x1b2d000000000000000000000000000000000b1d"),
  hlBuilderRemoved("0x7e57000000000000000000000000000000c1a700", "0x1b2d000000000000000000000000000000000b1d"),
  blockedAt(2),
  orderBlocked("3", "agent-1.test.near", "Blocked by your rule: leverage 50x is above your limit of 3x", NOW),
  blockedBurst(["2", "3", "4"]),
  agentPaused("guardian.test.near", "watch: new full-access key", 1),
  agentPaused(null, null, 2),
  agentUnpaused("owner.test.near", 3),
];

describe("Telegram alerts", () => {
  it("1) flag off -> fetch is never called", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "0" })), h.deps);
    expect(notifier.enabled).toBe(false);
    notifier.notify(everyAlert());
    await notifier.flush();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.logged()).toEqual([]);
    // Default config (no flag at all) is off too.
    expect(createTelegramNotifier(telegramSettings(loadConfig({ envFile: false, env: {} })), h.deps).enabled).toBe(false);
  });

  it("2) flag on, token or chat id missing -> no call, one warning, the watcher carries on", async () => {
    for (const missing of [{ TELEGRAM_BOT_TOKEN: "" }, { TELEGRAM_CHAT_ID: "" }]) {
      const h = harness();
      const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1", ...missing })), h.deps);
      expect(notifier.enabled).toBe(false);
      expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(MISSING_SETTINGS_WARNING);
      notifier.notify(everyAlert());
      await notifier.flush();
      expect(h.fetchImpl).not.toHaveBeenCalled();

      // The watcher keeps polling and reporting with the disabled notifier as its sink.
      const keys = loadFixture<AccessKeyFixture>("near_rpc_access_keys.json").steps;
      const state: NearRpcState = { keys: keys.baseline ?? {} };
      const watch = createClawWatch({
        provider: new JsonRpcProvider({ url: "http://127.0.0.1:3030" }),
        network: "sandbox",
        accounts: ["agent-1.test.near"],
        sinks: [notifier],
      });
      await withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
      state.keys = keys.agent_full_access_key_added ?? {};
      const report = await withGlobalFetch(nearRpcFetch(state), () => watch.pollOnce());
      expect(report.alerts.map((a) => a.text)).toEqual(["Public signal: new full-access key on agent-1.test.near"]);
      expect(h.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("3) each alert kind (a)(b)(c) -> exactly one sendMessage call; body as expected; chat_id from env", async () => {
    const cases: Array<[Alert, string]> = [
      [
        nearKeyAdded("agent-1.example.testnet", "ed25519:K1", "FullAccess", "https://testnet.nearblocks.io/address/agent-1.example.testnet"),
        "Public signal: new full-access key on agent-1.example.testnet\nTestnet only.\nhttps://testnet.nearblocks.io/address/agent-1.example.testnet",
      ],
      [
        nearKeyAdded("owner.test.near", "ed25519:K2", "FunctionCall"),
        "Public signal: new function-call key on owner.test.near\nTestnet only.",
      ],
      [
        hlApiWalletAdded("0x7e57000000000000000000000000000000c1a700", "0x00000000000000000000000000000000000b0b01"),
        "Public signal: new API wallet 0x00000000000000000000000000000000000b0b01 on your Hyperliquid testnet account\nTestnet only.",
      ],
      [blockedAt(12), "Order #12 by agent-1.test.near: Blocked by your rule: market DOGE is not on your list\nTestnet only."],
      [
        agentPaused("guardian.test.near", "watch: new full-access key", 1),
        "Public signal: agent paused by guardian.test.near (watch: new full-access key)\nTestnet only.",
      ],
      [agentUnpaused("owner.test.near", 2), "Public signal: agent unpaused by owner.test.near\nTestnet only."],
    ];
    for (const [alert, text] of cases) {
      const h = harness();
      const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
      notifier.notify([alert]);
      await notifier.flush();
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
      expect(h.sent[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
      expect(h.fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
      // Plain text: exactly these fields, no parse_mode.
      expect(h.sent[0]?.body).toEqual({ chat_id: CHAT_ID, text, disable_web_page_preview: true });
    }
  });

  it("4) a blocked-order message carries the receipt message verbatim, starting 'Blocked by your rule:'", async () => {
    const message = "Blocked by your rule: receiver 0xbadbadbadbadbadbadbadbadbadbadbadbadbad0 is not on your list";
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    notifier.notify([orderBlocked("5", "agent-1.test.near", message, NOW)]);
    await notifier.flush();
    const text = h.sent[0]?.body.text ?? "";
    expect(text.split("\n")[0]).toBe(`Order #5 by agent-1.test.near: ${message}`);
    expect(text).toContain(message);
    expect(text.slice(text.indexOf(": ") + 2).startsWith("Blocked by your rule:")).toBe(true);
  });

  it("5) no formatter output contains a banned word", () => {
    const outputs = [
      ...everyAlert().map(formatTelegramText),
      formatBlockedBatch([blockedAt(1), blockedAt(2), blockedAt(3)], NOW),
      formatBlockedBatch([blockedAt(1), blockedAt(2), blockedAt(3)], NOW + 3_600_000),
      formatBlockedBatch(
        Array.from({ length: 40 }, (_, i) => blockedAt(i + 1)),
        NOW,
      ),
    ];
    for (const text of outputs) {
      expect(text).not.toMatch(BANNED_COPY);
      expect(text).not.toMatch(/\b(safe|scam|malicious)\b/i);
      expect(text.split("\n")).toContain("Testnet only.");
    }
    // The D-09 line is among the outputs checked above.
    expect(outputs.filter((text) => text.startsWith("Needs your OK: "))).toEqual([`${NEEDS_YOUR_OK_LINE}\nTestnet only.`]);
  });

  it("6) the bot token never appears in logs or errors", async () => {
    const answers = [
      () => Promise.reject(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`)),
      () => Promise.reject(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${encodeURIComponent(TOKEN)}/x`)),
      () => errResponse(401, { description: `Unauthorized: token ${TOKEN} is not valid` }),
    ];
    for (const answer of answers) {
      const h = harness(answer);
      const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
      notifier.notify([blockedAt(1)]);
      await expect(notifier.flush()).resolves.toBeUndefined();
      const logs = h.logged().join("\n");
      expect(logs).toMatch(/Telegram alert dropped/);
      expect(logs).not.toContain(TOKEN);
      expect(logs).not.toContain(TOKEN.split(":")[1]);
      expect(logs).not.toContain(encodeURIComponent(TOKEN));
    }
    // The config object itself never prints the token either.
    const config = env({ TELEGRAM_ALERTS_ENABLED: "1" });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(String(config.telegramBotToken)).not.toContain(TOKEN);
    // A malformed token disables the module without echoing it.
    const h = harness();
    const bad = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1", TELEGRAM_BOT_TOKEN: "not/a?token" })), h.deps);
    expect(bad.enabled).toBe(false);
    expect(h.logged().join("\n")).not.toContain("not/a?token");
  });

  it("7) 429 / 500 -> retries with backoff, then drops the message without throwing", async () => {
    for (const status of [429, 500]) {
      const h = harness(() => errResponse(status, { description: status === 429 ? "Too Many Requests: retry after 3" : "Internal" , parameters: status === 429 ? { retry_after: 3 } : undefined }));
      const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
      notifier.notify([blockedAt(1)]);
      await expect(notifier.flush()).resolves.toBeUndefined();
      expect(h.fetchImpl).toHaveBeenCalledTimes(3); // 1 try + 2 retries
      const gaps = h.sent.slice(1).map((s, i) => s.at - (h.sent[i]?.at ?? 0));
      if (status === 429) expect(gaps).toEqual([3000, 4000]); // retry_after honoured, then 2 x backoff
      else expect(gaps).toEqual([2000, 4000]);
      expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`dropped after 3 attempt\\(s\\): HTTP ${status}`)));
    }
    // A permanent error (400) is not retried.
    const h = harness(() => errResponse(400, { description: "Bad Request: chat not found" }));
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    notifier.notify([blockedAt(1)]);
    await notifier.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith("Telegram alert dropped after 1 attempt(s): HTTP 400 (Bad Request: chat not found)");
  });

  it("8) a burst of 5 blocked receipts -> one batched message", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    notifier.notify([1, 2, 3, 4, 5].map((id) => blockedAt(id)));
    await notifier.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.sent[0]?.body.text).toBe(
      [
        "5 orders blocked in the last 10 min:",
        ...[1, 2, 3, 4, 5].map((id) => `Order #${id} by agent-1.test.near: Blocked by your rule: market DOGE is not on your list`),
        "Testnet only.",
      ].join("\n"),
    );
  });

  it("8b) blocked orders without a stored receipt (id 0) are each delivered and still batch", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    const unstored = (where: string) =>
      orderBlocked("0", "agent-1.test.near", "Blocked by your rule: market DOGE is not on your list", NOW - 60_000, where);
    notifier.notify([unstored("tx1:0"), unstored("tx2:0"), unstored("tx3:0"), unstored("tx3:0")]);
    await notifier.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const line = "Order by agent-1.test.near (no receipt stored: contract storage reserve): Blocked by your rule: market DOGE is not on your list";
    expect(h.sent[0]?.body.text).toBe(["3 orders blocked in the last 10 min:", line, line, line, "Testnet only."].join("\n"));
  });

  it("9) a duplicate event -> no second message", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    const alert = nearKeyAdded("agent-1.test.near", "ed25519:K1", "FullAccess");
    notifier.notify([alert, alert]);
    notifier.notify([nearKeyAdded("agent-1.test.near", "ed25519:K1", "FullAccess")]);
    notifier.notify([blockedAt(7)]);
    notifier.notify([blockedAt(7)]);
    await notifier.flush();
    expect(h.sent.map((s) => s.body.text.split("\n")[0])).toEqual([
      "Public signal: new full-access key on agent-1.test.near",
      "Order #7 by agent-1.test.near: Blocked by your rule: market DOGE is not on your list",
    ]);
  });

  it("10) the module holds no keys and calls no chain (static check)", () => {
    const source = readFileSync(new URL("../src/watch/telegram.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "near-api-js",
      "viem",
      "PRIVATE_KEY",
      "@noble",
      "getUpdates",
      "setWebhook",
      "parse_mode",
      // "Needs your OK" is an alert only (D-09): no buttons, no callbacks, nothing to answer.
      "reply_markup",
      "inline_keyboard",
      "callback_query",
      "callback_data",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // sendMessage is the only Telegram method the module calls.
    expect([...source.matchAll(/\/bot\$\{[^}]+\}\/(\w+)/g)].map((m) => m[1])).toEqual(["sendMessage"]);
    const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gms)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../config.js", "./alerts.js"]);
    // What it exports: formatting, settings, a notifier factory. Nothing that signs, pauses or reads replies.
    expect(Object.keys(telegram).sort()).toEqual([
      "BATCH_MIN",
      "MISSING_SETTINGS_WARNING",
      "TELEGRAM_API_BASE",
      "TELEGRAM_BACKOFF_MS",
      "TELEGRAM_MIN_INTERVAL_MS",
      "TELEGRAM_RETRIES",
      "TELEGRAM_TIMEOUT_MS",
      "TESTNET_ONLY",
      "createTelegramNotifier",
      "formatBlockedBatch",
      "formatTelegramText",
      "isForwarded",
      "telegramSettings",
    ]);
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), harness().deps);
    expect(Object.keys(notifier)).not.toContain("pause");
  });
});

describe("Telegram transport details", () => {
  it("only these four alert groups are forwarded: (a)(b)(c) and the D-09 builder fee approval", async () => {
    expect(everyAlert().filter(telegram.isForwarded).map((a) => a.kind)).toEqual([
      "near_key_added",
      "near_key_added",
      "near_key_added",
      "hl_api_wallet_added",
      "hl_builder_added",
      "order_blocked",
      "order_blocked",
      "agent_paused",
      "agent_paused",
      "agent_unpaused",
    ]);
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    notifier.notify([
      nearKeyRemoved("clawguard.test.near", "ed25519:K4", "FullAccess"),
      hlApiWalletRemoved(HL_USER, "0x00000000000000000000000000000000000b0b01"),
      hlBuilderRemoved(HL_USER, BUILDER),
      blockedBurst(["1", "2", "3"]),
    ]);
    await notifier.flush();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("at most one request per 2 s", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    notifier.notify([
      nearKeyAdded("agent-1.test.near", "ed25519:K1", "FullAccess"),
      hlApiWalletAdded("0x7e57000000000000000000000000000000c1a700", "0x00000000000000000000000000000000000b0b01"),
      agentPaused("guardian.test.near", "watch: new full-access key", 1),
    ]);
    await notifier.flush();
    expect(h.sent.map((s) => s.at - NOW)).toEqual([0, 2000, 4000]);
  });

  it("blocked orders queued behind other alerts join one batch; two alone are sent one by one", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h.deps);
    notifier.notify([nearKeyAdded("agent-1.test.near", "ed25519:K1", "FullAccess"), blockedAt(1), blockedAt(2)]);
    notifier.notify([blockedAt(3)]);
    await notifier.flush();
    expect(h.sent.map((s) => s.body.text.split("\n")[0])).toEqual([
      "Public signal: new full-access key on agent-1.test.near",
      "3 orders blocked in the last 10 min:",
    ]);
    const h2 = harness();
    const two = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), h2.deps);
    two.notify([blockedAt(1), blockedAt(2)]);
    await two.flush();
    expect(h2.sent).toHaveLength(2);
  });

  it("a request that does not answer is aborted by the timeout (5 s by default) and retried", async () => {
    expect(TELEGRAM_TIMEOUT_MS).toBe(5000);
    const h = harness();
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
        }),
    );
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1" })), {
      ...h.deps,
      fetchImpl: hanging,
      timeoutMs: 20,
    });
    notifier.notify([blockedAt(1)]);
    await notifier.flush();
    expect(hanging).toHaveBeenCalledTimes(3);
    expect(h.logger.warn).toHaveBeenCalledWith("Telegram alert dropped after 3 attempt(s): no answer within 0.02 s");
  });

  it("a long batch stays within Telegram's 4096-character limit", () => {
    const long = "Blocked by your rule: market " + "X".repeat(250) + " is not on your list";
    const text = formatBlockedBatch(
      Array.from({ length: 60 }, (_, i) => orderBlocked(String(i + 1), "agent-1.test.near", long, NOW)),
      NOW,
    );
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.startsWith("60 orders blocked in the last 10 min:\n")).toBe(true);
    expect(text).toMatch(/\n…and \d+ more\nTestnet only\.$/);
    expect(formatBlockedBatch([blockedAt(1), blockedAt(2), blockedAt(3)], NOW + 3_600_000).split("\n")[0]).toBe("3 orders blocked:");
  });

  it("a chat id that is neither numeric nor @name disables the module", () => {
    const h = harness();
    const notifier = createTelegramNotifier(
      telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "1", TELEGRAM_CHAT_ID: "12 34" })),
      h.deps,
    );
    expect(notifier.enabled).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledWith("Telegram alerts disabled: TELEGRAM_CHAT_ID must be a numeric chat id or @name");
  });
});

describe("builder fee approvals on Telegram (owner decision D-09)", () => {
  const enabled = () => env({ TELEGRAM_ALERTS_ENABLED: "1" });

  it("a new builder fee approval -> exactly one sendMessage, worded 'Needs your OK: …', plain text", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(enabled()), h.deps);
    notifier.notify([hlBuilderAdded(HL_USER, BUILDER)]);
    await notifier.flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.sent[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const text = h.sent[0]?.body.text ?? "";
    expect(text.startsWith("Needs your OK: ")).toBe(true);
    expect(text).toContain(BUILDER);
    // The module's standard ending; Hyperliquid alerts have no explorer link.
    expect(h.sent[0]?.body).toEqual({ chat_id: CHAT_ID, text: `${NEEDS_YOUR_OK_LINE}\nTestnet only.`, disable_web_page_preview: true });
    expect(text).not.toMatch(BANNED_COPY);
  });

  it("the console keeps the 'Public signal: …' wording for the same alert", () => {
    const alert = hlBuilderAdded(HL_USER, BUILDER);
    expect(alert.text).toBe(`Public signal: new builder fee approval for ${BUILDER} on your Hyperliquid testnet account`);
    expect(reportLines({ alerts: [alert], errors: [], baselines: [] })).toEqual([["info", alert.text]]);
    expect(formatTelegramText(alert).split("\n")[0]).toBe(NEEDS_YOUR_OK_LINE);
  });

  it("a duplicate (same kind and builder) -> no second message; another builder -> its own message", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(enabled()), h.deps);
    const alert = hlBuilderAdded(HL_USER, BUILDER);
    notifier.notify([alert, alert]);
    notifier.notify([hlBuilderAdded(HL_USER, BUILDER)]);
    await notifier.flush();
    notifier.notify([hlBuilderAdded(HL_USER, BUILDER.toUpperCase().replace("0X", "0x"))]);
    notifier.notify([hlBuilderAdded(HL_USER, "0x1b2d000000000000000000000000000000000b1e")]);
    await notifier.flush();
    expect(h.sent.map((s) => s.body.text.split("\n")[0])).toEqual([
      NEEDS_YOUR_OK_LINE,
      "Needs your OK: new builder fee approval 0x1b2d000000000000000000000000000000000b1e on your Hyperliquid testnet account. Review it in the console.",
    ]);
  });

  it("a builder removal -> no Telegram message", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(enabled()), h.deps);
    notifier.notify([hlBuilderRemoved(HL_USER, BUILDER)]);
    await notifier.flush();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("flag off -> fetch is never called", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(env({ TELEGRAM_ALERTS_ENABLED: "0" })), h.deps);
    notifier.notify([hlBuilderAdded(HL_USER, BUILDER)]);
    await notifier.flush();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("is never merged into a blocked-order batch; batching of blocked orders is unchanged", async () => {
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(enabled()), h.deps);
    notifier.notify([blockedAt(1), hlBuilderAdded(HL_USER, BUILDER), blockedAt(2), blockedAt(3)]);
    await notifier.flush();
    expect(h.sent.map((s) => s.body.text)).toEqual([
      [
        "3 orders blocked in the last 10 min:",
        ...[1, 2, 3].map((id) => `Order #${id} by agent-1.test.near: Blocked by your rule: market DOGE is not on your list`),
        "Testnet only.",
      ].join("\n"),
      `${NEEDS_YOUR_OK_LINE}\nTestnet only.`,
    ]);
    // Rate limit still applies: one request per 2 s.
    expect(h.sent.map((s) => s.at - NOW)).toEqual([0, 2000]);
  });

  it("end to end: the watcher sees the approval once, Telegram asks once, the removal stays in the console", async () => {
    const hlFixture = loadFixture<HlFixture>("hl_info.json");
    const step = (name: string) => {
      const s = hlFixture.steps[name];
      if (s === undefined) throw new Error(`no fixture step ${name}`);
      return s;
    };
    const hlState = { user: hlFixture.user, step: step("new_api_wallet") };
    const h = harness();
    const notifier = createTelegramNotifier(telegramSettings(enabled()), h.deps);
    const watch = new ClawWatch({
      hl: new HlWatch({ apiUrl: "https://api.hyperliquid-testnet.xyz", user: hlFixture.user, fetchImpl: hlInfoFetch(hlState) }),
      sinks: [notifier],
    });
    expect((await watch.pollOnce()).baselines).toEqual(["hl"]);
    hlState.step = step("builder_approved");
    const approved = await watch.pollOnce();
    expect(reportLines(approved)).toEqual([
      ["info", `Public signal: new builder fee approval for ${BUILDER} on your Hyperliquid testnet account`],
    ]);
    await watch.pollOnce(); // unchanged: nothing new
    hlState.step = step("new_api_wallet"); // the approval is gone again
    const removed = await watch.pollOnce();
    expect(reportLines(removed)).toEqual([
      ["info", `Public signal: builder fee approval for ${BUILDER} removed from your Hyperliquid testnet account`],
    ]);
    hlState.step = step("builder_approved"); // re-approved: the same (kind, builder), not asked again
    expect((await watch.pollOnce()).alerts.map((a) => a.kind)).toEqual(["hl_builder_added"]);
    await watch.flush();
    expect(h.sent.map((s) => s.body.text)).toEqual([`${NEEDS_YOUR_OK_LINE}\nTestnet only.`]);
  });
});
