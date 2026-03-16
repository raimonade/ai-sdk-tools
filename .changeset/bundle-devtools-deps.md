---
"@raimonade/ai-sdk-tools-devtools": patch
---

Bundle heavy deps (@xyflow/react, @mui/*, dagre, react-json-view-lite) into dist instead of leaving them as external imports. Fixes silent load failure in SSR environments where dual-instance resolution prevented the lazy-loaded devtools from rendering.
