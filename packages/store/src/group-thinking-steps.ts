import {
  type DynamicToolUIPart,
  type ReasoningUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";

export type ThinkingStepPart = ReasoningUIPart | ToolUIPart | DynamicToolUIPart;

export type AssistantRenderItem =
  | { type: "thinking-steps"; parts: ThinkingStepPart[] }
  | { type: "part"; part: UIMessage["parts"][number] };

function isThinkingStepPart(
  part: UIMessage["parts"][number],
): part is ThinkingStepPart {
  if (part.type === "reasoning") return true;
  if (part.type === "dynamic-tool") return true;
  return part.type.startsWith("tool-") && "state" in part;
}

// Groups contiguous reasoning + tool parts into thinking-step groups.
// Non-thinking parts (text, file, source-url, data-*) become standalone render items.
// step-start markers are skipped entirely.
export function groupThinkingStepParts(
  parts: UIMessage["parts"],
): AssistantRenderItem[] {
  const renderItems: AssistantRenderItem[] = [];
  let currentThinkingParts: ThinkingStepPart[] = [];

  const flushThinkingParts = () => {
    if (currentThinkingParts.length > 0) {
      renderItems.push({
        type: "thinking-steps",
        parts: currentThinkingParts,
      });
      currentThinkingParts = [];
    }
  };

  for (const part of parts) {
    if (part.type === "step-start") continue;

    if (isThinkingStepPart(part)) {
      currentThinkingParts.push(part);
      continue;
    }

    flushThinkingParts();
    renderItems.push({ type: "part", part });
  }

  flushThinkingParts();
  return renderItems;
}

// Checks if a thinking step part is actively running (streaming reasoning or tool awaiting output).
export function isThinkingStepActive(
  part: ThinkingStepPart,
  isLastMessageStreaming: boolean,
): boolean {
  if (part.type === "reasoning") {
    return part.state === "streaming";
  }

  return (
    isLastMessageStreaming &&
    part.output == null &&
    part.errorText == null
  );
}
