import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "@raimonade/agents",
    "@raimonade/artifacts",
    "@raimonade/cache",
    "@raimonade/devtools",
    "@raimonade/memory",
    "@raimonade/store",
    "ai",
    "@ai-sdk/react",
    "react",
    "react-dom",
    "zod",
    "zustand",
  ],
});
