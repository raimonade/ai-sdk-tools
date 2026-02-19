# @raimonade/memory

Persistent memory system for AI agents with built-in providers for development and production.

## Features

- **Simple API** - Just 4 methods to implement
- **Built-in Providers** - InMemory, Drizzle ORM, Redis, and Upstash included
- **TypeScript-first** - Full type safety
- **Flexible Scopes** - Chat-level or user-level memory
- **Conversation History** - Optional message tracking
- **Database Agnostic** - Works with PostgreSQL, MySQL, and SQLite via Drizzle

## Installation

```bash
npm install @raimonade/memory
# or
yarn add @raimonade/memory
# or
pnpm add @raimonade/memory
# or
bun add @raimonade/memory
```

### Optional Dependencies

```bash
# For Drizzle ORM provider (PostgreSQL, MySQL, or SQLite)
npm install drizzle-orm

# For Kysely provider (MSSQL/Azure SQL, and others)
npm install kysely

# For Upstash Redis provider (serverless/edge)
npm install @upstash/redis

# For standard Redis provider (self-hosted/traditional)
npm install redis
# or
npm install ioredis
```

## Quick Start

### InMemory Provider (Development)

Perfect for local development - works immediately, no setup needed.

```typescript
import { InMemoryProvider } from "@raimonade/memory/in-memory";

const memory = new InMemoryProvider();

// Use with agents
const context = buildAppContext({
  // ...
  memory: {
    provider: memory,
    workingMemory: {
      enabled: true,
      scope: "chat",
    },
  },
});
```

### Drizzle Provider (Production - Any SQL Database)

Works with PostgreSQL, MySQL, and SQLite via Drizzle ORM. Perfect if you already use Drizzle in your project.

```typescript
import { drizzle } from "drizzle-orm/vercel-postgres";
import { sql } from "@vercel/postgres";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
 import { DrizzleProvider } from "@raimonade/memory/drizzle";

// Define your schema
const workingMemory = pgTable("working_memory", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  chatId: text("chat_id"),
  userId: text("user_id"),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

const messages = pgTable("conversation_messages", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  userId: text("user_id"),
  role: text("role").notNull(),
  content: text("content").notNull(),
  timestamp: timestamp("timestamp").notNull(),
});

// Initialize
const db = drizzle(sql);
const memory = new DrizzleProvider(db, {
  workingMemoryTable: workingMemory,
  messagesTable: messages,
});
```

**[Full Drizzle documentation →](./DRIZZLE.md)** - Includes PostgreSQL, MySQL, SQLite/Turso examples

### Kysely Provider (Production - MSSQL/Azure SQL)

Works with Kysely. Recommended for Azure SQL / SQL Server (store message content as JSON string in `NVARCHAR(MAX)`).

```ts
import type { Kysely } from "kysely";
import { KyselyProvider } from "@raimonade/memory/kysely";

interface DB {
  working_memory: {
    id: string;
    scope: "chat" | "user";
    chat_id: string | null;
    user_id: string | null;
    content: string;
    updated_at: Date;
  };
  conversation_messages: {
    chat_id: string;
    user_id: string | null;
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: Date;
  };
  chats: {
    chat_id: string;
    user_id: string | null;
    title: string | null;
    created_at: Date;
    updated_at: Date;
    message_count: number;
  };
}

export function createMemory(db: Kysely<DB>) {
  return new KyselyProvider(db, {
    workingMemory: {
      table: "working_memory",
      columns: {
        id: "id",
        scope: "scope",
        chatId: "chat_id",
        userId: "user_id",
        content: "content",
        updatedAt: "updated_at",
      },
    },
    messages: {
      table: "conversation_messages",
      columns: {
        chatId: "chat_id",
        userId: "user_id",
        role: "role",
        content: "content",
        timestamp: "timestamp",
      },
    },
    chats: {
      table: "chats",
      columns: {
        chatId: "chat_id",
        userId: "user_id",
        title: "title",
        createdAt: "created_at",
        updatedAt: "updated_at",
        messageCount: "message_count",
      },
    },
  });
}
```

**[Full Kysely documentation →](./KYSELY.md)**

### Redis Provider (Production - Self-Hosted)

Perfect for traditional Redis instances (self-hosted, Redis Cloud, AWS ElastiCache, etc.). Supports both `ioredis` and `redis` npm packages.

**With ioredis:**

```typescript
import Redis from "ioredis";
import { RedisProvider } from "@raimonade/memory/redis";

const redis = new Redis(process.env.REDIS_URL);
const memory = new RedisProvider(redis);
```

**With redis package:**

```typescript
import { createClient } from "redis";
import { RedisProvider } from "@raimonade/memory/redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const memory = new RedisProvider(redis, {
  prefix: "my-app:memory:",
  messageTtl: 60 * 60 * 24 * 30, // Optional: 30 days TTL for messages (default: no expiration)
});
```

### Upstash Provider (Production - Serverless)

Perfect for edge and serverless environments. Uses HTTP REST API instead of direct TCP connection.

```typescript
import { Redis } from "@upstash/redis";
import { UpstashProvider } from "@raimonade/memory/upstash";

const redis = Redis.fromEnv();
const memory = new UpstashProvider(redis, {
  prefix: "my-app:memory:",
  messageTtl: 60 * 60 * 24 * 30, // Optional: 30 days TTL for messages (default: no expiration)
});
```

**When to use Redis vs Upstash:**
- **Redis Provider**: Use when you have a traditional Redis instance (self-hosted, Redis Cloud, AWS ElastiCache, etc.)
- **Upstash Provider**: Use for serverless/edge environments where HTTP REST API is preferred

## Usage with Agents

```typescript
import { InMemoryProvider } from "@raimonade/memory";

const appContext = buildAppContext({
  userId: "user-123",
  // ... other context
  metadata: {
    chatId: "chat_abc123",
    userId: "user-123",
  },
  memory: {
    provider: new InMemoryProvider(),
    workingMemory: {
      enabled: true,
      scope: "chat", // or 'user'
      template: `# Working Memory

## Key Facts
- [Important information]

## Preferences
- [User preferences]
`,
    },
    history: {
      enabled: true,
      limit: 10,
    },
  },
});

// Agent automatically:
// 1. Loads working memory into system prompt
// 2. Injects updateWorkingMemory tool
// 3. Captures conversation messages
```

## Memory Scopes

### Chat Scope (Recommended)

Memory is tied to a specific conversation.

```typescript
workingMemory: {
  enabled: true,
  scope: 'chat',
}
```

### User Scope

Memory persists across all conversations for a user.

```typescript
workingMemory: {
  enabled: true,
  scope: 'user',
}
```

## Custom Provider

Implement the `MemoryProvider` interface:

```typescript
import type {
  MemoryProvider,
  WorkingMemory,
  ConversationMessage,
  MemoryScope,
} from "@raimonade/memory";

class MyProvider implements MemoryProvider {
  async getWorkingMemory(params: {
    chatId?: string;
    userId?: string;
    scope: MemoryScope;
  }): Promise<WorkingMemory | null> {
    // Your implementation
  }

  async updateWorkingMemory(params: {
    chatId?: string;
    userId?: string;
    scope: MemoryScope;
    content: string;
  }): Promise<void> {
    // Your implementation
  }

  // Optional methods
  async saveMessage(message: ConversationMessage): Promise<void> {
    // Your implementation
  }

  async getMessages(params: {
    chatId: string;
    limit?: number;
  }): Promise<ConversationMessage[]> {
    // Your implementation
  }
}
```

## API Reference

### Types

#### `WorkingMemory`

```typescript
interface WorkingMemory {
  content: string;
  updatedAt: Date;
}
```

#### `MemoryScope`

```typescript
type MemoryScope = "chat" | "user";
```

#### `ConversationMessage`

```typescript
interface ConversationMessage {
  chatId: string;
  userId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}
```

#### `MemoryProvider`

```typescript
interface MemoryProvider {
  getWorkingMemory(params: {
    chatId?: string;
    userId?: string;
    scope: MemoryScope;
  }): Promise<WorkingMemory | null>;

  updateWorkingMemory(params: {
    chatId?: string;
    userId?: string;
    scope: MemoryScope;
    content: string;
  }): Promise<void>;

  saveMessage?(message: ConversationMessage): Promise<void>;

  getMessages?(params: {
    chatId: string;
    limit?: number;
  }): Promise<ConversationMessage[]>;
}
```

## License

MIT
