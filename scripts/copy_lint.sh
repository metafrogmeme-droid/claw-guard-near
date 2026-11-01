#!/usr/bin/env bash
# Copy lint: fail if user-facing text uses a banned
# verdict or token-sale word. Decisions must read "Blocked by your rule: …" / "Allowed: within
# your limits" and watcher alerts "Public signal: …", never a verdict on an address or order.
#
# Usage: scripts/copy_lint.sh [path ...]
#   No paths: every *.md file (README.md, docs/*.md, contracts/mock-mpc/README.md, ...), demo/*,
#   string literals in offchain/src/**/*.ts, contracts/**/errors.rs, and the quoted strings
#   (what they print) in Makefile, Dockerfile and scripts/**/*.sh (this script excepted: it holds
#   the banned list). Paths (files or directories) replace that list, e.g. for tests.
# Exit: 0 clean, 1 banned copy found (each hit printed as file:line), 2 usage / environment error.
#
# Banned (case-insensitive): \b(safe|scam|malicious|secure|presale|staking|airdrop)\b, $RCLAW,
# $<digit>, \bUSD\b (USDC is fine), "price target".
# Scope rules:
#   - *.ts: only string and template literals are checked (comments and identifiers are not
#     shown to users). Needs offchain/node_modules/typescript; without it whole lines are checked.
#   - *.rs: checked up to the first `#[cfg(test)]` line (test modules hold the banned-word list
#     of the contract's own copy test and never reach users).
#   - *.sh, Makefile, Dockerfile: only quoted strings on lines that are not comments; inside double
#     quotes a shell positional parameter ($1, ${2}) is not text and is ignored.
#   - Allow-list: the quoted official track brief in docs/BASELINE.md. "Rust memory
#     safety" needs no entry: \bsafe\b does not match "safety".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE:-node}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "copy_lint: node not found (set NODE or install Node 22)" >&2
  exit 2
fi

files=()
add_tree() { # every regular file under $1, skipping dependency and build folders
  while IFS= read -r -d '' f; do files+=("$f"); done < <(
    find "$1" \( -name node_modules -o -name target -o -name .git \) -prune -o -type f -print0 | sort -z
  )
}

if [[ $# -gt 0 ]]; then
  for p in "$@"; do
    if [[ -d "$p" ]]; then
      add_tree "$p"
    elif [[ -f "$p" ]]; then
      files+=("$p")
    else
      echo "copy_lint: no such file or directory: $p" >&2
      exit 2
    fi
  done
else
  cd "$ROOT"
  default_list() { # missing folders are skipped
    find . \( -name node_modules -o -name target -o -name .git \) -prune -o -type f -name '*.md' -print0
    if [[ -d demo ]]; then find demo -maxdepth 1 -type f -print0; fi
    if [[ -d offchain/src ]]; then find offchain/src -type f -name '*.ts' -print0; fi
    if [[ -d contracts ]]; then find contracts -name target -prune -o -type f -name errors.rs -print0; fi
    local f
    for f in Makefile Dockerfile; do if [[ -f $f ]]; then printf '%s\0' "$f"; fi; done
    if [[ -d scripts ]]; then find scripts -type f -name '*.sh' ! -path scripts/copy_lint.sh -print0; fi
  }
  while IFS= read -r -d '' f; do files+=("${f#./}"); done < <(default_list | sort -z -u)
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "copy_lint: OK (no files to check)"
  exit 0
fi

# The scanner itself (Node, no dependencies besides the optional TypeScript parser).
read -r -d '' SCANNER <<'JS' || true
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const [root, ...files] = process.argv.slice(1);
const BANNED = /\b(safe|scam|malicious|secure|presale|staking|airdrop)\b|\$RCLAW|\$[0-9]|\bUSD\b|price target/gi;
// Allow-list: the official track brief, quoted in docs/BASELINE.md.
const BRIEF_QUOTE = "Build spending limits, policy engines, sandboxed wallets, reputation and scam detection.";

let ts = null;
try {
  ts = createRequire(path.join(root, "offchain", "package.json"))("typescript");
} catch {
  if (files.some((f) => f.endsWith(".ts"))) {
    console.error("copy_lint: typescript not installed (run `npm ci` in offchain); checking whole lines of .ts files");
  }
}

let hits = 0;
function report(file, lines, lineNo, match) {
  hits += 1;
  const text = (lines[lineNo - 1] ?? "").trim();
  console.log(`${file}:${lineNo}: banned copy "${match}": ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`);
}

/** Check text[start, end) and report hits with their line numbers. */
function scanRange(file, text, lines, start, end, lineOf, allowQuote) {
  let segment = text.slice(start, end);
  if (allowQuote) segment = segment.split(BRIEF_QUOTE).join(" ".repeat(BRIEF_QUOTE.length));
  for (const m of segment.matchAll(BANNED)) report(file, lines, lineOf(start + m.index), m[0]);
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Shell scripts, Makefile, Dockerfile: quoted strings on non-comment lines are what gets printed. */
function isShellLike(file) {
  const base = path.basename(file);
  return base.endsWith(".sh") || base === "Makefile" || base === "Dockerfile";
}
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g;
// $1, ${2}, ${3:-x} inside double quotes are shell parameters, not printed text.
const POSITIONAL = /\$\{?[0-9]/g;

function scanShell(file, text, lines, lineOf) {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (!/^\s*#/.test(line)) {
      for (const q of line.matchAll(QUOTED)) {
        let segment = q[0];
        if (segment.startsWith('"')) segment = segment.replace(POSITIONAL, (m) => " ".repeat(m.length));
        for (const m of segment.matchAll(BANNED)) report(file, lines, lineOf(offset + q.index + m.index), m[0]);
      }
    }
    offset += line.length + 1;
  }
}

const LITERAL_KINDS = ts
  ? new Set([
      ts.SyntaxKind.StringLiteral,
      ts.SyntaxKind.NoSubstitutionTemplateLiteral,
      ts.SyntaxKind.TemplateHead,
      ts.SyntaxKind.TemplateMiddle,
      ts.SyntaxKind.TemplateTail,
      ts.SyntaxKind.JsxText,
    ])
  : null;

for (const file of files) {
  const shown = path.isAbsolute(file) && file.startsWith(root + path.sep) ? path.relative(root, file) : file;
  let text = readFileSync(file, "utf8");
  if (file.endsWith(".rs")) {
    const cut = text.search(/^[ \t]*#\[cfg\(test\)\]/m);
    if (cut >= 0) text = text.slice(0, cut);
  }
  const lines = text.split("\n");
  const lineOf = lineIndex(text);
  const allowQuote = shown.replace(/\\/g, "/").endsWith("docs/BASELINE.md");
  if (isShellLike(file)) {
    scanShell(shown, text, lines, lineOf);
  } else if (file.endsWith(".ts") && ts) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (LITERAL_KINDS.has(node.kind)) scanRange(shown, text, lines, node.getStart(sf), node.getEnd(), lineOf, false);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  } else {
    scanRange(shown, text, lines, 0, text.length, lineOf, allowQuote);
  }
}

if (hits > 0) {
  console.error(`copy_lint: ${hits} banned word(s) in user-facing text`);
  process.exit(1);
}
console.log(`copy_lint: OK (${files.length} files checked)`);
JS

exec "$NODE_BIN" -e "$SCANNER" "$ROOT" "${files[@]}"
