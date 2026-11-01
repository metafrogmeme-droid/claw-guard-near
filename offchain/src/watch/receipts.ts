// Claw Watch source: new Blocked receipts, bursts of them, and pause / unpause.
//
// Each poll reads get_status, then every receipt created since the last poll (ascending, pages of
// 50). Each new Blocked receipt is an alert with the receipt message verbatim. When at least
// BURST_THRESHOLD blocked receipts fall within BURST_WINDOW_MS (block time), one burst alert is
// raised, then none for the next window. Pause state comes from get_status and, when the caller
// has them (e.g. the guardian's own pause transaction), from the contract's paused / unpaused
// events, which also say who paused. The first poll is a baseline: no alerts.
import { MAX_RECEIPTS_HELD, MAX_RECEIPTS_PAGE } from "../near.js";
import type { ClawGuardEvent, GuardStatus, Receipt } from "../types.js";
import {
  type Alert,
  BURST_THRESHOLD,
  BURST_WINDOW_MS,
  type SourceResult,
  agentPaused,
  agentUnpaused,
  blockedBurst,
  orderBlocked,
} from "./alerts.js";

/** The contract calls this source needs (ClawGuardClient satisfies it). */
export interface ReceiptsReader {
  readonly contractId: string;
  getStatus(): Promise<GuardStatus>;
  getReceipts(fromId: number, limit: number): Promise<Receipt[]>;
}

export interface ReceiptsState {
  contract_id: string;
  /** Highest receipt id already looked at. */
  last_seen_id: number;
  paused: boolean;
  pause_reason: string | null;
  /** Counts pause transitions, so every pause / unpause alert has its own dedupe key. */
  pause_seq: number;
  /** Recent blocked receipts as [id, block time ms], oldest first, pruned to the burst window. */
  recent_blocked: Array<[string, number]>;
  /** Block time (ms) of the receipt that raised the last burst alert. */
  last_burst_ms: number | null;
}

export interface ReceiptsWatchOptions {
  reader: ReceiptsReader;
  burstThreshold?: number;
  burstWindowMs?: number;
  baseline?: ReceiptsState;
}

/** Nanosecond U64 string -> ms number. */
function nsToMs(ns: string): number {
  return Number(BigInt(ns) / 1_000_000n);
}

export class ReceiptsWatch {
  readonly name = "receipts";
  readonly #reader: ReceiptsReader;
  readonly #threshold: number;
  readonly #windowMs: number;
  #state: ReceiptsState | undefined;

  constructor({ reader, burstThreshold = BURST_THRESHOLD, burstWindowMs = BURST_WINDOW_MS, baseline }: ReceiptsWatchOptions) {
    this.#reader = reader;
    this.#threshold = burstThreshold;
    this.#windowMs = burstWindowMs;
    this.#state = baseline?.contract_id === reader.contractId ? structuredClone(baseline) : undefined;
  }

  /** Current state (for persistence). */
  get state(): ReceiptsState | undefined {
    return this.#state === undefined ? undefined : structuredClone(this.#state);
  }

  /** Last known pause state; undefined before the first poll. */
  get paused(): boolean | undefined {
    return this.#state?.paused;
  }

  async poll(): Promise<SourceResult> {
    const status = await this.#reader.getStatus();
    const count = status.receipts_count;
    const state = this.#state;
    if (state === undefined || count < state.last_seen_id) {
      const errors =
        state === undefined ? [] : [`receipt count went down from ${state.last_seen_id} to ${count} (new contract?): new baseline`];
      this.#state = {
        contract_id: this.#reader.contractId,
        last_seen_id: count,
        paused: status.paused,
        pause_reason: status.pause_reason,
        pause_seq: state?.pause_seq ?? 0,
        recent_blocked: [],
        last_burst_ms: null,
      };
      return { alerts: [], errors, baseline: true };
    }

    const alerts: Alert[] = [];
    const errors: string[] = [];
    await this.#readNewReceipts(state, count, alerts, errors);
    const pause = this.#applyPause(state, status.paused, status.pause_reason, null);
    if (pause !== undefined) alerts.push(pause);
    return { alerts, errors, baseline: false };
  }

  /**
   * Feed contract events seen in a transaction (only those emitted by the claw-guard contract;
   * near.ts callFunction already filters by executor). Returns alerts for pause changes.
   */
  observeEvents(events: readonly ClawGuardEvent[]): Alert[] {
    const state = this.#state;
    if (state === undefined) return [];
    const alerts: Alert[] = [];
    for (const event of events) {
      const data = event.data[0] ?? {};
      const by = typeof data.by === "string" ? data.by : null;
      const reason = typeof data.reason === "string" ? data.reason : null;
      const alert =
        event.event === "paused"
          ? this.#applyPause(state, true, reason, by)
          : event.event === "unpaused"
            ? this.#applyPause(state, false, null, by)
            : undefined;
      if (alert !== undefined) alerts.push(alert);
    }
    return alerts;
  }

  /**
   * Alerts for receipts (last_seen_id, count]. A failed page read is reported as an error and
   * keeps what was read so far; the next poll continues after the last page that was read.
   */
  async #readNewReceipts(state: ReceiptsState, count: number, alerts: Alert[], errors: string[]): Promise<void> {
    let from = state.last_seen_id + 1;
    const oldestHeld = Math.max(1, count - MAX_RECEIPTS_HELD + 1);
    if (from < oldestHeld) {
      errors.push(`${oldestHeld - from} receipts left the contract's ring buffer before they were read`);
      from = oldestHeld;
    }
    const newBlocked: Receipt[] = [];
    try {
      while (from <= count) {
        const page = await this.#reader.getReceipts(from, MAX_RECEIPTS_PAGE);
        const last = page[page.length - 1];
        if (last === undefined || Number(last.id) < from) break;
        for (const receipt of page) {
          if (receipt.status !== "Blocked") continue;
          newBlocked.push(receipt);
          alerts.push(orderBlocked(receipt.id, receipt.agent_id, receipt.message, nsToMs(receipt.timestamp_ns)));
        }
        state.last_seen_id = Number(last.id);
        from = state.last_seen_id + 1;
      }
      // Ids that never showed up (should not happen) are not retried forever.
      state.last_seen_id = Math.max(state.last_seen_id, count);
    } catch (err) {
      errors.push(`cannot read receipts after #${state.last_seen_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const burst = this.#trackBurst(state, newBlocked);
    if (burst !== undefined) alerts.push(burst);
  }

  #trackBurst(state: ReceiptsState, newBlocked: readonly Receipt[]): Alert | undefined {
    if (newBlocked.length === 0) return undefined;
    for (const r of newBlocked) state.recent_blocked.push([r.id, nsToMs(r.timestamp_ns)]);
    state.recent_blocked.sort((a, b) => a[1] - b[1]);
    const newest = state.recent_blocked[state.recent_blocked.length - 1]?.[1] ?? 0;
    state.recent_blocked = state.recent_blocked.filter(([, ms]) => ms > newest - this.#windowMs);
    const cooledDown = state.last_burst_ms === null || newest - state.last_burst_ms >= this.#windowMs;
    if (state.recent_blocked.length < this.#threshold || !cooledDown) return undefined;
    state.last_burst_ms = newest;
    return blockedBurst(state.recent_blocked.map(([id]) => id));
  }

  /** Alert on a pause / unpause transition, or when a pause gets a new reason. */
  #applyPause(state: ReceiptsState, paused: boolean, reason: string | null, by: string | null): Alert | undefined {
    const changed = paused ? !state.paused || state.pause_reason !== reason : state.paused;
    state.paused = paused;
    state.pause_reason = paused ? reason : null;
    if (!changed) return undefined;
    state.pause_seq += 1;
    return paused ? agentPaused(by, reason, state.pause_seq) : agentUnpaused(by, state.pause_seq);
  }
}

/** Check a stored state before trusting it as a baseline. */
export function restoreReceiptsState(x: unknown): ReceiptsState | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const s = x as Partial<ReceiptsState>;
  const okInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (typeof s.contract_id !== "string" || !okInt(s.last_seen_id) || typeof s.paused !== "boolean") return undefined;
  if (s.pause_reason !== null && typeof s.pause_reason !== "string") return undefined;
  if (!okInt(s.pause_seq) || (s.last_burst_ms !== null && !okInt(s.last_burst_ms))) return undefined;
  if (!Array.isArray(s.recent_blocked)) return undefined;
  const recent = s.recent_blocked as unknown[];
  if (!recent.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && okInt(e[1]))) return undefined;
  return {
    contract_id: s.contract_id,
    last_seen_id: s.last_seen_id,
    paused: s.paused,
    pause_reason: s.pause_reason ?? null,
    pause_seq: s.pause_seq,
    recent_blocked: recent as Array<[string, number]>,
    last_burst_ms: s.last_burst_ms ?? null,
  };
}
