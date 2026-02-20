# Kysely Provider (Azure SQL / MSSQL)

This package exports a Kysely-backed provider at `@raimonade/memory/kysely`.

## Install

```bash
bun add @raimonade/memory kysely
```

## Usage

```ts
import type { Kysely } from "kysely";
import { KyselyProvider } from "@raimonade/memory/kysely";

// Your Kysely Database type.
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
    content: string; // JSON string, use NVARCHAR(MAX)
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
    // Optional: if your MSSQL driver returns strings for DATETIME2.
    // parse: {
    //   date: (v, field) => {
    //     if (v instanceof Date) return v
    //     if (typeof v === 'string' || typeof v === 'number') {
    //       const d = new Date(v)
    //       if (!Number.isNaN(d.getTime())) return d
    //     }
    //     throw new Error(`bad date for ${field}`)
    //   }
    // }
  });
}
```

## Behavior notes

- Working memory key is computed as `"chat:<chatId>"` or `"user:<userId>"`.
- If `scope === "chat"` and `chatId` missing/blank: throws.
- If `scope === "user"` and `userId` missing/blank: throws.
- `getMessages` sorts by `timestamp DESC`, tie-breaks assistant last, then reverses to chronological.
- Message `content` is stored as a string; if it looks like JSON, it is parsed on read.

## SQL Server reference schema

The provider is mapping-driven; you can use any names as long as you map them.
This is one suggested schema.

```sql
-- working memory
create table working_memory (
  id nvarchar(300) not null primary key,
  scope nvarchar(16) not null,
  chat_id nvarchar(255) null,
  user_id nvarchar(255) null,
  content nvarchar(max) not null,
  updated_at datetime2 not null
);

-- messages
create table conversation_messages (
  id bigint identity(1,1) not null primary key,
  chat_id nvarchar(255) not null,
  user_id nvarchar(255) null,
  role nvarchar(16) not null,
  content nvarchar(max) not null,
  timestamp datetime2 not null
);

create index ix_conversation_messages_chat_ts
  on conversation_messages(chat_id, timestamp desc);

-- chats
create table chats (
  chat_id nvarchar(255) not null primary key,
  user_id nvarchar(255) null,
  title nvarchar(512) null,
  created_at datetime2 not null,
  updated_at datetime2 not null,
  message_count int not null
);

create index ix_chats_user_updated
  on chats(user_id, updated_at desc);
```
