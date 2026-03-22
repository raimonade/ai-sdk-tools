import { createLogger } from "@raimonade/ai-sdk-tools-debug";
import type { UIMessageStreamWriter } from "ai";
import type { AgentEvent, Agent as IAgent } from "./types.js";
import { extractTextFromMessage } from "./utils.js";
import type { ModelMessage } from "ai";

const logger = createLogger("SYNTHESIS");

const DEFAULT_SUBSTANTIAL_TEXT_THRESHOLD = 20;
const DEFAULT_SYNTHESIS_TEXT_LIMIT = 3000;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 15_000;

export interface SynthesisTurnOptions {
  currentAgent: IAgent<any>;
  toolCallCounts: Map<string, number>;
  toolResultsList: Array<{
    toolName: string;
    toolCallId: string;
    output: unknown;
  }>;
  postToolText: string;
  textAccumulated: string;
  messagesToSend: ModelMessage[];
  executionContext: Record<string, unknown>;
  writer: UIMessageStreamWriter;
  round: number;
  onEventWithTrace: (event: AgentEvent) => Promise<void>;
  streamOptions: {
    sendReasoning?: boolean;
    sendSources?: boolean;
    sendFinish?: boolean;
    sendStart?: boolean;
    messageMetadata?: (options: {
      part: unknown;
    }) => Record<string, unknown> | undefined;
  };
  substantialTextThreshold?: number;
  synthesisTextLimit?: number;
  synthesisTimeoutMs?: number;
}

/**
 * Run a text-only synthesis turn when reserveFinalTurn is enabled and
 * the agent produced tool results but no substantial post-tool text.
 * Returns the synthesis text produced, or empty string if skipped.
 */
export async function runSynthesisTurn(opts: SynthesisTurnOptions): Promise<string> {
  const {
    currentAgent,
    toolCallCounts,
    toolResultsList,
    postToolText,
    messagesToSend,
    executionContext,
    writer,
    round,
    onEventWithTrace,
    streamOptions,
  } = opts;

  const substantialTextThreshold =
    opts.substantialTextThreshold ?? DEFAULT_SUBSTANTIAL_TEXT_THRESHOLD;
  const synthesisTextLimit =
    opts.synthesisTextLimit ?? DEFAULT_SYNTHESIS_TEXT_LIMIT;
  const synthesisTimeoutMs =
    opts.synthesisTimeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS;

  const hadToolCalls = toolCallCounts.size > 0;
  const trimmedPostToolText = postToolText.trim();
  const hasSubstantialText =
    trimmedPostToolText.length > substantialTextThreshold;

  logger.debug("reserveFinalTurn check", {
    agent: currentAgent.name,
    hadToolCalls,
    postToolTextLen: trimmedPostToolText.length,
    totalTextLen: opts.textAccumulated.trim().length,
    hasSubstantialText,
    reserveFinalTurn: currentAgent.reserveFinalTurn,
    postToolPreview: trimmedPostToolText.slice(0, 100),
    toolCallNames: [...toolCallCounts.keys()],
  });

  if (!hadToolCalls || hasSubstantialText || !currentAgent.reserveFinalTurn) {
    return "";
  }

  await onEventWithTrace({
    type: "agent-warning",
    agent: currentAgent.name,
    round,
    code: "no-text-turn",
    message:
      "Agent completed its tool turn without producing synthesis text; running reserve final turn",
  });

  logger.debug(
    "reserveFinalTurn: agent exhausted turns without synthesis, making text-only call",
    { agent: currentAgent.name },
  );

  // Build synthesis messages: user question + tool results only.
  const toolResultSummary = toolResultsList
    .map(({ toolName, output }) => {
      let text: string;
      if (typeof output === "object" && output !== null && "text" in output) {
        text = String((output as Record<string, unknown>).text);
      } else if (typeof output === "string") {
        text = output;
      } else {
        const json = JSON.stringify(output);
        text =
          json.length > synthesisTextLimit
            ? json.slice(0, synthesisTextLimit) +
              "\n[...truncated — tool should return a `text` property for synthesis]"
            : json;
      }
      return `[${toolName}]\n${text}`;
    })
    .join("\n\n");

  const lastUserMsg = [...messagesToSend]
    .reverse()
    .find((m) => m.role === "user");
  const userQuestion = lastUserMsg
    ? extractTextFromMessage(lastUserMsg)
    : "";
  const synthLang = executionContext._synthesisLanguage as string | undefined;
  const synthUserPrompt = synthLang
    ? `Now write a complete answer in ${synthLang} to: ${userQuestion}`
    : `Now write a complete answer to: ${userQuestion}`;

  const synthMessages = [
    ...(lastUserMsg ? [lastUserMsg] : messagesToSend.slice(0, 1)),
    {
      role: "assistant" as const,
      content: `I called these tools and got the following results:\n\n${toolResultSummary}`,
    },
    {
      role: "user" as const,
      content: synthUserPrompt,
    },
  ];

  let synthText = "";

  try {
    const consumeSynthesis = async () => {
      const synthResult = await currentAgent.stream({
        messages: synthMessages,
        executionContext,
        textOnly: true,
        maxSteps: 1,
      } as any);

      const synthStream = synthResult.toUIMessageStream(streamOptions);

      for await (const chunk of synthStream) {
        if (!chunk) continue;
        try {
          writer.write(chunk as any);
        } catch (error) {
          logger.error("Failed to write synthesis chunk", { error });
        }
        if (chunk.type === "text-delta") {
          synthText += chunk.delta;
        }
      }
    };

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Synthesis timed out")),
        synthesisTimeoutMs,
      );
    });

    await Promise.race([consumeSynthesis(), timeout]);
  } catch (synthError) {
    const isTimeout =
      synthError instanceof Error &&
      synthError.message === "Synthesis timed out";
    logger.error(
      isTimeout
        ? "reserveFinalTurn synthesis timed out, using partial text"
        : "reserveFinalTurn synthesis call failed, emitting fallback",
      { agent: currentAgent.name, error: synthError },
    );
    if (!synthText.trim()) {
      const fallback =
        "I found the data above but encountered an error while composing my summary. " +
        "Please ask a follow-up question and I'll try again.";
      try {
        writer.write({ type: "text-delta", delta: fallback } as any);
      } catch {
        // best-effort
      }
      synthText = fallback;
    }
  }

  return synthText;
}
