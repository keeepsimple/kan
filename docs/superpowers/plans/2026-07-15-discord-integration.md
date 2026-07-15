# Discord Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discord bot integration for Kan — a workspace connects a Discord server; boards bind to a channel; creating a card in a `create_thread` list creates a Discord thread (tagging configured roles); moving a card into a `notify` list posts `{card title} {board name} - {user name}` into the card's thread (card creation is blocked in `notify` lists).

**Architecture:** New thin REST-client package `packages/discord` (mirrors `@kan/stripe`, zero new runtime deps — plain `fetch` against Discord API v10). One DB migration adds a `workspace_discord` table plus config columns on `board`/`list`/`card`. A new `discord` tRPC router handles connect/channels/roles. Notification calls are inserted beside the two existing webhook fire points in `packages/api/src/routers/card.ts` (same fire-and-forget pattern — Discord failures never fail card operations).

**Tech Stack:** TypeScript ESM, pnpm workspaces, Drizzle ORM (PostgreSQL), tRPC v11, Next.js pages router, react-hook-form + zod, lingui i18n, vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-discord-integration-design.md`

## Global Constraints

- No new runtime dependencies anywhere. Discord API is called with built-in `fetch`. Base URL: `https://discord.com/api/v10`, auth header `Bot ${DISCORD_BOT_TOKEN}`.
- New env vars (exact names): `DISCORD_BOT_TOKEN`, `DISCORD_BOT_CLIENT_ID`. Do NOT reuse the existing `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` (those are wired to Better Auth social login).
- Column/field spelling is **British** to match the codebase (`colourCode`): `discordBehaviour` (values `"create_thread" | "notify"`), `discordRoleIds`, `discordChannelId`, `discordThreadId`.
- Message formats (exact):
  - Thread first message: `${roleMentions} ${cardTitle} — ${boardName}` (roleMentions omitted when no roles; separator is an em-dash).
  - Move message: `${cardTitle} ${boardName} - ${userName}` (plain hyphen, per spec).
- Every Discord side-effect is fire-and-forget: wrapped in try/catch, logged via `@kan/logger`, never throws into the card mutation path.
- All new tables end with `.enableRLS()`. Public IDs (where needed) come from `generateUID()` in `@kan/shared/utils` — the `workspace_discord` table needs none (addressed via workspace).
- Repo functions: plain exported async functions taking `db: dbClient` first, in `packages/db/src/repository/*.repo.ts`.
- The working tree has pre-existing uncommitted changes (locale files, several views). **Stage only the files your task touches.**
- Run commands from the repo root `d:\kan` unless stated otherwise.

---

### Task 1: `@kan/discord` package (REST client + message builders)

**Files:**
- Create: `packages/discord/package.json`
- Create: `packages/discord/tsconfig.json`
- Create: `packages/discord/eslint.config.js` (copy of `packages/stripe/eslint.config.js`)
- Create: `packages/discord/src/index.ts`
- Create: `packages/discord/src/index.test.ts`

**Interfaces:**
- Consumes: nothing (leaf package).
- Produces (used by Tasks 4, 5): `getGuild(guildId: string)`, `getTextChannels(guildId: string)`, `getRoles(guildId: string)`, `createThread(channelId: string, name: string)`, `postMessage(channelOrThreadId: string, content: string, mentionRoleIds?: string[])`, `buildRoleMentions(roleIds: string[]): string`, `getBotInviteUrl(): string | null`, `isDiscordConfigured(): boolean`. All async functions return `Promise<{ success: boolean; data?: T; error?: string }>`.

- [ ] **Step 1: Scaffold the package**

`packages/discord/package.json`:

```json
{
  "name": "@kan/discord",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "license": "GPL-3.0",
  "scripts": {
    "build": "tsc",
    "clean": "git clean -xdf .cache .turbo dist node_modules",
    "dev": "tsc",
    "format": "prettier --check . --ignore-path ../../.gitignore",
    "lint": "eslint",
    "test": "vitest run",
    "typecheck": "tsc --noEmit --emitDeclarationOnly false"
  },
  "devDependencies": {
    "@kan/eslint-config": "workspace:*",
    "@kan/prettier-config": "workspace:*",
    "@kan/tsconfig": "workspace:*",
    "eslint": "catalog:",
    "prettier": "catalog:",
    "typescript": "catalog:",
    "vitest": "^3.0.0"
  },
  "prettier": "@kan/prettier-config"
}
```

`packages/discord/tsconfig.json`:

```json
{
  "extends": "@kan/tsconfig/internal-package.json",
  "compilerOptions": {},
  "include": ["*.ts", "src"],
  "exclude": ["node_modules"]
}
```

Copy the eslint config: `cp packages/stripe/eslint.config.js packages/discord/eslint.config.js`

Then run: `pnpm install`
Expected: lockfile updated, `@kan/discord` linked into the workspace.

- [ ] **Step 2: Write the failing test**

`packages/discord/src/index.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRoleMentions,
  createThread,
  getTextChannels,
  postMessage,
} from "./index";

const mockFetch = vi.fn();

beforeEach(() => {
  process.env.DISCORD_BOT_TOKEN = "test-token";
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
});

const jsonResponse = (data: unknown) => ({
  ok: true,
  json: () => Promise.resolve(data),
});

describe("buildRoleMentions", () => {
  it("formats role ids as Discord role mentions", () => {
    expect(buildRoleMentions(["1", "2"])).toBe("<@&1> <@&2>");
  });

  it("returns an empty string for no roles", () => {
    expect(buildRoleMentions([])).toBe("");
  });
});

describe("createThread", () => {
  it("creates a public thread with a name truncated to 100 chars", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "42", name: "x" }));

    const result = await createThread("123", "a".repeat(150));

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe("42");
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://discord.com/api/v10/channels/123/threads");
    const body = JSON.parse(call[1].body as string) as {
      name: string;
      type: number;
    };
    expect(body.name).toHaveLength(100);
    expect(body.type).toBe(11);
    expect(
      (call[1].headers as Record<string, string>).Authorization,
    ).toBe("Bot test-token");
  });

  it("returns an error without calling fetch when the bot token is missing", async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const result = await createThread("123", "test");

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns an error on a non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Missing Permissions"),
    });

    const result = await createThread("123", "test");

    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });
});

describe("postMessage", () => {
  it("sends allowed_mentions restricted to the given roles", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "1", channel_id: "42" }));

    await postMessage("42", "hello <@&7>", ["7"]);

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      content: string;
      allowed_mentions: unknown;
    };
    expect(body.content).toBe("hello <@&7>");
    expect(body.allowed_mentions).toEqual({ parse: [], roles: ["7"] });
  });

  it("defaults to no role mentions", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "1", channel_id: "42" }));

    await postMessage("42", "hello");

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [] });
  });
});

describe("getTextChannels", () => {
  it("filters to text channels (type 0) only", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { id: "1", name: "general", type: 0 },
        { id: "2", name: "voice", type: 2 },
      ]),
    );

    const result = await getTextChannels("g1");

    expect(result.data).toEqual([{ id: "1", name: "general", type: 0 }]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @kan/discord test`
Expected: FAIL — `Cannot find module './index'` (or unresolved imports).

- [ ] **Step 4: Write the implementation**

`packages/discord/src/index.ts`:

```ts
const DISCORD_API = "https://discord.com/api/v10";

// View Channels (1<<10) + Send Messages (1<<11) + Mention Everyone (1<<17)
// + Create Public Threads (1<<35) + Send Messages in Threads (1<<38)
export const BOT_PERMISSIONS = "309237779456";

export const isDiscordConfigured = () => !!process.env.DISCORD_BOT_TOKEN;

export const getBotInviteUrl = (): string | null => {
  const clientId = process.env.DISCORD_BOT_CLIENT_ID;
  if (!clientId) return null;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${BOT_PERMISSIONS}`;
};

export interface DiscordResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

export interface DiscordRole {
  id: string;
  name: string;
  managed: boolean;
}

export interface DiscordThread {
  id: string;
  name: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
}

const discordFetch = async <T>(
  path: string,
  init?: RequestInit,
): Promise<DiscordResult<T>> => {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken)
    return { success: false, error: "DISCORD_BOT_TOKEN is not set" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: `${response.status} ${body.slice(0, 300)}`,
      };
    }

    return { success: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

export const getGuild = (guildId: string) =>
  discordFetch<DiscordGuild>(`/guilds/${guildId}`);

export const getTextChannels = async (
  guildId: string,
): Promise<DiscordResult<DiscordChannel[]>> => {
  const result = await discordFetch<DiscordChannel[]>(
    `/guilds/${guildId}/channels`,
  );
  if (!result.success || !result.data) return result;
  // type 0 = guild text channel
  return { success: true, data: result.data.filter((c) => c.type === 0) };
};

export const getRoles = async (
  guildId: string,
): Promise<DiscordResult<DiscordRole[]>> => {
  const result = await discordFetch<DiscordRole[]>(`/guilds/${guildId}/roles`);
  if (!result.success || !result.data) return result;
  // Drop @everyone (same id as the guild) and bot-managed roles
  return {
    success: true,
    data: result.data.filter((r) => r.id !== guildId && !r.managed),
  };
};

export const createThread = (channelId: string, name: string) =>
  discordFetch<DiscordThread>(`/channels/${channelId}/threads`, {
    method: "POST",
    body: JSON.stringify({
      // Discord caps thread names at 100 chars
      name: name.slice(0, 100),
      type: 11, // public thread
      auto_archive_duration: 10080,
    }),
  });

export const postMessage = (
  channelOrThreadId: string,
  content: string,
  mentionRoleIds: string[] = [],
) =>
  discordFetch<DiscordMessage>(`/channels/${channelOrThreadId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [], roles: mentionRoleIds },
    }),
  });

export const buildRoleMentions = (roleIds: string[]) =>
  roleIds.map((id) => `<@&${id}>`).join(" ");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kan/discord test`
Expected: PASS (8 tests).

Run: `pnpm --filter @kan/discord typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/discord pnpm-lock.yaml
git commit -m "feat(discord): add @kan/discord REST client package"
```

---

### Task 2: DB schema + migration

**Files:**
- Create: `packages/db/src/schema/discord.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/boards.ts` (boards table, ~line 33-70)
- Modify: `packages/db/src/schema/lists.ts` (lists table, lines 17-35)
- Modify: `packages/db/src/schema/cards.ts` (cards table, ~line 58-87)
- Create (generated): `packages/db/migrations/<timestamp>_AddDiscordIntegration.sql`

**Interfaces:**
- Consumes: existing `workspaces`, `users` schema tables.
- Produces (used by Tasks 3+): table `workspaceDiscord` (columns `id`, `workspaceId`, `guildId`, `guildName`, `createdBy`, `createdAt`); `boards.discordChannelId: varchar(32) | null`; `lists.discordBehaviour: varchar(16) | null`, `lists.discordRoleIds: text | null` (JSON string array); `cards.discordThreadId: varchar(32) | null`; exported const `discordBehaviours = ["create_thread", "notify"]`.

- [ ] **Step 1: Create the schema file**

`packages/db/src/schema/discord.ts`:

```ts
import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { workspaces } from "./workspaces";

export const discordBehaviours = ["create_thread", "notify"] as const;
export type DiscordBehaviour = (typeof discordBehaviours)[number];

export const workspaceDiscord = pgTable("workspace_discord", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceId: bigint("workspaceId", { mode: "number" })
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  guildId: varchar("guildId", { length: 32 }).notNull(),
  guildName: varchar("guildName", { length: 255 }),
  createdBy: uuid("createdBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}).enableRLS();

export const workspaceDiscordRelations = relations(
  workspaceDiscord,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceDiscord.workspaceId],
      references: [workspaces.id],
    }),
  }),
);
```

- [ ] **Step 2: Export it and add the columns**

In `packages/db/src/schema/index.ts`, add one line (keep alphabetical-ish placement near the end):

```ts
export * from "./discord";
```

In `packages/db/src/schema/boards.ts`, inside the `boards` table column object, after `sourceBoardId`:

```ts
    discordChannelId: varchar("discordChannelId", { length: 32 }),
```

In `packages/db/src/schema/lists.ts`, add `text` to the `drizzle-orm/pg-core` import, then inside the `lists` table after `importId`:

```ts
  discordBehaviour: varchar("discordBehaviour", { length: 16 }),
  discordRoleIds: text("discordRoleIds"), // JSON array of Discord role ids
```

In `packages/db/src/schema/cards.ts`, inside the `cards` table after `dueDate`:

```ts
    discordThreadId: varchar("discordThreadId", { length: 32 }),
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @kan/db with-env drizzle-kit generate --name AddDiscordIntegration`
(If `with-env` fails because there is no root `.env`, run `npx drizzle-kit generate --name AddDiscordIntegration` from `packages/db` — generate does not need a DB connection.)

Expected: a new file `packages/db/migrations/<timestamp>_AddDiscordIntegration.sql` containing statements equivalent to:

```sql
CREATE TABLE "workspace_discord" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "workspaceId" bigint NOT NULL,
  "guildId" varchar(32) NOT NULL,
  "guildName" varchar(255),
  "createdBy" uuid NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_discord_workspaceId_unique" UNIQUE("workspaceId")
);--> statement-breakpoint
ALTER TABLE "workspace_discord" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "discordChannelId" varchar(32);--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "discordBehaviour" varchar(16);--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "discordRoleIds" text;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "discordThreadId" varchar(32);
```

plus the two FK `ALTER TABLE ... ADD CONSTRAINT` statements. Read the generated SQL and confirm no unrelated tables are touched.

- [ ] **Step 4: Verify typecheck (and apply if a DB is available)**

Run: `pnpm --filter @kan/db typecheck`
Expected: exit 0.

Optional (needs a running Postgres + root `.env`): `pnpm --filter @kan/db migrate`
Expected: migration applies cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema packages/db/migrations
git commit -m "feat(discord): add workspace_discord table and board/list/card config columns"
```

---

### Task 3: `discord.repo.ts` + extend the repo reads the hooks need

**Files:**
- Create: `packages/db/src/repository/discord.repo.ts`
- Modify: `packages/db/src/repository/list.repo.ts` — `getWorkspaceAndListIdByListPublicId` (lines 417-446) and `getByPublicId` (lines 208-219)
- Modify: `packages/db/src/repository/card.repo.ts` — `getByPublicId` (lines 253-273)

**Interfaces:**
- Consumes: Task 2 schema (`workspaceDiscord`, new columns).
- Produces (used by Tasks 4-6):
  - `discordRepo.getByWorkspaceId(db, workspaceId: number)` → `{ id, workspaceId, guildId, guildName, createdBy, createdAt } | undefined`
  - `discordRepo.create(db, { workspaceId, guildId, guildName, createdBy })` → upserts on `workspaceId`
  - `discordRepo.deleteByWorkspaceId(db, workspaceId: number)` → void
  - `discordRepo.setCardDiscordThreadId(db, cardId: number, threadId: string)` → void
  - `discordRepo.getBoardDiscordChannelId(db, boardId: number)` → `string | null`
  - `listRepo.getWorkspaceAndListIdByListPublicId` return gains `discordBehaviour`, `discordRoleIds`, `boardDiscordChannelId`
  - `listRepo.getByPublicId` return gains `discordBehaviour`
  - `cardRepo.getByPublicId` return gains `discordThreadId`

- [ ] **Step 1: Create the repo**

`packages/db/src/repository/discord.repo.ts`:

```ts
import { eq } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { boards, cards, workspaceDiscord } from "@kan/db/schema";

export const getByWorkspaceId = (db: dbClient, workspaceId: number) => {
  return db.query.workspaceDiscord.findFirst({
    where: eq(workspaceDiscord.workspaceId, workspaceId),
  });
};

export const create = async (
  db: dbClient,
  input: {
    workspaceId: number;
    guildId: string;
    guildName: string | null;
    createdBy: string;
  },
) => {
  const [result] = await db
    .insert(workspaceDiscord)
    .values(input)
    .onConflictDoUpdate({
      target: workspaceDiscord.workspaceId,
      set: { guildId: input.guildId, guildName: input.guildName },
    })
    .returning();

  return result;
};

export const deleteByWorkspaceId = async (
  db: dbClient,
  workspaceId: number,
) => {
  await db
    .delete(workspaceDiscord)
    .where(eq(workspaceDiscord.workspaceId, workspaceId));
};

export const setCardDiscordThreadId = async (
  db: dbClient,
  cardId: number,
  threadId: string,
) => {
  await db
    .update(cards)
    .set({ discordThreadId: threadId })
    .where(eq(cards.id, cardId));
};

export const getBoardDiscordChannelId = async (
  db: dbClient,
  boardId: number,
) => {
  const board = await db.query.boards.findFirst({
    columns: { discordChannelId: true },
    where: eq(boards.id, boardId),
  });

  return board?.discordChannelId ?? null;
};
```

- [ ] **Step 2: Extend the three existing reads**

In `packages/db/src/repository/list.repo.ts`, `getWorkspaceAndListIdByListPublicId` (line 417):
- `columns`: change to `{ id: true, name: true, createdBy: true, discordBehaviour: true, discordRoleIds: true }`
- board `columns`: change to `{ publicId: true, workspaceId: true, name: true, discordChannelId: true }`
- returned object: add three fields —

```ts
        discordBehaviour: result.discordBehaviour,
        discordRoleIds: result.discordRoleIds,
        boardDiscordChannelId: result.board.discordChannelId,
```

In the same file, `getByPublicId` (line 208): add `discordBehaviour: true,` to `columns`.

In `packages/db/src/repository/card.repo.ts`, `getByPublicId` (line 253): add `discordThreadId: true,` to `columns`.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @kan/db typecheck && pnpm --filter @kan/api typecheck`
Expected: both exit 0 (the api package consumes the widened return types — additive, so no breakage).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/repository/discord.repo.ts packages/db/src/repository/list.repo.ts packages/db/src/repository/card.repo.ts
git commit -m "feat(discord): add discord repo and expose discord config in list/card reads"
```

---

### Task 4: Notification orchestrator in `packages/api` (+ card-creation guard)

**Files:**
- Modify: `packages/api/package.json` (add dependency)
- Create: `packages/api/src/utils/discord.ts`
- Create: `packages/api/src/utils/discord.test.ts`

**Interfaces:**
- Consumes: `@kan/discord` (Task 1), `discord.repo` (Task 3), `createLogger` from `@kan/logger`.
- Produces (used by Task 6):
  - `parseRoleIds(raw: string | null | undefined): string[]`
  - `assertListAllowsCardCreation(list: { discordBehaviour?: string | null }): void` — throws `TRPCError` `BAD_REQUEST` when behaviour is `"notify"`
  - `notifyCardCreated(db, args: { cardId: number; cardTitle: string; boardName: string; workspaceId: number; discordChannelId: string | null; discordBehaviour: string | null; discordRoleIds: string | null }): Promise<void>`
  - `notifyCardMoved(db, args: { cardTitle: string; boardName: string; userName: string | null; workspaceId: number; newListDiscordBehaviour: string | null | undefined; cardDiscordThreadId: string | null | undefined; newListBoardId: number }): Promise<void>`

- [ ] **Step 1: Add the workspace dependency**

In `packages/api/package.json` `dependencies`, add:

```json
    "@kan/discord": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

`packages/api/src/utils/discord.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@kan/discord", () => ({
  createThread: vi.fn(),
  postMessage: vi.fn(),
  buildRoleMentions: (ids: string[]) =>
    ids.map((id) => `<@&${id}>`).join(" "),
}));

vi.mock("@kan/db/repository/discord.repo", () => ({
  getByWorkspaceId: vi.fn(),
  setCardDiscordThreadId: vi.fn(),
  getBoardDiscordChannelId: vi.fn(),
}));

vi.mock("@kan/logger", () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import * as discordClient from "@kan/discord";
import * as discordRepo from "@kan/db/repository/discord.repo";

import {
  assertListAllowsCardCreation,
  notifyCardCreated,
  notifyCardMoved,
  parseRoleIds,
} from "./discord";

const mockDb = {} as Parameters<typeof notifyCardCreated>[0];

const mockCreateThread = discordClient.createThread as ReturnType<
  typeof vi.fn
>;
const mockPostMessage = discordClient.postMessage as ReturnType<typeof vi.fn>;
const mockGetByWorkspaceId = discordRepo.getByWorkspaceId as ReturnType<
  typeof vi.fn
>;
const mockSetThreadId = discordRepo.setCardDiscordThreadId as ReturnType<
  typeof vi.fn
>;
const mockGetBoardChannel = discordRepo.getBoardDiscordChannelId as ReturnType<
  typeof vi.fn
>;

const connection = { id: 1, workspaceId: 7, guildId: "g1" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseRoleIds", () => {
  it("parses a JSON string array", () => {
    expect(parseRoleIds('["1","2"]')).toEqual(["1", "2"]);
  });

  it("returns [] for null, invalid JSON, and non-arrays", () => {
    expect(parseRoleIds(null)).toEqual([]);
    expect(parseRoleIds("not json")).toEqual([]);
    expect(parseRoleIds('{"a":1}')).toEqual([]);
  });
});

describe("assertListAllowsCardCreation", () => {
  it("throws BAD_REQUEST for notify lists", () => {
    expect(() =>
      assertListAllowsCardCreation({ discordBehaviour: "notify" }),
    ).toThrowError(/notify/i);
  });

  it("passes for create_thread and unconfigured lists", () => {
    expect(() =>
      assertListAllowsCardCreation({ discordBehaviour: "create_thread" }),
    ).not.toThrow();
    expect(() =>
      assertListAllowsCardCreation({ discordBehaviour: null }),
    ).not.toThrow();
  });
});

describe("notifyCardCreated", () => {
  const args = {
    cardId: 5,
    cardTitle: "Fix login",
    boardName: "Sprint 1",
    workspaceId: 7,
    discordChannelId: "chan1",
    discordBehaviour: "create_thread",
    discordRoleIds: '["r1"]',
  };

  it("creates a thread, saves the thread id, and posts the first message with role mentions", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockCreateThread.mockResolvedValue({
      success: true,
      data: { id: "t9", name: "Fix login" },
    });
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardCreated(mockDb, args);

    expect(mockCreateThread).toHaveBeenCalledWith("chan1", "Fix login");
    expect(mockSetThreadId).toHaveBeenCalledWith(mockDb, 5, "t9");
    expect(mockPostMessage).toHaveBeenCalledWith(
      "t9",
      "<@&r1> Fix login — Sprint 1",
      ["r1"],
    );
  });

  it("does nothing when the list is not a create_thread list", async () => {
    await notifyCardCreated(mockDb, { ...args, discordBehaviour: null });
    expect(mockGetByWorkspaceId).not.toHaveBeenCalled();
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it("does nothing when the board has no channel", async () => {
    await notifyCardCreated(mockDb, { ...args, discordChannelId: null });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it("does nothing when the workspace is not connected", async () => {
    mockGetByWorkspaceId.mockResolvedValue(undefined);
    await notifyCardCreated(mockDb, args);
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it("logs and does not save when thread creation fails", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockCreateThread.mockResolvedValue({ success: false, error: "403" });

    await notifyCardCreated(mockDb, args);

    expect(mockSetThreadId).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

describe("notifyCardMoved", () => {
  const args = {
    cardTitle: "Fix login",
    boardName: "Sprint 1",
    userName: "An",
    workspaceId: 7,
    newListDiscordBehaviour: "notify",
    cardDiscordThreadId: "t9",
    newListBoardId: 3,
  };

  it("posts the move message into the card's thread", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardMoved(mockDb, args);

    expect(mockPostMessage).toHaveBeenCalledWith("t9", "Fix login Sprint 1 - An");
  });

  it("falls back to the board channel when the card has no thread", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockGetBoardChannel.mockResolvedValue("chan1");
    mockPostMessage.mockResolvedValue({ success: true, data: { id: "m1" } });

    await notifyCardMoved(mockDb, { ...args, cardDiscordThreadId: null });

    expect(mockGetBoardChannel).toHaveBeenCalledWith(mockDb, 3);
    expect(mockPostMessage).toHaveBeenCalledWith(
      "chan1",
      "Fix login Sprint 1 - An",
    );
  });

  it("does nothing when the target list is not a notify list", async () => {
    await notifyCardMoved(mockDb, {
      ...args,
      newListDiscordBehaviour: "create_thread",
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("does nothing when no thread and no board channel exist", async () => {
    mockGetByWorkspaceId.mockResolvedValue(connection);
    mockGetBoardChannel.mockResolvedValue(null);

    await notifyCardMoved(mockDb, { ...args, cardDiscordThreadId: null });

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kan/api test src/utils/discord.test.ts`
Expected: FAIL — cannot resolve `./discord`.

- [ ] **Step 4: Write the implementation**

`packages/api/src/utils/discord.ts`:

```ts
import { TRPCError } from "@trpc/server";

import type { dbClient } from "@kan/db/client";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as discordClient from "@kan/discord";
import { createLogger } from "@kan/logger";

const log = createLogger("discord");

export const parseRoleIds = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
};

/** Discord notify lists only receive moved cards — direct creation is blocked. */
export const assertListAllowsCardCreation = (list: {
  discordBehaviour?: string | null;
}) => {
  if (list.discordBehaviour === "notify") {
    throw new TRPCError({
      message:
        "Cards cannot be created directly in a Discord notify list — move a card into it instead",
      code: "BAD_REQUEST",
    });
  }
};

export const notifyCardCreated = async (
  db: dbClient,
  args: {
    cardId: number;
    cardTitle: string;
    boardName: string;
    workspaceId: number;
    discordChannelId: string | null;
    discordBehaviour: string | null;
    discordRoleIds: string | null;
  },
): Promise<void> => {
  try {
    if (args.discordBehaviour !== "create_thread" || !args.discordChannelId)
      return;

    const connection = await discordRepo.getByWorkspaceId(
      db,
      args.workspaceId,
    );
    if (!connection) return;

    const thread = await discordClient.createThread(
      args.discordChannelId,
      args.cardTitle,
    );
    if (!thread.success || !thread.data) {
      log.error(
        { error: thread.error, cardId: args.cardId },
        "Failed to create Discord thread",
      );
      return;
    }

    await discordRepo.setCardDiscordThreadId(db, args.cardId, thread.data.id);

    const roleIds = parseRoleIds(args.discordRoleIds);
    const mentions = discordClient.buildRoleMentions(roleIds);
    const content = `${mentions ? `${mentions} ` : ""}${args.cardTitle} — ${args.boardName}`;

    const message = await discordClient.postMessage(
      thread.data.id,
      content,
      roleIds,
    );
    if (!message.success) {
      log.error(
        { error: message.error, cardId: args.cardId },
        "Failed to post Discord thread message",
      );
    }
  } catch (error) {
    log.error(
      { err: error, cardId: args.cardId },
      "Discord notifyCardCreated failed",
    );
  }
};

export const notifyCardMoved = async (
  db: dbClient,
  args: {
    cardTitle: string;
    boardName: string;
    userName: string | null;
    workspaceId: number;
    newListDiscordBehaviour: string | null | undefined;
    cardDiscordThreadId: string | null | undefined;
    newListBoardId: number;
  },
): Promise<void> => {
  try {
    if (args.newListDiscordBehaviour !== "notify") return;

    const connection = await discordRepo.getByWorkspaceId(
      db,
      args.workspaceId,
    );
    if (!connection) return;

    let targetId = args.cardDiscordThreadId ?? null;
    if (!targetId) {
      // Card was created in a plain list and has no thread — fall back to the board channel
      targetId = await discordRepo.getBoardDiscordChannelId(
        db,
        args.newListBoardId,
      );
    }
    if (!targetId) return;

    const content = `${args.cardTitle} ${args.boardName} - ${args.userName ?? "unknown"}`;

    const result = await discordClient.postMessage(targetId, content);
    if (!result.success) {
      log.error({ error: result.error }, "Failed to post Discord move message");
    }
  } catch (error) {
    log.error({ err: error }, "Discord notifyCardMoved failed");
  }
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kan/api test src/utils/discord.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/package.json packages/api/src/utils/discord.ts packages/api/src/utils/discord.test.ts pnpm-lock.yaml
git commit -m "feat(discord): add discord notification orchestrator and card-creation guard"
```

---

### Task 5: `discord` tRPC router + registration + env docs

**Files:**
- Create: `packages/api/src/routers/discord.ts`
- Modify: `packages/api/src/root.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `@kan/discord` (Task 1), `discord.repo` (Task 3), `assertPermission` from `../utils/permissions`, `workspaceRepo.getByPublicId`.
- Produces (used by Tasks 8-10): tRPC procedures `api.discord.getStatus`, `api.discord.connect`, `api.discord.disconnect`, `api.discord.listChannels`, `api.discord.listRoles` — input/output shapes exactly as coded below.

- [ ] **Step 1: Write the router**

`packages/api/src/routers/discord.ts`:

```ts
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as discordRepo from "@kan/db/repository/discord.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import * as discordClient from "@kan/discord";

import type { Permission } from "../utils/permissions";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { assertPermission } from "../utils/permissions";

const workspaceInput = z.object({ workspacePublicId: z.string().min(12) });

async function getAuthorizedWorkspace(
  ctx: { db: dbClient; user: { id: string } | null | undefined },
  workspacePublicId: string,
  permission: Permission,
) {
  const userId = ctx.user?.id;

  if (!userId)
    throw new TRPCError({
      message: "User not authenticated",
      code: "UNAUTHORIZED",
    });

  const workspace = await workspaceRepo.getByPublicId(
    ctx.db,
    workspacePublicId,
  );

  if (!workspace)
    throw new TRPCError({
      message: "Workspace not found",
      code: "NOT_FOUND",
    });

  await assertPermission(ctx.db, userId, workspace.id, permission);

  return { workspace, userId };
}

export const discordRouter = createTRPCRouter({
  getStatus: protectedProcedure
    .input(workspaceInput)
    .output(
      z.object({
        connected: z.boolean(),
        guildId: z.string().nullable(),
        guildName: z.string().nullable(),
        inviteUrl: z.string().nullable(),
        botConfigured: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "board:view",
      );

      const connection = await discordRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      return {
        connected: !!connection,
        guildId: connection?.guildId ?? null,
        guildName: connection?.guildName ?? null,
        inviteUrl: discordClient.getBotInviteUrl(),
        botConfigured: discordClient.isDiscordConfigured(),
      };
    }),

  connect: protectedProcedure
    .input(
      workspaceInput.extend({
        guildId: z.string().min(1).max(32).regex(/^\d+$/),
      }),
    )
    .output(z.object({ success: z.boolean(), guildName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace, userId } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "workspace:manage",
      );

      const guild = await discordClient.getGuild(input.guildId);

      if (!guild.success || !guild.data)
        throw new TRPCError({
          message:
            "Could not access this Discord server. Make sure the bot has been invited to it and the server ID is correct.",
          code: "BAD_REQUEST",
        });

      await discordRepo.create(ctx.db, {
        workspaceId: workspace.id,
        guildId: input.guildId,
        guildName: guild.data.name,
        createdBy: userId,
      });

      return { success: true, guildName: guild.data.name };
    }),

  disconnect: protectedProcedure
    .input(workspaceInput)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "workspace:manage",
      );

      await discordRepo.deleteByWorkspaceId(ctx.db, workspace.id);

      return { success: true };
    }),

  listChannels: protectedProcedure
    .input(workspaceInput)
    .output(z.array(z.object({ id: z.string(), name: z.string() })))
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "board:view",
      );

      const connection = await discordRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (!connection)
        throw new TRPCError({
          message: "Discord is not connected for this workspace",
          code: "NOT_FOUND",
        });

      const channels = await discordClient.getTextChannels(connection.guildId);

      if (!channels.success || !channels.data)
        throw new TRPCError({
          message: channels.error ?? "Failed to fetch Discord channels",
          code: "INTERNAL_SERVER_ERROR",
        });

      return channels.data.map(({ id, name }) => ({ id, name }));
    }),

  listRoles: protectedProcedure
    .input(workspaceInput)
    .output(z.array(z.object({ id: z.string(), name: z.string() })))
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx,
        input.workspacePublicId,
        "board:view",
      );

      const connection = await discordRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (!connection)
        throw new TRPCError({
          message: "Discord is not connected for this workspace",
          code: "NOT_FOUND",
        });

      const roles = await discordClient.getRoles(connection.guildId);

      if (!roles.success || !roles.data)
        throw new TRPCError({
          message: roles.error ?? "Failed to fetch Discord roles",
          code: "INTERNAL_SERVER_ERROR",
        });

      return roles.data.map(({ id, name }) => ({ id, name }));
    }),
});
```

Note: if `Permission` is not exported as a type from `../utils/permissions`, check that file — it defines the `Permission` type near the top; export it if needed.

- [ ] **Step 2: Register the router**

In `packages/api/src/root.ts`, add the import and one key:

```ts
import { discordRouter } from "./routers/discord";
```

and inside `createTRPCRouter({ ... })` (alphabetical placement after `checklist`):

```ts
  discord: discordRouter,
```

- [ ] **Step 3: Document the env vars**

In `.env.example`, under the `# Integration providers (optional)` block (next to `TRELLO_APP_API_KEY`, line ~47), add:

```bash
DISCORD_BOT_TOKEN= # Bot token from https://discord.com/developers/applications (Bot tab)
DISCORD_BOT_CLIENT_ID= # Application ID of the same Discord app — used to build the bot invite link
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter @kan/api typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/discord.ts packages/api/src/root.ts .env.example
git commit -m "feat(discord): add discord tRPC router (connect, channels, roles)"
```

---

### Task 6: Hook into the card router (guard + create + move)

**Files:**
- Modify: `packages/api/src/routers/card.ts` (create: ~lines 60-88 and after ~line 211; update: after ~line 1103)

**Interfaces:**
- Consumes: `assertListAllowsCardCreation`, `notifyCardCreated`, `notifyCardMoved` from `../utils/discord` (Task 4); widened repo returns (Task 3).
- Produces: behavioral only — no new exports.

- [ ] **Step 1: Add the import**

Near the existing webhook import in `packages/api/src/routers/card.ts` (line ~29):

```ts
import {
  assertListAllowsCardCreation,
  notifyCardCreated,
  notifyCardMoved,
} from "../utils/discord";
```

- [ ] **Step 2: Guard card creation in notify lists**

In the `create` mutation, directly after the existing `await assertPermission(ctx.db, userId, list.workspaceId, "card:create");` line:

```ts
      assertListAllowsCardCreation(list);
```

- [ ] **Step 3: Fire the thread creation on card create**

In the `create` mutation, directly after the existing `// Fire webhooks (non-blocking)` block (the `sendWebhooksForWorkspace(...).catch(...)` ending around line 211, before `return newCard;`):

```ts
      // Fire Discord thread creation (non-blocking)
      notifyCardCreated(ctx.db, {
        cardId: newCard.id,
        cardTitle: input.title,
        boardName: list.boardName,
        workspaceId: list.workspaceId,
        discordChannelId: list.boardDiscordChannelId,
        discordBehaviour: list.discordBehaviour,
        discordRoleIds: list.discordRoleIds,
      }).catch((error) => {
        console.error("Discord notification failed:", error);
      });
```

- [ ] **Step 4: Fire the move message on card move**

In the `update` mutation, directly after the existing webhook block (the `sendWebhooksForWorkspace(...).catch(...)` ending around line 1103, before `return result;`):

```ts
      // Fire Discord move notification (non-blocking)
      if (movedToNewList && newList) {
        notifyCardMoved(ctx.db, {
          cardTitle: result.title,
          boardName: card.boardName,
          userName: ctx.user?.name ?? null,
          workspaceId: card.workspaceId,
          newListDiscordBehaviour: newList.discordBehaviour,
          cardDiscordThreadId: existingCard.discordThreadId,
          newListBoardId: newList.boardId,
        }).catch((error) => {
          console.error("Discord notification failed:", error);
        });
      }
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @kan/api typecheck && pnpm --filter @kan/api test`
Expected: typecheck exit 0; full api test suite PASS (including pre-existing webhook tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/card.ts
git commit -m "feat(discord): create threads on card create, notify on card move, block creation in notify lists"
```

---

### Task 7: Board & list config plumbing (routers, repos, output schemas)

**Files:**
- Modify: `packages/api/src/routers/board.ts` (`create` input ~line 293, `update` input ~line 458 + `hasOtherUpdates` + repo call)
- Modify: `packages/db/src/repository/board.repo.ts` (`create` ~line 599, `update` ~line 633, `getByPublicId` board columns ~line 190-201 and lists columns ~line 243)
- Modify: `packages/api/src/schemas/board.ts` (`boardDetailSchema`, lines 52-79)
- Modify: `packages/api/src/routers/list.ts` (`update` input + body, lines 149-220)
- Modify: `packages/db/src/repository/list.repo.ts` (new `updateDiscordConfig`)

**Interfaces:**
- Consumes: Task 2 columns.
- Produces (used by Tasks 9-10):
  - `board.create` / `board.update` accept `discordChannelId?: string | null` (max 32; `null` clears it)
  - `board.byId` output: board gains `discordChannelId: string | null`; each list gains `discordBehaviour: string | null` and `discordRoleIds: string | null`
  - `list.update` accepts `discordBehaviour?: "create_thread" | "notify" | null` and `discordRoleIds?: string[]`
  - `listRepo.updateDiscordConfig(db, { listPublicId, discordBehaviour?, discordRoleIds? })`

- [ ] **Step 1: Board router + repo**

`board.ts` `create` input — add:

```ts
        discordChannelId: z.string().max(32).optional(),
```

and pass it through in the `boardRepo.create` call (the non-clone path, ~line 410):

```ts
        discordChannelId: input.discordChannelId,
```

`board.repo.ts` `create` — add to the input type `discordChannelId?: string;` and to `.values({...})`:

```ts
      discordChannelId: boardInput.discordChannelId,
```

`board.ts` `update` input — add:

```ts
        discordChannelId: z.string().max(32).nullable().optional(),
```

extend the `hasOtherUpdates` condition with `|| input.discordChannelId !== undefined`, and pass `discordChannelId: input.discordChannelId,` into the `boardRepo.update` call.

`board.repo.ts` `update` — add to the input type `discordChannelId?: string | null;` and to `.set({...})`:

```ts
      ...(boardInput.discordChannelId !== undefined && {
        discordChannelId: boardInput.discordChannelId,
      }),
```

- [ ] **Step 2: Expose config in `board.byId`**

In `board.repo.ts` `getByPublicId` (the function whose board-level `columns` block ends with `isArchived: true` at ~line 200): add `discordChannelId: true,` to the board columns, and add to the `lists.columns` block (~line 244-249):

```ts
          discordBehaviour: true,
          discordRoleIds: true,
```

In `packages/api/src/schemas/board.ts` `boardDetailSchema`: add to the top-level object:

```ts
  discordChannelId: z.string().nullish(),
```

and inside the `lists` array element object:

```ts
      discordBehaviour: z.string().nullish(),
      discordRoleIds: z.string().nullish(),
```

- [ ] **Step 3: List router + repo**

`list.repo.ts` — new function after `update`:

```ts
export const updateDiscordConfig = async (
  db: dbClient,
  args: {
    listPublicId: string;
    discordBehaviour?: "create_thread" | "notify" | null;
    discordRoleIds?: string[];
  },
) => {
  const [result] = await db
    .update(lists)
    .set({
      ...(args.discordBehaviour !== undefined && {
        discordBehaviour: args.discordBehaviour,
      }),
      ...(args.discordRoleIds !== undefined && {
        discordRoleIds: JSON.stringify(args.discordRoleIds),
      }),
    })
    .where(and(eq(lists.publicId, args.listPublicId), isNull(lists.deletedAt)))
    .returning({
      publicId: lists.publicId,
      name: lists.name,
    });

  return result;
};
```

`list.ts` `update` input — add:

```ts
        discordBehaviour: z.enum(["create_thread", "notify"]).nullable().optional(),
        discordRoleIds: z.array(z.string().max(32)).max(25).optional(),
```

and in the mutation body, after the existing `if (input.index !== undefined) {...}` block:

```ts
      if (
        input.discordBehaviour !== undefined ||
        input.discordRoleIds !== undefined
      ) {
        result = await listRepo.updateDiscordConfig(ctx.db, {
          listPublicId: input.listPublicId,
          discordBehaviour: input.discordBehaviour,
          discordRoleIds: input.discordRoleIds,
        });
      }
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @kan/api typecheck && pnpm --filter @kan/api test`
Expected: exit 0, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/board.ts packages/api/src/routers/list.ts packages/api/src/schemas/board.ts packages/db/src/repository/board.repo.ts packages/db/src/repository/list.repo.ts
git commit -m "feat(discord): board channel and list behaviour config via board/list routers"
```

---

### Task 8: FE — Discord connect section in Integrations settings

**Files:**
- Create: `apps/web/src/views/settings/components/DiscordIntegration.tsx`
- Modify: `apps/web/src/views/settings/IntegrationsSettings.tsx`

**Interfaces:**
- Consumes: `api.discord.getStatus / connect / disconnect` (Task 5), `useWorkspace`, `usePopup`, `Button`, `Input`.
- Produces: `<DiscordIntegration />` component rendered inside IntegrationsSettings.

- [ ] **Step 1: Create the component**

`apps/web/src/views/settings/components/DiscordIntegration.tsx`:

```tsx
import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiMiniArrowTopRightOnSquare } from "react-icons/hi2";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

export default function DiscordIntegration() {
  const { workspace } = useWorkspace();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const [guildId, setGuildId] = useState("");

  const workspacePublicId = workspace.publicId;

  const { data: status } = api.discord.getStatus.useQuery(
    { workspacePublicId },
    { enabled: !!workspacePublicId },
  );

  const connectDiscord = api.discord.connect.useMutation({
    onSuccess: (data) => {
      void utils.discord.getStatus.invalidate({ workspacePublicId });
      setGuildId("");
      showPopup({
        header: t`Discord connected`,
        message: t`Connected to ${data.guildName}.`,
        icon: "success",
      });
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to connect Discord`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const disconnectDiscord = api.discord.disconnect.useMutation({
    onSuccess: () => {
      void utils.discord.getStatus.invalidate({ workspacePublicId });
      showPopup({
        header: t`Discord disconnected`,
        message: t`Your Discord server has been disconnected.`,
        icon: "success",
      });
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to disconnect Discord`,
        message: error.message,
        icon: "error",
      });
    },
  });

  if (!status?.botConfigured) return null;

  return (
    <div className="mb-8">
      <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
        {t`Discord`}
      </h2>
      {status.connected ? (
        <div className="mt-4 flex items-center gap-4">
          <p className="text-sm text-neutral-700 dark:text-dark-900">
            {t`Connected to ${status.guildName ?? status.guildId ?? ""}`}
          </p>
          <Button
            variant="secondary"
            isLoading={disconnectDiscord.isPending}
            onClick={() => disconnectDiscord.mutate({ workspacePublicId })}
          >
            {t`Disconnect`}
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-neutral-700 dark:text-dark-900">
            {t`Invite the bot to your Discord server, then paste the server ID below.`}
          </p>
          {status.inviteUrl && (
            <div>
              <Button
                variant="secondary"
                iconRight={<HiMiniArrowTopRightOnSquare />}
                onClick={() =>
                  window.open(status.inviteUrl ?? "", "_blank")
                }
              >
                {t`Invite bot to server`}
              </Button>
            </div>
          )}
          <div className="flex max-w-md items-center gap-2">
            <Input
              id="discord-guild-id"
              placeholder={t`Discord server ID`}
              value={guildId}
              onChange={(e) => setGuildId(e.target.value)}
            />
            <Button
              disabled={!guildId.trim()}
              isLoading={connectDiscord.isPending}
              onClick={() =>
                connectDiscord.mutate({
                  workspacePublicId,
                  guildId: guildId.trim(),
                })
              }
            >
              {t`Connect`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

(Server-side `workspace:manage` enforcement covers non-admin members — the section is informational for them.)

- [ ] **Step 2: Render it in IntegrationsSettings**

In `apps/web/src/views/settings/IntegrationsSettings.tsx`:
- Add the import: `import DiscordIntegration from "./components/DiscordIntegration";`
- Render `<DiscordIntegration />` as a sibling of the existing Trello/GitHub sections — inside the main container, after the GitHub section block (each section is a `div` with a bottom margin / border-top; place the component before the closing tag of the sections container, following the same visual rhythm).

- [ ] **Step 3: Verify**

Run: `pnpm --filter @kan/web typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/views/settings/components/DiscordIntegration.tsx apps/web/src/views/settings/IntegrationsSettings.tsx
git commit -m "feat(discord): workspace Discord connect UI in integrations settings"
```

---

### Task 9: FE — board channel picker (create form + board menu modal)

**Files:**
- Modify: `apps/web/src/views/boards/components/NewBoardForm.tsx`
- Create: `apps/web/src/views/board/components/BoardDiscordChannelModal.tsx`
- Modify: `apps/web/src/views/board/components/BoardDropdown.tsx`
- Modify: `apps/web/src/views/board/index.tsx` (render the modal)

**Interfaces:**
- Consumes: `api.discord.getStatus / listChannels`, `api.board.create / update` with `discordChannelId` (Tasks 5, 7), `CheckboxDropdown`, modal system.
- Produces: modal content type string `"BOARD_DISCORD_CHANNEL"`; `<BoardDiscordChannelModal boardPublicId={string} currentChannelId={string | null} />`.

- [ ] **Step 1: Channel picker in NewBoardForm**

In `apps/web/src/views/boards/components/NewBoardForm.tsx` (it already uses `useWorkspace`):

Add imports: `import { useState } from "react";` (merge with existing react import) and `import CheckboxDropdown from "~/components/CheckboxDropdown";`

Add hooks near the existing ones:

```tsx
  const [discordChannelId, setDiscordChannelId] = useState<string | null>(
    null,
  );

  const { data: discordStatus } = api.discord.getStatus.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );

  const { data: discordChannels } = api.discord.listChannels.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId && !!discordStatus?.connected },
  );
```

Add to the `createBoard.mutate({...})` call in `onSubmit`:

```tsx
      discordChannelId: discordChannelId ?? undefined,
```

Add the picker JSX directly below the name `<Input ... />`, inside the same container:

```tsx
        {discordStatus?.connected && (
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-neutral-700 dark:text-dark-900">
              {t`Discord channel (threads will be created here)`}
            </label>
            <CheckboxDropdown
              items={[
                {
                  key: "",
                  value: t`No channel`,
                  selected: !discordChannelId,
                },
                ...(discordChannels ?? []).map((channel) => ({
                  key: channel.id,
                  value: `#${channel.name}`,
                  selected: channel.id === discordChannelId,
                })),
              ]}
              handleSelect={(_groupKey, item) =>
                setDiscordChannelId(item.key || null)
              }
            >
              <div className="flex h-full w-full items-center rounded-[5px] border-[1px] border-light-600 bg-light-200 px-2 py-1 text-left text-xs text-neutral-900 dark:border-dark-600 dark:bg-dark-200 dark:text-dark-1000">
                {discordChannelId
                  ? `#${
                      discordChannels?.find((c) => c.id === discordChannelId)
                        ?.name ?? discordChannelId
                    }`
                  : t`No channel`}
              </div>
            </CheckboxDropdown>
          </div>
        )}
```

- [ ] **Step 2: Create the board channel modal**

`apps/web/src/views/board/components/BoardDiscordChannelModal.tsx`:

```tsx
import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiXMark } from "react-icons/hi2";

import Button from "~/components/Button";
import CheckboxDropdown from "~/components/CheckboxDropdown";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

interface BoardDiscordChannelModalProps {
  boardPublicId: string;
  currentChannelId: string | null;
}

export default function BoardDiscordChannelModal({
  boardPublicId,
  currentChannelId,
}: BoardDiscordChannelModalProps) {
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const { workspace } = useWorkspace();
  const utils = api.useUtils();
  const [channelId, setChannelId] = useState<string | null>(currentChannelId);

  const { data: channels } = api.discord.listChannels.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );

  const updateBoard = api.board.update.useMutation({
    onSuccess: () => {
      void utils.board.byId.invalidate();
      showPopup({
        header: t`Board updated`,
        message: t`Discord channel updated.`,
        icon: "success",
      });
      closeModal();
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to update board`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const items = [
    { key: "", value: t`No channel`, selected: !channelId },
    ...(channels ?? []).map((channel) => ({
      key: channel.id,
      value: `#${channel.name}`,
      selected: channel.id === channelId,
    })),
  ];

  return (
    <div className="p-5">
      <div className="flex w-full items-center justify-between pb-4">
        <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
          {t`Discord channel`}
        </h2>
        <button
          type="button"
          className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
          onClick={() => closeModal()}
        >
          <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
        </button>
      </div>
      <p className="mb-3 text-xs text-neutral-700 dark:text-dark-900">
        {t`Card threads for this board are created in the selected channel.`}
      </p>
      <CheckboxDropdown
        items={items}
        handleSelect={(_groupKey, item) => setChannelId(item.key || null)}
      >
        <div className="flex h-full w-full items-center rounded-[5px] border-[1px] border-light-600 bg-light-200 px-2 py-1 text-left text-xs text-neutral-900 dark:border-dark-600 dark:bg-dark-200 dark:text-dark-1000">
          {items.find((item) => item.selected)?.value}
        </div>
      </CheckboxDropdown>
      <div className="mt-6 flex justify-end">
        <Button
          isLoading={updateBoard.isPending}
          onClick={() =>
            updateBoard.mutate({ boardPublicId, discordChannelId: channelId })
          }
        >
          {t`Save`}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Menu item in BoardDropdown**

In `apps/web/src/views/board/components/BoardDropdown.tsx`:
- Add imports: `import { HiOutlineHashtag } from "react-icons/hi2";` (merge into the existing react-icons import) and `import { useWorkspace } from "~/providers/workspace";`
- Add hooks near the top of the component:

```tsx
  const { workspace } = useWorkspace();
  const { data: discordStatus } = api.discord.getStatus.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );
```

- Add to the `items` array, next to the other `canEditBoard`-gated entries:

```tsx
    ...(canEditBoard && discordStatus?.connected
      ? [
          {
            label: t`Discord channel`,
            action: () => openModal("BOARD_DISCORD_CHANNEL"),
            icon: (
              <HiOutlineHashtag className="h-[16px] w-[16px] text-dark-900" />
            ),
          },
        ]
      : []),
```

- [ ] **Step 4: Render the modal on the board page**

In `apps/web/src/views/board/index.tsx`, add the import:

```tsx
import BoardDiscordChannelModal from "./components/BoardDiscordChannelModal";
```

and alongside the existing `<Modal ... "DELETE_LIST">` block (~line 385), add:

```tsx
      <Modal
        modalSize="sm"
        isVisible={isOpen && modalContentType === "BOARD_DISCORD_CHANNEL"}
      >
        <BoardDiscordChannelModal
          boardPublicId={boardId ?? ""}
          currentChannelId={boardData?.discordChannelId ?? null}
        />
      </Modal>
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @kan/web typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/views/boards/components/NewBoardForm.tsx apps/web/src/views/board/components/BoardDiscordChannelModal.tsx apps/web/src/views/board/components/BoardDropdown.tsx apps/web/src/views/board/index.tsx
git commit -m "feat(discord): board Discord channel picker (create form + board menu)"
```

---

### Task 10: FE — list Discord settings, notify-list card blocking, i18n, final verify

**Files:**
- Create: `apps/web/src/views/board/components/ListDiscordSettingsModal.tsx`
- Modify: `apps/web/src/views/board/components/List.tsx`
- Modify: `apps/web/src/views/board/components/NewCardForm.tsx` (`formattedLists`, ~line 235)
- Modify: `apps/web/src/views/board/index.tsx` (render the modal)

**Interfaces:**
- Consumes: `api.discord.getStatus / listRoles`, `api.list.update` with `discordBehaviour`/`discordRoleIds` (Tasks 5, 7), `board.byId` list fields (Task 7), modal system.
- Produces: modal content type string `"LIST_DISCORD_SETTINGS"`; `<ListDiscordSettingsModal listPublicId={string} currentBehaviour={string | null} currentRoleIds={string[]} queryParams={QueryParams} />`.

- [ ] **Step 1: Create the list settings modal**

`apps/web/src/views/board/components/ListDiscordSettingsModal.tsx`:

```tsx
import { t } from "@lingui/core/macro";
import { useState } from "react";
import { HiXMark } from "react-icons/hi2";

import type { QueryParams } from "~/views/board";
import Button from "~/components/Button";
import CheckboxDropdown from "~/components/CheckboxDropdown";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

type Behaviour = "create_thread" | "notify" | null;

interface ListDiscordSettingsModalProps {
  listPublicId: string;
  currentBehaviour: string | null;
  currentRoleIds: string[];
  queryParams: QueryParams;
}

export default function ListDiscordSettingsModal({
  listPublicId,
  currentBehaviour,
  currentRoleIds,
  queryParams,
}: ListDiscordSettingsModalProps) {
  const { closeModal } = useModal();
  const { showPopup } = usePopup();
  const { workspace } = useWorkspace();
  const utils = api.useUtils();

  const [behaviour, setBehaviour] = useState<Behaviour>(
    currentBehaviour === "create_thread" || currentBehaviour === "notify"
      ? currentBehaviour
      : null,
  );
  const [roleIds, setRoleIds] = useState<string[]>(currentRoleIds);

  const { data: roles } = api.discord.listRoles.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );

  const updateList = api.list.update.useMutation({
    onSuccess: () => {
      void utils.board.byId.invalidate(queryParams);
      showPopup({
        header: t`List updated`,
        message: t`Discord settings updated.`,
        icon: "success",
      });
      closeModal();
    },
    onError: (error) => {
      showPopup({
        header: t`Unable to update list`,
        message: error.message,
        icon: "error",
      });
    },
  });

  const options: { value: Behaviour; label: string; hint: string }[] = [
    { value: null, label: t`None`, hint: t`No Discord activity` },
    {
      value: "create_thread",
      label: t`Create thread`,
      hint: t`Creating a card here creates a Discord thread`,
    },
    {
      value: "notify",
      label: t`Send message`,
      hint: t`Cards cannot be created here; moving a card here posts to its thread`,
    },
  ];

  const toggleRole = (roleId: string) => {
    setRoleIds((current) =>
      current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId],
    );
  };

  return (
    <div className="p-5">
      <div className="flex w-full items-center justify-between pb-4">
        <h2 className="text-sm font-bold text-neutral-900 dark:text-dark-1000">
          {t`Discord settings`}
        </h2>
        <button
          type="button"
          className="rounded p-1 hover:bg-light-200 focus:outline-none dark:hover:bg-dark-300"
          onClick={() => closeModal()}
        >
          <HiXMark size={18} className="text-light-900 dark:text-dark-900" />
        </button>
      </div>
      <fieldset className="flex flex-col gap-2">
        {options.map((option) => (
          <label
            key={option.label}
            className="flex cursor-pointer items-start gap-2"
          >
            <input
              type="radio"
              name="discord-behaviour"
              checked={behaviour === option.value}
              onChange={() => setBehaviour(option.value)}
              className="mt-[2px]"
            />
            <span className="text-sm text-neutral-900 dark:text-dark-1000">
              {option.label}
              <span className="block text-xs text-neutral-600 dark:text-dark-800">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {behaviour === "create_thread" && (
        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-neutral-700 dark:text-dark-900">
            {t`Tag roles in new threads`}
          </label>
          <CheckboxDropdown
            items={(roles ?? []).map((role) => ({
              key: role.id,
              value: role.name,
              selected: roleIds.includes(role.id),
            }))}
            handleSelect={(_groupKey, item) => toggleRole(item.key)}
          >
            <div className="flex h-full w-full items-center rounded-[5px] border-[1px] border-light-600 bg-light-200 px-2 py-1 text-left text-xs text-neutral-900 dark:border-dark-600 dark:bg-dark-200 dark:text-dark-1000">
              {roleIds.length
                ? (roles ?? [])
                    .filter((role) => roleIds.includes(role.id))
                    .map((role) => role.name)
                    .join(", ")
                : t`No roles`}
            </div>
          </CheckboxDropdown>
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <Button
          isLoading={updateList.isPending}
          onClick={() =>
            updateList.mutate({
              listPublicId,
              discordBehaviour: behaviour,
              discordRoleIds: behaviour === "create_thread" ? roleIds : [],
            })
          }
        >
          {t`Save`}
        </Button>
      </div>
    </div>
  );
}
```

Note: if `QueryParams` is not exported from `~/views/board`, check where `NewCardForm.tsx` imports its `QueryParams` type from and use the same import; if none exists, inline the type `{ boardPublicId: string; members: string[]; labels: string[]; lists: string[] }`.

- [ ] **Step 2: List.tsx — menu item + block add-card on notify lists**

In `apps/web/src/views/board/components/List.tsx`:

- Extend the local `List` interface with `discordBehaviour?: string | null;`
- Add imports: `HiOutlineHashtag` (merge into the react-icons import), `import { useWorkspace } from "~/providers/workspace";` and `import { api } from "~/utils/api";` (if not present).
- Add hooks near the top of the component:

```tsx
  const { workspace } = useWorkspace();
  const { data: discordStatus } = api.discord.getStatus.useQuery(
    { workspacePublicId: workspace.publicId },
    { enabled: !!workspace.publicId },
  );
  const isNotifyList = list.discordBehaviour === "notify";
```

(React-query dedupes this per-list query into one request per board page.)

- In `openNewCardForm`, change the guard to `if (!canCreateCard || isNotifyList) return;`
- Wrap the header "+" button's `<Tooltip>` block in `{!isNotifyList && ( ... )}` .
- In the dropdown `items` IIFE, gate the "Add a card" entry with `canCreateCard && !isNotifyList` instead of `canCreateCard`, and add:

```tsx
      ...(discordStatus?.connected
        ? [
            {
              label: t`Discord settings`,
              action: () => {
                setSelectedPublicListId(list.publicId);
                openModal("LIST_DISCORD_SETTINGS");
              },
              icon: (
                <HiOutlineHashtag className="h-[16px] w-[16px] text-dark-900" />
              ),
            },
          ]
        : []),
```

- [ ] **Step 3: Exclude notify lists from the NewCardForm list selector**

In `apps/web/src/views/board/components/NewCardForm.tsx`, locate the `formattedLists` construction (~line 235, mapping board lists to `{ key, value, selected }`) and insert a filter before the map:

```tsx
    .filter((list) => list.discordBehaviour !== "notify")
```

- [ ] **Step 4: Render the modal on the board page**

In `apps/web/src/views/board/index.tsx`, add the import:

```tsx
import ListDiscordSettingsModal from "./components/ListDiscordSettingsModal";
```

and alongside the other modals add:

```tsx
      <Modal
        modalSize="sm"
        isVisible={isOpen && modalContentType === "LIST_DISCORD_SETTINGS"}
      >
        {(() => {
          const selectedList = boardData?.lists.find(
            (list) => list.publicId === selectedPublicListId,
          );
          let roleIds: string[] = [];
          try {
            const parsed: unknown = JSON.parse(
              selectedList?.discordRoleIds ?? "[]",
            );
            if (Array.isArray(parsed))
              roleIds = parsed.filter(
                (id): id is string => typeof id === "string",
              );
          } catch {
            // ignore malformed config
          }
          return (
            <ListDiscordSettingsModal
              listPublicId={selectedPublicListId}
              currentBehaviour={selectedList?.discordBehaviour ?? null}
              currentRoleIds={roleIds}
              queryParams={queryParams}
            />
          );
        })()}
      </Modal>
```

Also pass the behaviour through to each `<List>`: the `list` object spread from `boardData.lists` already carries `discordBehaviour` after Task 7 — no extra prop wiring needed beyond the interface change in Step 2.

- [ ] **Step 5: i18n extraction**

Run: `pnpm --filter @kan/web lingui:extract`
Then: `pnpm --filter @kan/web lingui:compile`
Expected: catalogs gain the new Discord strings.

Check `git diff --stat apps/web/src/locales` — the locale files already contain pre-existing uncommitted changes. If the diff for a file is only the new Discord strings plus what was already there, staging them is acceptable; otherwise leave locale files unstaged and note it in the commit message.

- [ ] **Step 6: Final verification**

Run: `pnpm --filter @kan/web typecheck && pnpm --filter @kan/api test && pnpm --filter @kan/discord test`
Expected: all exit 0 / PASS.

Manual smoke (needs `DISCORD_BOT_TOKEN`, `DISCORD_BOT_CLIENT_ID` in `.env`, a running DB with the migration applied, and the bot invited to a test server):
1. Settings → Integrations → Discord → invite bot → paste server ID → Connect. Expect "Connected to <server>".
2. Create a board and pick a channel; or set one via board ⋯ menu → Discord channel.
3. List ⋯ menu → Discord settings → "Create thread" + pick a role. Create a card in that list → a thread named after the card appears in the channel, first message tags the role.
4. Another list → Discord settings → "Send message". Its "+" button disappears. Drag the card into it → message `<card title> <board name> - <your name>` appears in the card's thread.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/views/board/components/ListDiscordSettingsModal.tsx apps/web/src/views/board/components/List.tsx apps/web/src/views/board/components/NewCardForm.tsx apps/web/src/views/board/index.tsx
git commit -m "feat(discord): list Discord settings, block card creation in notify lists"
```

(Stage locale files in a separate `chore: update translations` commit if Step 5 produced clean diffs.)
