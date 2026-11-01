// Test setup: unit tests never touch the network. Any code path that reaches the
// global fetch (including near-api-js providers) fails the test; tests pass a mocked fetchImpl.
import { vi } from "vitest";

vi.stubGlobal("fetch", (input: unknown) => {
  throw new Error(`network access is disabled in unit tests (fetch ${String(input)})`);
});
