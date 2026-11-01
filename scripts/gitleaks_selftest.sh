#!/usr/bin/env bash
# Self-test for .gitleaks.toml / .gitleaks-dir.toml.
# Every value is random and made at run time in a temporary directory: nothing here is a real key,
# and no key-shaped fixture is ever committed (it would fail the history scan).
# Checks:
#   1. the NEAR secp256k1 rule catches the 32-byte secret form (near-crypto / near-cli-rs, about
#      44 base58 characters) in a .env line, a credentials JSON and a bare string, and the 96-byte
#      form; a 64-byte secp256k1 public key is not reported;
#   2. the history scan (`gitleaks git --config .gitleaks.toml`) reports secrets in force-added
#      files under target/ directories;
#   3. the working-tree config (.gitleaks-dir.toml) skips target/ but keeps every rule.
# Usage: bash scripts/gitleaks_selftest.sh   (GITLEAKS=/path/to/gitleaks to pick the binary)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gitleaks=${GITLEAKS:-gitleaks}
command -v "$gitleaks" >/dev/null || { echo "gitleaks_selftest: gitleaks not found (set GITLEAKS)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "gitleaks_selftest: python3 not found" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Random values: base58 of fresh random bytes, a Telegram-shaped token. Written straight to files.
python3 -I - "$work" <<'PY'
import os, sys
work = sys.argv[1]
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(data: bytes) -> str:
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out
def write(path, text):
    full = os.path.join(work, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(text + "\n")
secp32 = "secp256k1:" + b58(os.urandom(32))
secp96 = "secp256k1:" + b58(os.urandom(96))
secp_pub = "secp256k1:" + b58(os.urandom(64))
ed = "ed25519:" + b58(os.urandom(64))
tg = str(100_000_000 + int.from_bytes(os.urandom(4), "big") % 900_000_000) + ":" + "".join(
    ALPHABET[b % 58] for b in os.urandom(35))
write("dir/secp32_env.txt", f"OWNER_PRIVATE_KEY={secp32}")
write("dir/secp32_cred.json", '{"account_id":"owner.testnet","private_key":"%s"}' % secp32)
write("dir/secp32_bare.ts", f'const k = "{secp32}";')
write("dir/secp96.txt", secp96)
write("dir/secp_pub.ts", f'export const ROOT_PUBLIC_KEY = "{secp_pub}";')
write("repo/target/leak.txt", ed)
write("repo/contract/target/debug/notes.txt", f"token {tg}")
write("repo/control.md", f"token {tg}")
PY

# findings <report.json>: one "RuleID file" line per finding, file relative to the scan root.
findings() {
  python3 -I - "$1" <<'PY'
import json, sys
for f in json.load(open(sys.argv[1])) or []:
    print(f["RuleID"], f["File"].split("/dir/")[-1].split("/repo/")[-1].removeprefix("./"))
PY
}

fail=0
expect() { # expect <description> <actual> <expected>
  if [[ "$2" == "$3" ]]; then echo "gitleaks_selftest: ok   $1"; else
    echo "gitleaks_selftest: FAIL $1"; echo "  expected: $(echo "$3" | tr '\n' ';')"; echo "  actual:   $(echo "$2" | tr '\n' ';')"; fail=1
  fi
}

# 1. secp256k1 forms (working-tree scan of the probe files with the history config).
cd "$root"
"$gitleaks" dir --config .gitleaks.toml --no-banner --redact --exit-code 0 \
  --report-format json --report-path "$work/dir.json" "$work/dir" >/dev/null 2>&1
expect "secp256k1 32-byte and 96-byte secrets reported, 64-byte public key not" \
  "$(findings "$work/dir.json" | sort)" \
  "$(printf '%s\n' "near-secp256k1-secret-key secp32_bare.ts" "near-secp256k1-secret-key secp32_cred.json" \
      "near-secp256k1-secret-key secp32_env.txt" "near-secp256k1-secret-key secp96.txt")"

# 2. History scan: force-added files under target/ are reported.
cp .gitleaks.toml .gitignore "$work/repo/"
git -C "$work/repo" init -q
git -C "$work/repo" add -f .
git -C "$work/repo" -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false \
  commit -q -m "selftest"
(cd "$work/repo" && "$gitleaks" git --config .gitleaks.toml --no-banner --redact --exit-code 0 \
  --report-format json --report-path "$work/git.json" . >/dev/null 2>&1)
expect "history scan reports force-added files under target/" \
  "$(findings "$work/git.json" | sort)" \
  "$(printf '%s\n' "near-ed25519-secret-key target/leak.txt" "telegram-bot-token contract/target/debug/notes.txt" \
      "telegram-bot-token control.md")"

# 3. Working-tree config: skips target/, keeps the rules.
cp .gitleaks-dir.toml "$work/repo/"
(cd "$work/repo" && "$gitleaks" dir --config .gitleaks-dir.toml --no-banner --redact --exit-code 0 \
  --report-format json --report-path "$work/tree.json" . >/dev/null 2>&1)
expect "working-tree config skips target/ and keeps the rules" \
  "$(findings "$work/tree.json" | sort)" "telegram-bot-token control.md"

if [[ $fail -ne 0 ]]; then echo "gitleaks_selftest: FAILED" >&2; exit 1; fi
echo "gitleaks_selftest: OK"
