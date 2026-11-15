import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    silent: "passed-only",
    name: "bb-plugin-tokenomos",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    testTimeout: 20_000,
  },
});
