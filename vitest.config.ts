import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "html"],
    },
    include: ["{apps,packages}/**/*.test.ts"],
    testTimeout: 10_000,
  },
});

