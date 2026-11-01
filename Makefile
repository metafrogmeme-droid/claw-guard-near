# Claw Guard: Signing Gate for AI Agents. Prototype. Testnet only. Not audited.
# The server never holds mainnet keys or signs for users.
#
#   make demo          the whole story on a local NEAR sandbox: no .env, no keys, no network accounts
#   make test          Rust unit + sandbox tests (cargo test --workspace) and TypeScript tests
#   make lint          cargo fmt --check, clippy -D warnings, eslint, tsc, copy lint
#   make build         build both contracts to wasm (scripts/build_contracts.sh)
#   make deps          build both contracts and install the offchain npm packages; starts no sandbox (Dockerfile)
#   make demo-testnet  NEAR testnet with your offchain/.env (owner go: OWNER_GO=yes)
#   make spike-hl      Hyperliquid testnet spike (owner go: OWNER_GO=yes)
#   make clean         remove build outputs, node_modules and local sandbox state
#
# Requirements: Rust 1.97 (rust-toolchain.toml), cargo-near 0.22 (optional: plain cargo is the
# fallback), Node 22.22.2 or newer 22.x with npm, bash, make, a C toolchain (cc: Rust's linker);
# for `make test` / `make lint` also pkg-config and the OpenSSL headers (libssl-dev).
#
# Open-files limit (owner decision D-13): the local sandbox node (neard 2.14.0) needs an open-files
# hard limit of 65535. On hosts with less (e.g. a container with 20000), `make demo` and `make test`
# run the sandbox node through scripts/fdlimit (a small LD_PRELOAD shim built with cc; Linux only)
# and print one line saying so; elsewhere nothing changes. Details: scripts/sandbox_env.sh.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

NPM := npm --prefix offchain
# npm writes this file on every install; it is newer than the lockfile when the install is current.
NODE_DEPS := offchain/node_modules/.package-lock.json
SPIKE_RECEIPT_FILE := $(CURDIR)/offchain/.sandbox/spike-receipt-id
# Prefix for every command that starts a local sandbox node (D-13 open-files fallback; it only
# acts when the hard limit is below 65535). Never used for testnet targets.
WITH_SANDBOX := bash scripts/sandbox_env.sh

.PHONY: help build deps demo demo-testnet test lint spike-hl clean check-node owner-go

help:
	@sed -n 's/^#   \(make .*\)/\1/p' $(firstword $(MAKEFILE_LIST))

check-node:
	@command -v node >/dev/null || { echo "make: node not found; install Node 22.22.2 or newer 22.x" >&2; exit 1; }
	@node -e 'const [a, b, c] = process.versions.node.split(".").map(Number); if (!(a === 22 && (b > 22 || (b === 22 && c >= 2)))) { console.error(`make: Node 22.22.2 or newer 22.x is required (found $${process.version})`); process.exit(1); }'

# Installs the exact lockfile versions, only when node_modules is missing or older than the lockfile.
$(NODE_DEPS): offchain/package.json offchain/package-lock.json | check-node
	cd offchain && npm ci --no-audit --no-fund

build:
	scripts/build_contracts.sh

# Everything `make demo` and `make test` need before they start a sandbox. The Dockerfile runs it
# at image build time, so `docker run … make demo` only runs the demo.
# check-node comes first, so a wrong Node version fails before the contract build starts.
deps: check-node build $(NODE_DEPS)

demo: check-node build $(NODE_DEPS)
	$(WITH_SANDBOX) $(NPM) run --silent demo

test: check-node build $(NODE_DEPS)
	$(WITH_SANDBOX) cargo test --workspace
	$(NPM) test
	bash tests/fdlimit/test.sh

lint: $(NODE_DEPS) | check-node
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	$(NPM) run lint
	$(NPM) run typecheck
	bash scripts/copy_lint.sh

# ---- testnet: owner go only ----

owner-go:
	@test -f offchain/.env || { echo "Refused: offchain/.env is missing (copy offchain/.env.example, fill testnet values only)" >&2; exit 1; }
	@test "$(OWNER_GO)" = "yes" || { echo "Refused: this target sends NEAR testnet / Hyperliquid testnet transactions; run it with OWNER_GO=yes after the owner says go" >&2; exit 1; }

demo-testnet: $(NODE_DEPS) | check-node
	@echo "make demo-testnet deploys Claw Guard on NEAR testnet with the owner key from offchain/.env (testnet keys only),"
	@echo "then runs the scripted agent (normal + injection) with the agent's function-call key. It needs the owner's go."
	@$(MAKE) owner-go
	$(NPM) run setup:testnet -- --yes
	$(NPM) run agent -- --scenario all

spike-hl: $(NODE_DEPS) | check-node
	@echo "Hyperliquid spike: derive the hl-testnet-1 address, approve it as an API wallet with the testnet-only"
	@echo "master key, have the deployed testnet guard sign one far-below-market order, relay it to Hyperliquid testnet."
	@echo "Needs offchain/.env, a guard already deployed on testnet (make demo-testnet) and the owner's go."
	@$(MAKE) owner-go
	$(NPM) run derive -- --path hl-testnet-1
	$(NPM) run approve-hl-agent -- --yes
	mkdir -p $(dir $(SPIKE_RECEIPT_FILE))
	$(NPM) run agent -- --scenario spike --receipt-id-file $(SPIKE_RECEIPT_FILE)
	$(NPM) run relay -- --receipt "$$(cat $(SPIKE_RECEIPT_FILE))"

clean:
	cargo clean
	rm -rf offchain/node_modules offchain/.sandbox offchain/coverage
