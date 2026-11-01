// Optional Telegram alerts through the owner's own bot (TELEGRAM_BOT_TOKEN).
//
// Alerts only. This module takes alert objects the watcher already built, formats them as plain
// text and POSTs them to the owner's own chat with sendMessage. It holds no NEAR or EVM keys and
// imports no chain library; it never reads replies (no update polling, no webhook), so nothing
// sent to the bot can sign, move funds, change rules, pause, unpause or approve anything.
//
// Off unless TELEGRAM_ALERTS_ENABLED=1 and both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set
// (missing values: one warning, then the watcher carries on without it). Forwarded: new access
// key / API wallet, blocked order, pause / unpause, and (owner decision D-09) a new builder fee
// approval, worded "Needs your OK: …". That message only asks the owner to look: reviewing and
// approving stays in the console, and a reply to the bot does nothing because none is read.
// Each request has a 5 s timeout and up to 2 retries with backoff, then the message is dropped
// and logged; at most one request per 2 s; queued blocked orders are batched into one message
// (no other alert ever joins that batch); an alert is sent at most once (dedupe by kind and
// receipt id / key, by kind and builder for builder approvals). The bot token never appears in
// a log line or error.
import { type Config, type FetchLike, REDACTED, type Secret, log, redact, registerSecret } from "../config.js";
import { type Alert, type AlertOf, type Logger, BURST_WINDOW_MS, needsYourOkText, oneLine } from "./alerts.js";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TESTNET_ONLY = "Testnet only.";
export const MISSING_SETTINGS_WARNING = "Telegram alerts disabled: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID";
export const TELEGRAM_TIMEOUT_MS = 5_000;
export const TELEGRAM_RETRIES = 2;
export const TELEGRAM_MIN_INTERVAL_MS = 2_000;
export const TELEGRAM_BACKOFF_MS = 2_000;
/** This many queued blocked-order alerts are sent as one message. */
export const BATCH_MIN = 3;

/** Telegram's sendMessage text limit. */
const MAX_TEXT_CHARS = 4096;
const MAX_BATCH_LINES = 15;
const DEDUPE_MEMORY = 1000;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Only these five alert groups are forwarded: (a) new key / API wallet, (b) blocked order,
 * (c) pause / unpause, plus (d) new builder fee approval (owner decision D-09) and (e) the contract
 * storage reserve close or reached (D-20: blocked orders past it have no receipt and no order
 * alert). Removals of keys, API wallets and builder approvals, the blocked-burst summary and
 * "storage reserve back to normal" stay console-only.
 */
const FORWARDED_KINDS: ReadonlySet<Alert["kind"]> = new Set([
  "near_key_added",
  "hl_api_wallet_added",
  "order_blocked",
  "agent_paused",
  "agent_unpaused",
  "hl_builder_added",
  "storage_reserve_low",
  "storage_reserve_reached",
]);

export function isForwarded(alert: Alert): boolean {
  return FORWARDED_KINDS.has(alert.kind);
}

type BlockedAlert = AlertOf<"order_blocked">;
const isBlocked = (alert: Alert): alert is BlockedAlert => alert.kind === "order_blocked";

/** Dedupe key: (kind, receipt id | key) as built in alerts.ts; (kind, builder) for a builder approval. */
function dedupeKey(alert: Alert): string {
  return alert.kind === "hl_builder_added" ? `${alert.kind}:${alert.builder.toLowerCase()}` : alert.key;
}

// ---------------------------------------------------------------------------
// Formatting (plain text; the wording itself comes from alerts.ts)
// ---------------------------------------------------------------------------

/**
 * One alert: its line, then `Testnet only.`, then the testnet explorer link if there is one. The
 * line is the alert text, except for a new builder fee approval: `Needs your OK: …` (D-09).
 */
export function formatTelegramText(alert: Alert): string {
  const lines = [alert.kind === "hl_builder_added" ? needsYourOkText(alert) : alert.text, TESTNET_ONLY];
  if (alert.explorerUrl !== undefined) lines.push(alert.explorerUrl);
  return lines.join("\n");
}

/** `N orders blocked in the last 10 min:` then one `Order #… by …: Blocked by your rule: …` line each. */
export function formatBlockedBatch(alerts: readonly BlockedAlert[], nowMs: number): string {
  const n = alerts.length;
  const oldest = alerts.reduce((min, a) => Math.min(min, a.timestampMs), Number.POSITIVE_INFINITY);
  const header = nowMs - oldest <= BURST_WINDOW_MS ? `${n} orders blocked in the last 10 min:` : `${n} orders blocked:`;
  for (let shown = Math.min(n, MAX_BATCH_LINES); ; shown -= 1) {
    const lines = [header, ...alerts.slice(0, shown).map((a) => a.text)];
    if (shown < n) lines.push(`…and ${n - shown} more`);
    lines.push(TESTNET_ONLY);
    const text = lines.join("\n");
    if (text.length <= MAX_TEXT_CHARS || shown <= 1) return text;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TelegramSettings {
  enabled: boolean;
  botToken?: Secret | undefined;
  chatId?: string | undefined;
}

export function telegramSettings(
  config: Pick<Config, "telegramAlertsEnabled" | "telegramBotToken" | "telegramChatId">,
): TelegramSettings {
  return { enabled: config.telegramAlertsEnabled, botToken: config.telegramBotToken, chatId: config.telegramChatId };
}

export interface TelegramDeps {
  fetchImpl?: FetchLike;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  backoffMs?: number;
}

/** What the watcher sees: queue alerts, wait for delivery. Neither ever throws. */
export interface TelegramNotifier {
  readonly enabled: boolean;
  notify(alerts: readonly Alert[]): void;
  flush(): Promise<void>;
}

const BOT_TOKEN_SHAPE = /^\d{5,16}:[A-Za-z0-9_-]{20,64}$/;
const CHAT_ID_SHAPE = /^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/;

const DISABLED: TelegramNotifier = Object.freeze({
  enabled: false,
  notify: (): void => undefined,
  flush: (): Promise<void> => Promise.resolve(),
});

/**
 * The notifier for these settings, or a disabled one (flag off: silent; flag on but settings
 * missing or malformed: one warning). Never throws, so a bad setting cannot stop the watcher.
 */
export function createTelegramNotifier(settings: TelegramSettings, deps: TelegramDeps = {}): TelegramNotifier {
  if (!settings.enabled) return DISABLED;
  const logger = deps.logger ?? log;
  const token = settings.botToken?.reveal();
  const chatId = settings.chatId?.trim();
  if (token === undefined || token === "" || chatId === undefined || chatId === "") {
    logger.warn(MISSING_SETTINGS_WARNING);
    return DISABLED;
  }
  registerSecret(token);
  if (!BOT_TOKEN_SHAPE.test(token)) {
    logger.warn("Telegram alerts disabled: TELEGRAM_BOT_TOKEN does not look like a bot token");
    return DISABLED;
  }
  if (!CHAT_ID_SHAPE.test(chatId)) {
    logger.warn("Telegram alerts disabled: TELEGRAM_CHAT_ID must be a numeric chat id or @name");
    return DISABLED;
  }
  return new Sender(token, chatId, { ...deps, logger });
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class Sender implements TelegramNotifier {
  readonly enabled = true;
  readonly #token: string;
  readonly #chatId: string;
  readonly #fetch: FetchLike;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #minIntervalMs: number;
  readonly #backoffMs: number;
  #queue: Alert[] = [];
  readonly #seen = new Set<string>();
  #draining: Promise<void> | undefined;
  #lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(token: string, chatId: string, deps: TelegramDeps & { logger: Logger }) {
    this.#token = token;
    this.#chatId = chatId;
    this.#fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#logger = deps.logger;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? realSleep;
    this.#timeoutMs = deps.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
    this.#retries = deps.retries ?? TELEGRAM_RETRIES;
    this.#minIntervalMs = deps.minIntervalMs ?? TELEGRAM_MIN_INTERVAL_MS;
    this.#backoffMs = deps.backoffMs ?? TELEGRAM_BACKOFF_MS;
  }

  notify(alerts: readonly Alert[]): void {
    for (const alert of alerts) {
      if (!isForwarded(alert)) continue;
      const key = dedupeKey(alert);
      if (this.#seen.has(key)) continue;
      this.#remember(key);
      this.#queue.push(alert);
    }
    this.#kick();
  }

  async flush(): Promise<void> {
    while (this.#draining !== undefined) await this.#draining;
  }

  #remember(key: string): void {
    this.#seen.add(key);
    if (this.#seen.size > DEDUPE_MEMORY) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
  }

  #kick(): void {
    if (this.#draining !== undefined || this.#queue.length === 0) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = undefined;
      this.#kick();
    });
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        // Wait first, so blocked orders that arrive meanwhile join the same batch.
        await this.#respectRateLimit();
        await this.#send(this.#nextText());
      }
    } catch (err) {
      this.#queue = [];
      this.#logger.error(this.#scrub(`Telegram alerts: unexpected error, queue dropped: ${errorText(err)}`));
    }
  }

  /** Next message: all queued blocked orders as one batch when there are enough, else the head alert. */
  #nextText(): string {
    const head = this.#queue[0] as Alert;
    const blocked = this.#queue.filter(isBlocked);
    if (head.kind === "order_blocked" && blocked.length >= BATCH_MIN) {
      this.#queue = this.#queue.filter((a) => !isBlocked(a));
      return formatBlockedBatch(blocked, this.#now());
    }
    this.#queue.shift();
    return formatTelegramText(head);
  }

  async #respectRateLimit(): Promise<void> {
    const wait = this.#lastRequestAt + this.#minIntervalMs - this.#now();
    if (wait > 0) await this.#sleep(wait);
  }

  /** POST sendMessage with retries. Never throws; a message that cannot be delivered is dropped and logged. */
  async #send(text: string): Promise<void> {
    const url = `${TELEGRAM_API_BASE}/bot${this.#token}/sendMessage`;
    const body = JSON.stringify({ chat_id: this.#chatId, text, disable_web_page_preview: true });
    let problem = "no attempt made";
    let retryAfterMs = 0;
    let attempts = 0;
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (attempt > 0) await this.#sleep(Math.max(this.#backoffMs * attempt, retryAfterMs));
      await this.#respectRateLimit();
      this.#lastRequestAt = this.#now();
      attempts += 1;
      try {
        const res = await this.#fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (res.ok) return;
        const failure = await readFailure(res);
        problem = `HTTP ${res.status}${failure.description === undefined ? "" : ` (${failure.description})`}`;
        if (!isRetryable(res.status)) break;
        retryAfterMs = failure.retryAfterMs;
      } catch (err) {
        problem = isTimeout(err) ? `no answer within ${this.#timeoutMs / 1000} s` : errorText(err);
        retryAfterMs = 0;
      }
    }
    this.#logger.warn(this.#scrub(`Telegram alert dropped after ${attempts} attempt(s): ${problem}`));
  }

  /** Remove the bot token (raw and URL-encoded) and anything else secret-shaped. */
  #scrub(text: string): string {
    let out = text;
    for (const form of new Set([this.#token, encodeURIComponent(this.#token)])) out = out.split(form).join(REDACTED);
    return redact(out);
  }
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function errorText(err: unknown): string {
  return oneLine(err instanceof Error ? `${err.name}: ${err.message}` : String(err), 300);
}

/** Telegram error body: {ok:false, description, parameters:{retry_after}}. Tolerates anything. */
async function readFailure(res: Response): Promise<{ description?: string; retryAfterMs: number }> {
  try {
    const body = (await res.json()) as { description?: unknown; parameters?: { retry_after?: unknown } };
    const retryAfter = body.parameters?.retry_after;
    const retryAfterMs =
      typeof retryAfter === "number" && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : 0;
    return typeof body.description === "string"
      ? { description: oneLine(body.description, 200), retryAfterMs }
      : { retryAfterMs };
  } catch {
    return { retryAfterMs: 0 };
  }
}
