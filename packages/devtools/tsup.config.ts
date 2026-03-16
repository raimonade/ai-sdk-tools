import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
  injectStyle: false, // Don't generate separate CSS files
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@ai-sdk/react",
    "@raimonade/ai-sdk-tools-store",
  ],
  esbuildOptions(options) {
    options.loader = {
      ...options.loader,
      ".css": "text",
    };
  },
  banner: {
    js: `
// Auto-inject CSS styles when module loads
(function() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ai-devtools-styles')) return;

  const CSS_CONTENT = \`${[
    readFileSync(require.resolve("@xyflow/react/dist/style.css"), "utf-8"),
    readFileSync(resolve(__dirname, "src/styles.css"), "utf-8"),
  ].join("\\n").replace(/\`/g, "\\\`").replace(/\$/g, "\\$")}\`;

  const style = document.createElement('style');
  style.id = 'ai-devtools-styles';
  style.textContent = CSS_CONTENT;
  document.head.appendChild(style);
})();
`,
  },
  onSuccess: async () => {
    const files = ["dist/index.js", "dist/index.mjs"];
    for (const file of files) {
      try {
        const content = readFileSync(resolve(__dirname, file), "utf-8");
        const isESM = file.endsWith(".mjs");
        // ESM: polyfill require so bundled CJS deps (use-sync-external-store) can
        // require('react') during SSR where Node loads this as a native ES module.
        const requireShim = isESM
          ? `import { createRequire as __cr } from "node:module";\nconst require = __cr(import.meta.url);\n`
          : "";
        const patched = `"use client";\n${requireShim}\n${content}`;
        writeFileSync(resolve(__dirname, file), patched);
        console.log(`✅ Patched ${file}`);
      } catch (error) {
        console.error(`❌ Failed to patch ${file}:`, error);
      }
    }
  },
});
