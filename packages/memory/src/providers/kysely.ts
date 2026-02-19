import { sql } from "kysely";
import type { Kysely } from "kysely";
import type {
  ChatSession,
  ConversationMessage,
  MemoryProvider,
  MemoryScope,
  UIMessage,
  WorkingMemory,
} from "../types.js";

type TableName<DB> = Extract<keyof DB, string>;
type ColumnName<DB, TTable extends TableName<DB>> = Extract<keyof DB[TTable], string>;

export interface KyselyWorkingMemoryMapping<
  DB,
  TTable extends TableName<DB>
> {
  table: TTable;
  columns: {
    id: ColumnName<DB, TTable>;
    scope: ColumnName<DB, TTable>;
    chatId: ColumnName<DB, TTable>;
    userId: ColumnName<DB, TTable>;
    content: ColumnName<DB, TTable>;
    updatedAt: ColumnName<DB, TTable>;
  };
}

export interface KyselyMessagesMapping<DB, TTable extends TableName<DB>> {
  table: TTable;
  columns: {
    chatId: ColumnName<DB, TTable>;
    userId: ColumnName<DB, TTable>;
    role: ColumnName<DB, TTable>;
    content: ColumnName<DB, TTable>;
    timestamp: ColumnName<DB, TTable>;
  };
}

export interface KyselyChatsMapping<DB, TTable extends TableName<DB>> {
  table: TTable;
  columns: {
    chatId: ColumnName<DB, TTable>;
    userId: ColumnName<DB, TTable>;
    title: ColumnName<DB, TTable>;
    createdAt: ColumnName<DB, TTable>;
    updatedAt: ColumnName<DB, TTable>;
    messageCount: ColumnName<DB, TTable>;
  };
}

export interface KyselyProviderConfig<
  DB,
  TWorkingMemory extends TableName<DB>,
  TMessages extends TableName<DB>,
  TChats extends TableName<DB> = TableName<DB>
> {
  workingMemory: KyselyWorkingMemoryMapping<DB, TWorkingMemory>;
  messages: KyselyMessagesMapping<DB, TMessages>;
  chats?: KyselyChatsMapping<DB, TChats>;
  now?: () => Date;
  json?: {
    stringify: (value: unknown) => string;
    parse: (value: string) => unknown;
  };
  parse?: {
    date?: (value: unknown, field: string) => Date;
  };
}

/**
 * Kysely provider - designed for MSSQL/Azure SQL, mostly dialect-agnostic.
 *
 * Notes:
 * - Store message content as JSON string (e.g. NVARCHAR(MAX) in SQL Server).
 * - Throws on missing chatId/userId for the selected scope.
 */
export class KyselyProvider<
  DB,
  TWorkingMemory extends TableName<DB>,
  TMessages extends TableName<DB>,
  TChats extends TableName<DB> = TableName<DB>
> implements MemoryProvider
{
  private readonly now: () => Date;
  private readonly json: {
    stringify: (value: unknown) => string;
    parse: (value: string) => unknown;
  };

  constructor(
    private readonly db: Kysely<DB>,
    private readonly config: KyselyProviderConfig<
      DB,
      TWorkingMemory,
      TMessages,
      TChats
    >
  ) {
    this.now = config.now ?? (() => new Date());
    this.json = config.json ?? {
      stringify: (value) => JSON.stringify(value),
      parse: (value) => JSON.parse(value),
    };
  }

  async getWorkingMemory(params: {
    chatId?: string;
    userId?: string;
    scope: MemoryScope;
  }): Promise<WorkingMemory | null> {
    const id = getRequiredScopeId(params.scope, params.chatId, params.userId);
    const { table, columns } = this.config.workingMemory;

    const { rows } = await sql<{ content: unknown; updatedAt: unknown }>
      `select ${sql.ref(columns.content)} as content, ${sql.ref(
        columns.updatedAt
      )} as updatedAt from ${sql.table(table)} where ${sql.ref(columns.id)} = ${id}`
      .execute(this.db);

    const row = rows[0];

    if (!row) return null;

    return {
      content: typeof row.content === "string" ? row.content : String(row.content),
      updatedAt: this.parseDate(row.updatedAt, "workingMemory.updatedAt"),
    };
  }

  async updateWorkingMemory(params: {
    chatId?: string;
    userId?: string;
    scope: MemoryScope;
    content: string;
  }): Promise<void> {
    const id = getRequiredScopeId(params.scope, params.chatId, params.userId);
    const { table, columns } = this.config.workingMemory;
    const now = this.now();

    await this.db.transaction().execute(async (trx) => {
      const updated = await rawUpdateById(trx, table, columns.id, id, [
        [columns.content, params.content],
        [columns.updatedAt, now],
      ]);

      if (updated) return;

      try {
        await rawInsert(trx, table, [
          columns.id,
          columns.scope,
          columns.chatId,
          columns.userId,
          columns.content,
          columns.updatedAt,
        ], [
          id,
          params.scope,
          params.chatId ?? null,
          params.userId ?? null,
          params.content,
          now,
        ]);
      } catch (err) {
        const updatedRetry = await rawUpdateById(trx, table, columns.id, id, [
          [columns.content, params.content],
          [columns.updatedAt, now],
        ]);

        if (updatedRetry) return;
        throw err;
      }
    });
  }

  async saveMessage(message: ConversationMessage): Promise<void> {
    assertNonBlank("chatId", message.chatId);

    const { table, columns } = this.config.messages;
    const storedContent = stringifyContent(message.content, this.json.stringify);

    await rawInsert(this.db, table, [
      columns.chatId,
      columns.userId,
      columns.role,
      columns.content,
      columns.timestamp,
    ], [
      message.chatId,
      message.userId ?? null,
      message.role,
      storedContent,
      message.timestamp,
    ]);
  }

  async getMessages<T = UIMessage>(params: {
    chatId: string;
    userId?: string;
    limit?: number;
  }): Promise<T[]> {
    assertNonBlank("chatId", params.chatId);

    const { table, columns } = this.config.messages;
    const limit = params.limit ?? 100;

    const whereSql = params.userId
      ? sql`${sql.ref(columns.chatId)} = ${params.chatId} and (${sql.ref(
          columns.userId
        )} = ${params.userId} or ${sql.ref(columns.userId)} is null)`
      : sql`${sql.ref(columns.chatId)} = ${params.chatId}`;

    const { rows } = await sql<{
      content: unknown;
      role: unknown;
      timestamp: unknown;
    }>`select ${sql.ref(columns.content)} as content, ${sql.ref(
      columns.role
    )} as role, ${sql.ref(columns.timestamp)} as timestamp from ${sql.table(
      table
    )} where ${whereSql} order by ${sql.ref(columns.timestamp)} desc, case when ${sql.ref(
      columns.role
    )} = 'assistant' then 1 else 0 end desc offset 0 rows fetch next ${limit} rows only`.execute(
      this.db
    );

    const out: UIMessage[] = rows
      .map((row) => parseContentMaybeJson(row.content, this.json.parse))
      .reverse();

    return out;
  }

  async saveChat(chat: ChatSession): Promise<void> {
    const mapping = this.config.chats;
    if (!mapping) return;

    assertNonBlank("chatId", chat.chatId);

    const { table, columns } = mapping;

    const { rows: existingRows } = await sql<{ title: unknown }>
      `select ${sql.ref(columns.title)} as title from ${sql.table(
        table
      )} where ${sql.ref(columns.chatId)} = ${chat.chatId}`
      .execute(this.db);
    const existing = existingRows[0];

    const titleToStore = chat.title ?? existing?.title ?? null;

    await this.db.transaction().execute(async (trx) => {
      const updated = await rawUpdateById(trx, table, columns.chatId, chat.chatId, [
        [columns.userId, chat.userId ?? null],
        [columns.title, titleToStore],
        [columns.updatedAt, chat.updatedAt],
        [columns.messageCount, chat.messageCount],
      ]);

      if (updated) return;

      await rawInsert(trx, table, [
        columns.chatId,
        columns.userId,
        columns.title,
        columns.createdAt,
        columns.updatedAt,
        columns.messageCount,
      ], [
        chat.chatId,
        chat.userId ?? null,
        titleToStore,
        chat.createdAt,
        chat.updatedAt,
        chat.messageCount,
      ]);
    });
  }

  async getChats(params: {
    userId?: string;
    search?: string;
    limit?: number;
  }): Promise<ChatSession[]> {
    const mapping = this.config.chats;
    if (!mapping) return [];

    const { table, columns } = mapping;
    const limit = params.limit;

    const whereParts: ReadonlyArray<unknown> = [
      ...(params.userId
        ? [sql`${sql.ref(columns.userId)} = ${params.userId}`]
        : []),
      ...(params.search
        ? [sql`${sql.ref(columns.title)} like ${`%${params.search}%`}`]
        : []),
    ];
    const whereSql = whereParts.length
      ? sql`where ${sql.join(whereParts, sql` and `)}`
      : sql``;

    const lim = limit ?? 100;

    const { rows } = await sql<{
      chatId: unknown;
      userId: unknown;
      title: unknown;
      createdAt: unknown;
      updatedAt: unknown;
      messageCount: unknown;
    }>`select ${sql.ref(columns.chatId)} as chatId, ${sql.ref(
      columns.userId
    )} as userId, ${sql.ref(columns.title)} as title, ${sql.ref(
      columns.createdAt
    )} as createdAt, ${sql.ref(columns.updatedAt)} as updatedAt, ${sql.ref(
      columns.messageCount
    )} as messageCount from ${sql.table(table)} ${whereSql} order by ${sql.ref(
      columns.updatedAt
    )} desc offset 0 rows fetch next ${lim} rows only`.execute(this.db);

    let chats = rows.map((row) => ({
      chatId: String(row.chatId),
      userId: normalizeOptionalString(row.userId),
      title: normalizeOptionalString(row.title),
      createdAt: this.parseDate(row.createdAt, "chats.createdAt"),
      updatedAt: this.parseDate(row.updatedAt, "chats.updatedAt"),
      messageCount: toNumber(row.messageCount, "chats.messageCount"),
    }));

    if (params.search) {
      const searchLower = params.search.toLowerCase();
      chats = chats.filter((chat) =>
        chat.title?.toLowerCase().includes(searchLower)
      );
    }

    return chats;
  }

  async getChat(chatId: string): Promise<ChatSession | null> {
    const mapping = this.config.chats;
    if (!mapping) return null;

    assertNonBlank("chatId", chatId);

    const { table, columns } = mapping;

    const { rows } = await sql<{
      chatId: unknown;
      userId: unknown;
      title: unknown;
      createdAt: unknown;
      updatedAt: unknown;
      messageCount: unknown;
    }>`select ${sql.ref(columns.chatId)} as chatId, ${sql.ref(
      columns.userId
    )} as userId, ${sql.ref(columns.title)} as title, ${sql.ref(
      columns.createdAt
    )} as createdAt, ${sql.ref(columns.updatedAt)} as updatedAt, ${sql.ref(
      columns.messageCount
    )} as messageCount from ${sql.table(table)} where ${sql.ref(
      columns.chatId
    )} = ${chatId}`.execute(this.db);

    const row = rows[0];

    if (!row) return null;

    return {
      chatId: String(row.chatId),
      userId: normalizeOptionalString(row.userId),
      title: normalizeOptionalString(row.title),
      createdAt: this.parseDate(row.createdAt, "chats.createdAt"),
      updatedAt: this.parseDate(row.updatedAt, "chats.updatedAt"),
      messageCount: toNumber(row.messageCount, "chats.messageCount"),
    };
  }

  async updateChatTitle(chatId: string, title: string): Promise<void> {
    const mapping = this.config.chats;
    if (!mapping) return;

    assertNonBlank("chatId", chatId);

    const { table, columns } = mapping;
    const now = this.now();

    const updated = await rawUpdateById(this.db, table, columns.chatId, chatId, [
      [columns.title, title],
      [columns.updatedAt, now],
    ]);

    if (updated) return;

    await this.saveChat({
      chatId,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    });
  }

  async deleteChat(chatId: string): Promise<void> {
    const mapping = this.config.chats;
    assertNonBlank("chatId", chatId);

    const messages = this.config.messages;

    await this.db.transaction().execute(async (trx) => {
      await rawDeleteEquals(trx, messages.table, messages.columns.chatId, chatId);

      if (!mapping) return;

      await rawDeleteEquals(trx, mapping.table, mapping.columns.chatId, chatId);
    });
  }

  private parseDate(value: unknown, field: string): Date {
    if (this.config.parse?.date) {
      return this.config.parse.date(value, field);
    }

    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
    }

    throw new Error(`Invalid date for ${field}`);
  }
}

function getRequiredScopeId(
  scope: MemoryScope,
  chatId?: string,
  userId?: string
): string {
  if (scope === "chat") {
    assertNonBlank("chatId", chatId);
    return `chat:${chatId}`;
  }
  assertNonBlank("userId", userId);
  return `user:${userId}`;
}

function assertNonBlank(field: string, value: string | undefined): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} required`);
  }
}

function isPositiveRowCount(value: unknown): boolean {
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "number") return value > 0;
  return false;
}

function stringifyContent(
  value: unknown,
  stringify: (value: unknown) => string
): string {
  if (typeof value === "string") return value;
  return stringify(value);
}

function parseContentMaybeJson(
  value: unknown,
  parse: (value: string) => unknown
): UIMessage {
  if (typeof value === "string") {
    try {
      return parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function toNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`Invalid number for ${field}`);
}

async function rawInsert(
  executor: { getExecutor: Kysely<unknown>["getExecutor"] },
  table: string,
  columns: readonly string[],
  values: readonly unknown[]
): Promise<void> {
  const colsSql = sql.join(columns.map((c) => sql.ref(c)));
  const valsSql = sql.join(values);
  await sql`insert into ${sql.table(table)} (${colsSql}) values (${valsSql})`.execute(
    executor
  );
}

async function rawDeleteEquals(
  executor: { getExecutor: Kysely<unknown>["getExecutor"] },
  table: string,
  column: string,
  value: unknown
): Promise<void> {
  await sql`delete from ${sql.table(table)} where ${sql.ref(column)} = ${value}`.execute(
    executor
  );
}

async function rawUpdateById(
  executor: { getExecutor: Kysely<unknown>["getExecutor"] },
  table: string,
  idColumn: string,
  idValue: unknown,
  sets: ReadonlyArray<readonly [string, unknown]>
): Promise<boolean> {
  if (sets.length === 0) return false;

  const setSql = sql.join(
    sets.map(([col, val]) => sql`${sql.ref(col)} = ${val}`),
    sql`, `
  );

  const res = await sql`update ${sql.table(table)} set ${setSql} where ${sql.ref(
    idColumn
  )} = ${idValue}`.execute(executor);

  return isPositiveRowCount(res.numAffectedRows);
}
