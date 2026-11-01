# mock-mpc (sandbox only)

**Sandbox test key, worthless, never use anywhere else.**
The server never holds mainnet keys or signs for users.

A stand-in for the NEAR chain-signatures MPC contract (`v1.signer-prod.testnet`) so the
Claw Guard flow runs on a local sandbox without network access. It refuses to initialize on
any account that does not end in `.test.near`.

- `sign({"request":{"path","payload_v2":{"Ecdsa":"<64 hex>"},"domain_id":0}})`, payable
  (at least 1 yoctoNEAR), returns the same JSON as the real contract, at once:
  `{"scheme":"Secp256k1","big_r":{"affine_point":"02|03…"},"s":{"scalar":"…"},"recovery_id":0|1}`.
- The signing key for a request is `keccak256("clawguard-sandbox-only:" ‖ caller ‖ "," ‖ path)`.
  It is computed from public strings on purpose, so these signatures prove nothing outside
  the sandbox.
- Views: `derived_address({"predecessor","path"})`, `sign_count()`, `is_failing()`.
- `set_fail({"fail":true})` (only the mock's own account) makes `sign` fail, to test the
  guard's `SignFailed` path.

Build: `scripts/build_contracts.sh mock-mpc` → `target/near/mock_mpc/mock_mpc.wasm`.
Tests: `cargo test -p mock-mpc`.
