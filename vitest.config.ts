import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    // Several tests exercise the file-backed stores (buyers/receipts/nonces and
    // the settled-ledger cache) that live at fixed paths in fixtures/. Run test
    // files sequentially so those shared-fixture reads/writes never race across
    // parallel workers.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // scripts/ are thin CLI entrypoints exercised via readiness/demo, not
      // unit-tested directly; api/main.ts is the analogous `npm run api`
      // bootstrap (only wires the tested createApp() to a socket, no logic);
      // docs/assets is the README asset toolchain, not app code — all excluded
      // so the report reflects engine/api/db.
      exclude: [
        "docs/assets/**",
        "scripts/**",
        "api/main.ts",
        "test/**",
        "**/*.config.ts",
        "**/*.config.mjs",
        "node_modules/**",
      ],
    },
  },
});
