// Provider-agnostic root exports only.
// Note: You can add provider-specific helpers in /providers (to avoid peer dependency conflicts)
export type {
  ChatSession,
  ChatSummary,
  ChatsConfig,
  ConversationMessage,
  GenerateSuggestionsConfig,
  GenerateSummaryConfig,
  GenerateTitleConfig,
  MemoryConfig,
  MemoryProvider,
  MemoryScope,
  WorkingMemory,
} from "./types.js";

// Utils
export {
  DEFAULT_TEMPLATE,
  formatChatSummaries,
  formatHistory,
  formatWorkingMemory,
  getWorkingMemoryInstructions,
} from "./utils.js";
