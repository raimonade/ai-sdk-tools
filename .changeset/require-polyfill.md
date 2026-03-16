---
"@raimonade/ai-sdk-tools-devtools": patch
---

Externalize zustand to fix "Dynamic require of react is not supported" during SSR. Zustand's CJS dep (use-sync-external-store) was being bundled into ESM dist and its require('react') call failed in Node ESM context.
