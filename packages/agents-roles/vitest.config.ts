import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@rlabs/agent-tools": fileURLToPath(new URL("../agent-tools/src/index.ts", import.meta.url)),
      "@rlabs/runtime-config": fileURLToPath(new URL("../runtime-config/src/index.ts", import.meta.url)),
    },
  },
});
