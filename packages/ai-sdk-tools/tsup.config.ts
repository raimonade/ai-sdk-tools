import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "@raimonade/ai-sdk-tools-agents",
    "@raimonade/ai-sdk-tools-artifacts",
    "@raimonade/ai-sdk-tools-cache",
    "@raimonade/ai-sdk-tools-devtools",
    "@raimonade/ai-sdk-tools-memory",
    "@raimonade/ai-sdk-tools-store",
    "ai",
    "@ai-sdk/react",
    "react",
    "react-dom",
    "zod",
    "zustand",
  ],
});
