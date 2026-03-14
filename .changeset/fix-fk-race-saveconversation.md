---
"@raimonade/ai-sdk-tools-agents": patch
---

fix(agents): await saveChat before saveMessage to prevent FK constraint race on new chats
