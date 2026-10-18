import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is the board source.
export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
