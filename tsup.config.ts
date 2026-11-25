import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Browser and edge safe: no Node built-ins. Hashing uses Web Crypto.
    entry: { core: "src/core.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    target: "es2022",
    outDir: "dist",
    platform: "neutral",
    external: ["zod", "yaml"],
  },
  {
    // Node: everything in core plus the file system layer and the CLI.
    entry: { index: "src/index.ts", cli: "src/cli.ts" },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts" } },
    sourcemap: true,
    clean: false,
    splitting: true,
    target: "es2022",
    outDir: "dist",
    platform: "node",
  },
]);
