// Pure formatters for receipts and decisions (no I/O), used by the receipts CLI and the agent.
// Every printed line goes through escapeUnprintable: receipts carry agent-supplied text (blocked
// proposals) and owner/guardian text (pause reasons), and none of it may steer the terminal.
import { type RuleNames, describeReceipt, escapeUnprintable } from "./decode.js";
import type { Decision, Receipt } from "./types.js";

/** The owner's rules per agent id (from get_rules), used to name signed assets and tokens. */
export type RuleNamesByAgent = ReadonlyMap<string, RuleNames>;

/** 0x1234abcd…ef01: enough to match by eye; full values are in --json output. */
export function shortHex(hex: string, head = 10, tail = 4): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** Printed instead of "#0": a blocked order whose receipt the contract did not store (it kept its storage reserve). */
export const NO_RECEIPT_STORED = "no receipt stored (contract storage reserve)";

/** "#12", or NO_RECEIPT_STORED for receipt id "0" (ids start at 1). */
export function receiptLabel(receiptId: string): string {
  return receiptId === "0" ? NO_RECEIPT_STORED : `#${receiptId}`;
}

/** One line per decision, e.g. "#12 Allowed: within your limits sig=0x9db86c17…8d61". */
export function formatDecisionLine(decision: Decision): string {
  const sig = decision.signature === null ? "" : ` sig=${shortHex(decision.signature.r)}`;
  return escapeUnprintable(`${receiptLabel(decision.receipt_id)} ${decision.message}${sig}`);
}

const COLUMNS = ["ID", "STATUS", "TARGET", "AGENT", "DECISION"] as const;
const INDENT = "      ";

/**
 * Fixed-width receipts table. Each receipt is one row with the decision message
 * verbatim (control characters escaped), followed by indented "what is being
 * signed" lines and, for signed receipts, the abbreviated payload hash and signature.
 */
export function formatReceiptsTable(receipts: readonly Receipt[], names?: RuleNamesByAgent): string {
  if (receipts.length === 0) return "No receipts yet.";
  const rows = receipts.map((r) => [`#${r.id}`, r.status, r.target, r.agent_id, r.message].map(escapeUnprintable));
  const widths = COLUMNS.map((title, i) =>
    i === COLUMNS.length - 1 ? 0 : Math.max(title.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ");

  const out = [line(COLUMNS)];
  receipts.forEach((receipt, i) => {
    out.push(line(rows[i] ?? []));
    for (const text of describeReceipt(receipt, names?.get(receipt.agent_id))) out.push(`${INDENT}${escapeUnprintable(text)}`);
    if (receipt.payload_hash !== null) {
      const sig = receipt.signature === null ? "no signature" : `sig r=${shortHex(receipt.signature.r)} v=${receipt.signature.v}`;
      out.push(`${INDENT}payload ${shortHex(receipt.payload_hash)}  ${sig}`);
    }
  });
  return out.join("\n");
}

/** --json output: the receipts as returned by the contract plus the decoded lines. */
export function formatReceiptsJson(receipts: readonly Receipt[], names?: RuleNamesByAgent): string {
  return JSON.stringify(
    receipts.map((r) => ({ ...r, what_is_signed: describeReceipt(r, names?.get(r.agent_id)) })),
    null,
    2,
  );
}
