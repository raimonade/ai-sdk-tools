/**
 * ai-sdk-tools - Complete toolkit for building AI applications
 *
 * This package provides direct access to all AI SDK tools:
 * - agents: Multi-agent orchestration with handoffs and routing
 * - artifacts: Structured artifact streaming for React components
 * - cache: Universal caching for AI tool executions
 * - devtools: Development and debugging tools
 * - memory: Persistent memory system for AI agents
 * - store: Zustand-based state management for AI applications
 *
 * @example
 * ```typescript
 * import { Agent, artifact, cached, useChat, AIDevtools } from 'ai-sdk-tools';
 *
 * // Create an agent
 * const myAgent = new Agent({ ... });
 *
 * // Create an artifact
 * const myArtifact = artifact({ ... });
 *
 * // Cache a tool
 * const cachedTool = cached(tool, { ttl: 3600 });
 * ```
 */

// Re-export everything from all packages
export * from "@raimonade/agents";
export * from "@raimonade/artifacts";
export * from "@raimonade/cache";
export * from "@raimonade/devtools";
export * from "@raimonade/memory";
export * from "@raimonade/store";
