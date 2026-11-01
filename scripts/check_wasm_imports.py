#!/usr/bin/env python3
"""Refuse a contract wasm that imports a host function NEAR mainnet protocol 86 lacks (D-21).

Usage:
  scripts/check_wasm_imports.py <file.wasm>...   check each file against the allowlist
  scripts/check_wasm_imports.py --self-test      check that the checker itself refuses and accepts

Allowlist: scripts/near-host-fns-protocol-86.txt (one name per line, module `env`; `#` comments).
A host function outside the list makes the whole deploy batch fail on mainnet with
`Link Error: unknown or invalid import` (attempt 1 in docs/PROOF_MAINNET.md). Exit code 1 on any
refusal, 2 on a malformed file. Standard library only.
"""

from __future__ import annotations

import sys
from pathlib import Path

ALLOWLIST = Path(__file__).with_name("near-host-fns-protocol-86.txt")


def load_allowlist(path: Path = ALLOWLIST) -> set[str]:
    names = set()
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.add(line)
    return names


def _leb(data: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        if i >= len(data):
            raise ValueError("truncated LEB128")
        byte = data[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def _name(data: bytes, i: int) -> tuple[str, int]:
    n, i = _leb(data, i)
    if i + n > len(data):
        raise ValueError("truncated name")
    return data[i : i + n].decode("utf-8"), i + n


def wasm_imports(data: bytes) -> list[tuple[str, str, int]]:
    """(module, name, kind) of every import; kind 0 is a function."""
    if data[:8] != b"\0asm\x01\0\0\0":
        raise ValueError("not a wasm 1.0 module")
    out = []
    i = 8
    while i < len(data):
        section = data[i]
        size, i = _leb(data, i + 1)
        end = i + size
        if end > len(data):
            raise ValueError("truncated section")
        if section == 2:
            count, j = _leb(data, i)
            for _ in range(count):
                module, j = _name(data, j)
                field, j = _name(data, j)
                kind = data[j]
                j += 1
                if kind == 0:  # function: type index
                    _, j = _leb(data, j)
                elif kind == 1:  # table: reftype + limits
                    j += 1
                    flags, j = _leb(data, j)
                    _, j = _leb(data, j)
                    if flags & 1:
                        _, j = _leb(data, j)
                elif kind == 2:  # memory: limits
                    flags, j = _leb(data, j)
                    _, j = _leb(data, j)
                    if flags & 1:
                        _, j = _leb(data, j)
                elif kind == 3:  # global: valtype + mutability
                    j += 2
                else:
                    raise ValueError(f"unknown import kind {kind}")
                out.append((module, field, kind))
        i = end
    return out


def refusals(data: bytes, allowed: set[str]) -> list[str]:
    bad = []
    for module, field, kind in wasm_imports(data):
        if module != "env":
            bad.append(f"{module}.{field} (module is not env)")
        elif kind != 0:
            bad.append(f"env.{field} (not a function import)")
        elif field not in allowed:
            bad.append(f"env.{field} (not on mainnet protocol 86)")
    return bad


def _module_with_imports(names: list[str]) -> bytes:
    """A minimal wasm with one type `() -> ()` and one function import per name."""

    def vec(items: list[bytes]) -> bytes:
        return bytes([len(items)]) + b"".join(items)

    def section(sid: int, body: bytes) -> bytes:
        return bytes([sid, len(body)]) + body

    def name(s: str) -> bytes:
        return bytes([len(s)]) + s.encode()

    types = section(1, vec([b"\x60\x00\x00"]))
    imports = section(2, vec([name("env") + name(n) + b"\x00\x00" for n in names]))
    return b"\0asm\x01\0\0\0" + types + imports


def self_test() -> int:
    allowed = load_allowlist()
    ok = _module_with_imports(["input", "value_return", "promise_yield_create"])
    bad = _module_with_imports(["input", "promise_batch_action_universal_state_init"])
    checks = [
        ("allowlist is not empty", len(allowed) > 50),
        ("allowlist has no protocol-87/88 function",
         not allowed & {"sha3_256", "ml_dsa_verify", "promise_batch_action_universal_state_init",
                        "universal_state_init_to_account_id", "sandbox_debug_log"}),
        ("accepts allowed imports", refusals(ok, allowed) == []),
        ("refuses universal_state_init",
         refusals(bad, allowed) == ["env.promise_batch_action_universal_state_init (not on mainnet protocol 86)"]),
    ]
    try:
        wasm_imports(b"not wasm")
        checks.append(("refuses a non-wasm file", False))
    except ValueError:
        checks.append(("refuses a non-wasm file", True))
    failed = [label for label, passed in checks if not passed]
    for label, passed in checks:
        print(f"check_wasm_imports self-test: {'ok  ' if passed else 'FAIL'} {label}")
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    allowed = load_allowlist()
    status = 0
    for arg in argv:
        try:
            data = Path(arg).read_bytes()
            bad = refusals(data, allowed)
            count = len(wasm_imports(data))
        except (OSError, ValueError) as err:
            print(f"check_wasm_imports: {arg}: {err}", file=sys.stderr)
            return 2
        if bad:
            status = 1
            print(f"check_wasm_imports: {arg}: refused, {len(bad)} import(s) mainnet protocol 86 lacks:",
                  file=sys.stderr)
            for line in bad:
                print(f"  {line}", file=sys.stderr)
        else:
            print(f"check_wasm_imports: {arg}: ok, {count} imports, all on mainnet protocol 86")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
