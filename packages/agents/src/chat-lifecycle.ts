import { createLogger } from "@raimonade/ai-sdk-tools-debug";
import {
  DEFAULT_TEMPLATE,
  formatChatSummaries,
  formatWorkingMemory,
  getWorkingMemoryInstructions,
  type MemoryConfig,
} from "@raimonade/ai-sdk-tools-memory";
import {
  convertToModelMessages,
  generateObject,
  generateText,
  type LanguageModel,
  type ModelMessage,
  tool,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";
import { writeSuggestions } from "./streaming.js";
import type { MemoryIdentifiers } from "./types.js";
import { stripMetadata } from "./utils.js";

const logger = createLogger("CHAT_LIFECYCLE");

export class ChatLifecycle<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly memory?: MemoryConfig;
  private readonly model: LanguageModel;

  constructor(memory: MemoryConfig | undefined, model: LanguageModel) {
    this.memory = memory;
    this.model = model;
  }

  extractMemoryIdentifiers(context: TContext): {
    chatId?: string;
    userId?: string;
  } {
    const ctx = context as TContext & MemoryIdentifiers;
    const chatId = ctx.chatId || ctx.metadata?.chatId;
    const userId = ctx.userId || ctx.metadata?.userId;
    return { chatId, userId };
  }

  async loadMessagesWithHistory(
    message: UIMessage,
    context: TContext | undefined,
  ): Promise<ModelMessage[]> {
    if (!this.memory?.history?.enabled || !context) {
      logger.debug(
        "History disabled or no context - using single message only",
      );
      return await convertToModelMessages([message]);
    }

    const { chatId } = this.extractMemoryIdentifiers(context);

    if (!chatId) {
      logger.warn("Cannot load history: chatId missing from context");
      return await convertToModelMessages([message]);
    }

    if (!this.memory.provider) {
      logger.warn("No memory provider configured - using single message only");
      return await convertToModelMessages([message]);
    }

    try {
      const previousMessages =
        (await this.memory.provider.getMessages?.({
          chatId,
          limit: this.memory.history.limit,
        })) || [];

      logger.debug(`Loading history for chatId=${chatId}`, {
        chatId,
        count: previousMessages.length,
      });

      if (previousMessages.length === 0) {
        logger.debug("No previous messages found - starting new conversation");
        return await convertToModelMessages([message]);
      }

      const historyMessages = await convertToModelMessages(
        stripMetadata(previousMessages),
      );

      logger.debug(
        `Loaded ${historyMessages.length} history messages for context`,
        {
          count: historyMessages.length,
        },
      );
      return [...historyMessages, ...(await convertToModelMessages([message]))];
    } catch (err) {
      logger.error(`Load history failed for chatId=${chatId}`, {
        chatId,
        error: err,
      });
      return await convertToModelMessages([message]);
    }
  }

  async loadWorkingMemory(context: TContext): Promise<string> {
    if (!this.memory?.workingMemory?.enabled || !this.memory?.provider) {
      return "";
    }

    const { chatId, userId } = this.extractMemoryIdentifiers(context);
    const scope = this.memory.workingMemory.scope;

    try {
      const memory = await this.memory.provider.getWorkingMemory({
        chatId,
        userId,
        scope,
      });

      if (!memory) return "";

      return formatWorkingMemory(memory);
    } catch (error) {
      logger.error("Failed to load working memory", {
        error: error instanceof Error ? error.message : error,
      });
      return "";
    }
  }

  async loadChatSummaries(context: TContext): Promise<string> {
    if (!this.memory?.chats?.enabled || !this.memory?.provider) {
      return "";
    }

    const { chatId, userId } = this.extractMemoryIdentifiers(context);
    if (!chatId || !userId) return "";

    try {
      const summaries = await this.memory.provider.loadChatSummaries?.({
        userId,
        excludeChatId: chatId,
        limit: 10,
      });

      if (!summaries || summaries.length === 0) return "";

      return formatChatSummaries(summaries);
    } catch (error) {
      logger.error("Failed to load chat summaries", {
        error: error instanceof Error ? error.message : error,
      });
      return "";
    }
  }

  async saveConversation(
    chatId: string,
    userId: string | undefined,
    userMessage: string,
    assistantMessage: string,
    existingChat?: any,
  ): Promise<void> {
    if (!this.memory?.provider || !this.memory?.history?.enabled) return;

    logger.debug(`Saving conversation for chatId=${chatId}`, {
      chatId,
      userLength: userMessage.length,
      assistantLength: assistantMessage.length,
    });

    try {
      if (this.memory?.chats?.enabled) {
        const messageCount =
          1 + (assistantMessage && assistantMessage.length > 0 ? 1 : 0);

        await this.memory.provider.saveChat?.({
          ...(existingChat || { chatId, userId, createdAt: new Date() }),
          messageCount: (existingChat?.messageCount || 0) + messageCount,
          updatedAt: new Date(),
        });
      }

      const savePromises: Promise<void>[] = [];

      if (this.memory.provider.saveMessage) {
        savePromises.push(
          this.memory.provider.saveMessage({
            chatId,
            userId,
            role: "user",
            content: userMessage,
            timestamp: new Date(),
          }),
        );

        if (assistantMessage && assistantMessage.length > 0) {
          logger.debug(`Will save assistant message`, {
            length: assistantMessage.length,
          });
          savePromises.push(
            this.memory.provider.saveMessage({
              chatId,
              userId,
              role: "assistant",
              content: assistantMessage,
              timestamp: new Date(),
            }),
          );
        } else {
          logger.warn(`Skipping assistant message save - empty or undefined`);
        }
      }

      await Promise.all(savePromises);

      const totalSaved =
        savePromises.length + (this.memory?.chats?.enabled ? 1 : 0);
      logger.debug(`Successfully saved ${totalSaved} items`, {
        chatId,
        count: totalSaved,
      });
    } catch (error) {
      logger.error(`Failed to save messages for chatId=${chatId}`, {
        chatId,
        error,
      });
      throw error;
    }
  }

  async generateChatTitle(
    chatId: string,
    userMessage: string,
    writer: UIMessageStreamWriter,
    _context?: TContext,
  ): Promise<void> {
    if (!this.memory?.chats?.generateTitle) return;

    const config = this.memory.chats.generateTitle;
    const model = typeof config === "object" ? config.model : this.model;
    const instructions =
      typeof config === "object" && config.instructions
        ? config.instructions
        : `<task_context>
You are a helpful assistant that can generate titles for conversations.
</task_context>

<rules>
Find the most concise title that captures what the user is asking for.
Titles should be at most 30 characters.
Titles should be formatted in sentence case, with capital letters at the start of each word. Do not provide a period at the end.
</rules>

<task>
Generate a title for the conversation.
</task>

<output_format>
Return only the title.
</output_format>`;

    try {
      const { text } = await generateText({
        model,
        system: instructions,
        prompt: userMessage,
        temperature: 0,
      });

      await this.memory.provider?.updateChatTitle?.(chatId, text);

      writer.write({
        type: "data-chat-title",
        data: { chatId, title: text },
      });

      logger.debug(`Generated title for ${chatId}`, { chatId, title: text });
    } catch (err) {
      logger.error("Title generation failed", { error: err });
    }
  }

  async maybeGenerateChatTitle(
    context: TContext | undefined,
    userMessage: string,
    writer: UIMessageStreamWriter,
    existingChat?: any,
  ): Promise<void> {
    if (
      !this.memory?.chats?.enabled ||
      !this.memory?.chats?.generateTitle ||
      !context
    ) {
      return;
    }

    const { chatId } = this.extractMemoryIdentifiers(context);

    if (!chatId) {
      logger.warn("Cannot generate title: chatId missing from context");
      return;
    }

    const isFirstMessage = !existingChat || existingChat.messageCount === 0;
    if (isFirstMessage) {
      this.generateChatTitle(chatId, userMessage, writer, context).catch(
        (err) => logger.error("Title generation error", { error: err }),
      );
    }
  }

  async generateChatSummary(
    chatId: string,
    messages: UIMessage[],
    existingSummary?: string,
  ): Promise<void> {
    if (!this.memory?.chats?.generateSummary) return;

    const config = this.memory.chats.generateSummary;
    const model = typeof config === "object" ? config.model : this.model;
    const customInstructions =
      typeof config === "object" ? config.instructions : undefined;

    const defaultInstructions = `You summarize conversations into 2-3 concise sentences that capture the key topics, decisions, and outcomes. Focus on facts that would be useful context in future conversations. Do not include greetings or pleasantries.`;

    const systemPrompt = customInstructions ?? defaultInstructions;

    const recentMessages = messages.slice(-12);
    const formattedMessages = recentMessages
      .map(
        (m: any) =>
          `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
      )
      .join("\n");

    let prompt: string;
    if (existingSummary) {
      prompt = `Previous summary:\n${existingSummary}\n\nRecent messages:\n${formattedMessages}\n\nUpdate the summary to incorporate the new messages. Return only the updated summary (2-3 sentences).`;
    } else {
      prompt = `Messages:\n${formattedMessages}\n\nSummarize this conversation. Return only the summary (2-3 sentences).`;
    }

    try {
      const { text } = await generateText({
        model,
        system: systemPrompt,
        prompt,
        temperature: 0,
      });

      await this.memory.provider?.updateChatSummary?.(chatId, text);
      logger.debug(`Generated summary for ${chatId}`, {
        chatId,
        summaryLength: text.length,
      });
    } catch (err) {
      logger.error("Summary generation LLM call failed", { error: err });
    }
  }

  async maybeGenerateChatSummary(
    context: TContext | undefined,
    messages: UIMessage[],
    existingChat?: { messageCount?: number; summary?: string },
    savedMessageCount: number = 2,
  ): Promise<void> {
    if (
      !this.memory?.chats?.enabled ||
      !this.memory?.chats?.generateSummary ||
      !context
    ) {
      return;
    }

    const { chatId } = this.extractMemoryIdentifiers(context);
    if (!chatId) return;

    const newMessageCount =
      (existingChat?.messageCount ?? 0) + savedMessageCount;

    if (newMessageCount < 6 || newMessageCount % 6 !== 0) return;

    this.generateChatSummary(chatId, messages, existingChat?.summary).catch(
      (err: unknown) =>
        logger.error("Summary generation failed", { error: err }),
    );
  }

  async generateSuggestions(
    conversationContext: string,
    conversationMessages: ModelMessage[],
    writer: UIMessageStreamWriter,
    context?: TContext,
  ): Promise<void> {
    const config = this.memory?.chats?.generateSuggestions;
    if (!config) return;

    let enabled: boolean;
    if (typeof config === "boolean") {
      enabled = config;
    } else if (typeof config.enabled === "function") {
      enabled = await config.enabled({
        messages: conversationMessages,
        context,
      });
    } else {
      enabled = config.enabled;
    }

    if (!enabled) return;

    const model =
      typeof config === "object" && config.model ? config.model : this.model;
    const limit = typeof config === "object" && config.limit ? config.limit : 5;

    const defaultInstructions = `Generate ${limit} contextual follow-up suggestions based on what was JUST discussed.

Guidelines:
1. Analyze what the assistant just showed/discussed (data, analysis, insights)
2. Suggest logical NEXT STEPS that build on this specific response
3. Keep suggestions ultra-brief (2-3 words ideal, max 5 words)
4. Use action verbs ("Show", "Compare", "Analyze", "Check", "List", "Explore")
5. Make suggestions specific to the context, not generic
6. Focus on available capabilities that provide value

Good suggestions are:
- Specific to what was just discussed
- Actionable using available capabilities
- Brief and clear (2-3 words)
- Natural next steps, not repetitive`;

    const instructions =
      typeof config === "object" && config.instructions
        ? config.instructions
        : defaultInstructions;

    try {
      const suggestionsSchema = z.object({
        prompts: z
          .array(z.string().max(40))
          .min(3)
          .max(limit)
          .describe(`Array of prompt suggestions (2-5 words each)`),
      });

      const { object } = await generateObject({
        model,
        system: instructions,
        prompt: conversationContext,
        schema: suggestionsSchema,
      });

      const { prompts } = object;

      writeSuggestions(writer, prompts);
    } catch (err) {
      logger.error("Suggestion generation failed", { error: err });
    }
  }

  createWorkingMemoryTool() {
    const scope = this.memory?.workingMemory?.scope || "chat";
    const memory = this.memory;
    const extractMemoryIdentifiers = this.extractMemoryIdentifiers.bind(this);

    return tool({
      description: `Save user information to persistent memory for future conversations.`,
      inputSchema: z.object({
        content: z
          .string()
          .describe(
            "Updated working memory content in markdown format. Include user preferences and any important facts to remember.",
          ),
      }),
      execute: async ({ content }, options) => {
        logger.debug("updateWorkingMemory tool called", {
          contentLength: content.length,
        });

        if (!memory?.provider) {
          logger.warn("Memory provider not configured");
          return "Memory system not configured";
        }

        const { getContext } = await import("./context.js");
        const ctx = getContext(
          options as { experimental_context?: Record<string, unknown> },
        );
        const contextData = ctx as TContext | undefined;

        if (!contextData) {
          logger.warn("Context not available for working memory update");
          return "Context not available";
        }

        const { chatId, userId } = extractMemoryIdentifiers(contextData);
        logger.debug("Updating working memory", { chatId, userId, scope });

        try {
          await memory.provider.updateWorkingMemory({
            chatId,
            userId,
            scope,
            content,
          });
          logger.debug("Working memory updated successfully");
          return "success";
        } catch (error) {
          logger.error("Failed to update working memory", {
            error: error instanceof Error ? error.message : error,
          });
          return "error";
        }
      },
    });
  }

  getWorkingMemoryInstructions(): string {
    if (!this.memory?.workingMemory?.enabled) return "";
    return getWorkingMemoryInstructions(
      this.memory.workingMemory.template || DEFAULT_TEMPLATE,
    );
  }

  get historyEnabled(): boolean {
    return this.memory?.history?.enabled ?? false;
  }

  get chatsEnabled(): boolean {
    return this.memory?.chats?.enabled ?? false;
  }

  get workingMemoryEnabled(): boolean {
    return this.memory?.workingMemory?.enabled ?? false;
  }

  get memoryConfig(): MemoryConfig | undefined {
    return this.memory;
  }
}
