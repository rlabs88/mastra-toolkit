import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
