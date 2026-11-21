import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-sentry-traces",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
