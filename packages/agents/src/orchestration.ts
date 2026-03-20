import { createLogger } from "@raimonade/ai-sdk-tools-debug";
import type { ModelMessage, UIMessageStreamWriter } from "ai";
import { HANDOFF_TOOL_NAME } from "./handoff.js";
import { createDefaultInputFilter } from "./tool-result-extractor.js";
import type {
  AgentEvent,
  ConfiguredHandoff,
  HandoffInputData,
  HandoffInstruction,
} from "./types.js";
import type { AgentRunContext } from "./run-context.js";

const logger = createLogger("ORCHESTRATION");

export interface StreamConsumptionResult {
  textAccumulated: string;
  postToolText: string;
  handoffData: HandoffInstruction | null;
  toolCallNames: Map<string, string>;
  toolResultsList: Array<{
    toolName: string;
    toolCallId: string;
    output: unknown;
  }>;
  toolCallCounts: Map<string, number>;
}

/**
 * Consume an agent's UI stream, forwarding chunks to the writer while
 * tracking tool calls, text, and handoff signals.
 */
export async function consumeAgentStream(opts: {
  uiStream: AsyncIterable<any>;
  writer: UIMessageStreamWriter;
  handoffToolNames: Set<string>;
  currentAgentName: string;
  round: number;
  onEventWithTrace: (event: AgentEvent) => Promise<void>;
}): Promise<StreamConsumptionResult> {
  const { uiStream, writer, handoffToolNames, currentAgentName, round, onEventWithTrace } = opts;

  let textAccumulated = "";
  let postToolText = "";
  let hasReceivedToolOutput = false;
  let handoffData: HandoffInstruction | null = null;
  const toolCallNames = new Map<string, string>();
  const toolResultsList: Array<{
    toolName: string;
    toolCallId: string;
    output: unknown;
  }> = [];
  const toolCallCounts = new Map<string, number>();
  let hasStartedContent = false;

  for await (const chunk of uiStream) {
    if (!chunk) {
      logger.warn("Received null/undefined chunk from uiStream");
      continue;
    }

    // Track tool names when they start
    if (chunk.type === "tool-input-start") {
      toolCallNames.set(chunk.toolCallId, chunk.toolName);
      logger.debug(
        `Tool call started: ${chunk.toolName} (${chunk.toolCallId})`,
        {
          toolName: chunk.toolName,
          toolCallId: chunk.toolCallId,
          agent: currentAgentName,
          round,
        },
      );
    }

    // Check if this chunk is related to handoff (internal orchestration)
    let isHandoffChunk = false;

    if (chunk.type === "tool-input-start") {
      isHandoffChunk = handoffToolNames.has((chunk as any).toolName);
    } else if (
      chunk.type === "tool-input-delta" ||
      chunk.type === "tool-input-available"
    ) {
      const toolName = toolCallNames.get((chunk as any).toolCallId);
      isHandoffChunk = toolName ? handoffToolNames.has(toolName) : false;
    } else if (chunk.type === "tool-output-available") {
      const toolName = toolCallNames.get((chunk as any).toolCallId);
      isHandoffChunk = toolName ? handoffToolNames.has(toolName) : false;
    }

    // Clear status on first actual content
    if (
      !hasStartedContent &&
      (chunk.type === "text-delta" ||
        (chunk.type === "tool-input-start" && !isHandoffChunk))
    ) {
      hasStartedContent = true;
    }

    // Log general errors
    if (chunk.type === "error") {
      logger.error("Stream error", {
        error: (chunk as any).errorText || (chunk as any).error || chunk,
      });
    }

    // Capture tool results and detect handoffs
    if (chunk.type === "tool-output-available") {
      const toolName = toolCallNames.get(chunk.toolCallId);
      if (toolName) {
        const nextCount = (toolCallCounts.get(toolName) ?? 0) + 1;
        toolCallCounts.set(toolName, nextCount);

        toolResultsList.push({
          toolName,
          toolCallId: chunk.toolCallId,
          output: chunk.output,
        });
        logger.debug(`Captured ${toolName}`, {
          toolName,
          outputType: typeof chunk.output,
        });

        if (nextCount > 1) {
          await onEventWithTrace({
            type: "agent-warning",
            agent: currentAgentName,
            round,
            code: "repeated-tool-call",
            message: `Tool ${toolName} produced output ${nextCount} times in this request`,
            toolName,
            repeatedCount: nextCount,
          });
        }

        // Detect handoff
        if (handoffToolNames.has(toolName)) {
          handoffData = chunk.output as HandoffInstruction;
          logger.debug("Handoff detected", handoffData);
        }

        // Track post-tool text: reset so only text after LAST tool output counts
        hasReceivedToolOutput = true;
        postToolText = "";
      }
    }

    // Filter out handoff tool chunks from UI
    if (!isHandoffChunk) {
      try {
        writer.write(chunk as any);
      } catch (error) {
        logger.error("Failed to write chunk to stream", {
          chunkType: chunk.type,
          error,
        });
      }
    }

    // Track text for conversation history and post-tool synthesis check
    if (chunk.type === "text-delta") {
      textAccumulated += chunk.delta;
      if (hasReceivedToolOutput) {
        postToolText += chunk.delta;
      }
    }
  }

  return {
    textAccumulated,
    postToolText,
    handoffData,
    toolCallNames,
    toolResultsList,
    toolCallCounts,
  };
}

/**
 * Apply handoff input filter (configured or default) to conversation messages
 * before routing to the next agent.
 */
export function applyHandoffFilter(opts: {
  conversationMessages: ModelMessage[];
  toolResultsList: Array<{
    toolName: string;
    toolCallId: string;
    output: unknown;
  }>;
  configuredHandoffs: Array<ConfiguredHandoff<any>>;
  handoffData: HandoffInstruction;
  runContext: AgentRunContext<any>;
  fromAgentName: string;
}): ModelMessage[] {
  const {
    conversationMessages,
    toolResultsList,
    configuredHandoffs,
    handoffData,
    runContext,
    fromAgentName,
  } = opts;

  const configuredHandoff = configuredHandoffs.find(
    (ch) => ch.agent.name === handoffData.targetAgent,
  );

  const inputFilter = configuredHandoff?.config?.inputFilter;

  if (inputFilter) {
    try {
      const handoffInputData: HandoffInputData = {
        inputHistory: conversationMessages,
        preHandoffItems: [],
        newItems: toolResultsList.map(({ toolName, output }) => ({
          toolName,
          result: output,
        })),
        handoff: {
          fromAgent: fromAgentName,
          toAgent: handoffData.targetAgent,
          reason: handoffData.reason,
          context: handoffData.context,
          availableData: handoffData.availableData,
        },
        runContext,
      };

      const filteredData = inputFilter(handoffInputData);
      return [...filteredData.inputHistory];
    } catch (error) {
      logger.error("Error applying handoff input filter", { error });
      return conversationMessages;
    }
  }

  // Default input filter
  logger.debug("Applying default input filter for", {
    targetAgent: handoffData.targetAgent,
  });
  const defaultFilter = createDefaultInputFilter();

  const handoffInputData: HandoffInputData = {
    inputHistory: conversationMessages,
    preHandoffItems: [],
    newItems: toolResultsList.map(({ toolName, output }) => ({
      toolName,
      result: output,
    })),
    handoff: {
      fromAgent: fromAgentName,
      toAgent: handoffData.targetAgent,
      reason: handoffData.reason,
      context: handoffData.context,
      availableData: handoffData.availableData,
    },
    runContext,
  };

  logger.debug("Input history length", {
    length: handoffInputData.inputHistory.length,
  });
  logger.debug("Input history messages", {
    messages: handoffInputData.inputHistory.map((m) => ({
      role: m.role,
      contentType: typeof m.content,
    })),
  });

  const filteredData = defaultFilter(handoffInputData);
  logger.debug("Filtered history length", {
    length: filteredData.inputHistory.length,
  });

  return [...filteredData.inputHistory];
}

/**
 * Execute the onHandoff callback if configured for the target agent.
 */
export async function executeHandoffCallback(
  configuredHandoffs: Array<ConfiguredHandoff<any>>,
  targetAgentName: string,
  runContext: AgentRunContext<any>,
): Promise<void> {
  const configuredHandoff = configuredHandoffs.find(
    (ch) => ch.agent.name === targetAgentName,
  );

  if (configuredHandoff?.config?.onHandoff) {
    try {
      await configuredHandoff.config.onHandoff(runContext);
    } catch (error) {
      logger.error("Error in onHandoff callback", { error });
    }
  }
}
