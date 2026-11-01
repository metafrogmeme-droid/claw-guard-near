#!/usr/bin/env python3
# Dev-only helper. Testnet only. Never use with real keys.
#
# Generates Hyperliquid L1-action hash vectors with the official
# hyperliquid-python-sdk (pinned 0.24.0) so the claw-guard contract (Rust) and
# the off-chain code (TypeScript) can prove they hash exactly like the SDK.
#
#   python3 -m venv .venv && .venv/bin/pip install hyperliquid-python-sdk==0.24.0
#   .venv/bin/python -I scripts/hl_vectors.py offchain/test/vectors
#
# The signing key is derived at runtime from a public label, so no key is ever
# stored in the repo. It is a worthless test key: never fund it, never use it.
import json
import sys
from pathlib import Path

import eth_account
import msgpack
from eth_account.messages import _hash_eip191_message, encode_typed_data
from eth_utils import keccak
from hyperliquid.utils.signing import (
    action_hash,
    construct_phantom_agent,
    float_to_wire,
    l1_payload,
    order_request_to_order_wire,
    order_wires_to_order_action,
    sign_l1_action,
)

SDK_VERSION = "0.24.0"
TEST_KEY_LABEL = b"clawguard-test-vectors-only"
IS_MAINNET = False  # testnet: phantom agent source "b"

wallet = eth_account.Account.from_key(keccak(TEST_KEY_LABEL))


def digest_of(action, nonce):
    conn = action_hash(action, None, nonce, None)
    agent = construct_phantom_agent(conn, IS_MAINNET)
    signable = encode_typed_data(full_message=l1_payload(agent))
    return conn, _hash_eip191_message(signable)


def record(name, request, action, nonce):
    conn, digest = digest_of(action, nonce)
    sig = sign_l1_action(wallet, action, None, nonce, None, IS_MAINNET)
    return {
        "name": name,
        "request": request,
        "action": action,
        "action_json": json.dumps(action, separators=(",", ":")),
        "msgpack_hex": msgpack.packb(action).hex(),
        "nonce_ms": nonce,
        "source": "b",
        "connection_id": "0x" + conn.hex(),
        "digest": "0x" + digest.hex(),
        "signer": wallet.address.lower(),
        "signature": sig,
    }


ORDERS = [
    # name, asset, is_buy, px, sz, reduce_only, tif, nonce
    ("btc_buy_far_below", 3, True, 1000.0, 0.001, False, "Gtc", 1793318400000),
    ("btc_sell_ioc", 3, False, 65000.0, 0.01, False, "Ioc", 1793318400001),
    ("eth_buy_alo_reduce", 4, True, 2500.5, 0.1, True, "Alo", 1793318400002),
    ("asset0_tiny", 0, True, 0.5, 0.00000001, False, "Gtc", 1793318400003),
    ("asset127_fixint_edge", 127, False, 12.345, 1.5, False, "Gtc", 1793318400004),
    ("asset128_uint8", 128, True, 1.0, 10.0, False, "Gtc", 1793318400005),
    ("asset255_uint8_max", 255, True, 99999.0, 0.12345678, False, "Ioc", 1793318400006),
    ("asset256_uint16", 256, False, 0.0001234, 123.0, True, "Gtc", 1793318400007),
    ("asset65536_uint32", 65536, True, 3.1415, 2.0, False, "Alo", 1793318400008),
    ("big_nonce", 3, True, 1000.0, 0.002, False, "Gtc", 18446744073709551615),
]

LEVERAGE = [
    # name, asset, is_cross, leverage, nonce
    ("btc_cross_3x", 3, True, 3, 1793318400100),
    ("btc_isolated_1x", 3, False, 1, 1793318400101),
    ("eth_cross_50x", 4, True, 50, 1793318400102),
    ("asset200_isolated_20x", 200, False, 20, 1793318400103),
]


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    orders = []
    for name, asset, is_buy, px, sz, ro, tif, nonce in ORDERS:
        req = {"coin_asset": asset, "is_buy": is_buy, "limit_px": float_to_wire(px),
               "sz": float_to_wire(sz), "reduce_only": ro, "tif": tif}
        wire = order_request_to_order_wire(
            {"coin": "X", "is_buy": is_buy, "sz": sz, "limit_px": px,
             "order_type": {"limit": {"tif": tif}}, "reduce_only": ro}, asset)
        orders.append(record(name, req, order_wires_to_order_action([wire]), nonce))
    lev = []
    for name, asset, is_cross, leverage, nonce in LEVERAGE:
        action = {"type": "updateLeverage", "asset": asset, "isCross": is_cross, "leverage": leverage}
        req = {"coin_asset": asset, "is_cross": is_cross, "leverage": leverage}
        lev.append(record(name, req, action, nonce))
    meta = {"generator": "scripts/hl_vectors.py", "sdk": f"hyperliquid-python-sdk=={SDK_VERSION}",
            "is_mainnet": IS_MAINNET, "note": "Testnet only. Test key derived from a public label; worthless."}
    (out / "hl_orders.json").write_text(json.dumps({"meta": meta, "vectors": orders}, indent=2) + "\n")
    (out / "hl_update_leverage.json").write_text(json.dumps({"meta": meta, "vectors": lev}, indent=2) + "\n")
    print(f"wrote {len(orders)} order + {len(lev)} updateLeverage vectors to {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "offchain/test/vectors")
