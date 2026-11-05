import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@cdep/protocol": here("./packages/protocol/src/index.ts"),
      "@cdep/formats": here("./packages/formats/src/index.ts"),
      "@cdep/browser": here("./packages/browser/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/unit/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
