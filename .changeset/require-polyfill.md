---
"@raimonade/ai-sdk-tools-devtools": patch
---

Add createRequire polyfill to ESM output so bundled CJS deps (use-sync-external-store) can require('react') during SSR.
