// Unit tests only: no network, every fetch is mocked.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Fail loudly if any test forgets to mock fetch (see test/setup.ts).
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
  },
});
