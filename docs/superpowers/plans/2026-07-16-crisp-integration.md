# Crisp → Kan Card Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Crisp operator writes a private note starting with `#card` in any conversation and Kan creates a card in a workspace-designated board/list, configured in Settings → Integrations.

**Architecture:** New `crisp_integrations` table (one row per workspace) stores the Crisp website ID, target list, and a random webhook secret. A public Next.js API route `/api/integrations/crisp/[token]` receives Crisp webhook events, and a pure handler in `@kan/api` parses `#card` notes and creates cards via the existing `cardRepo`. A new tRPC router + a section in the Integrations settings page manage the connection.

**Tech Stack:** Drizzle (Postgres), tRPC v11, Next.js pages router, vitest, react-hook-form + zod, lingui.

**Spec:** `docs/superpowers/specs/2026-07-15-crisp-integration-design.md`

## Global Constraints

- Command prefix is exactly `#card ` (fixed, case-sensitive, checked after trim).
- Card title max **2000** chars; description max **10000** chars (existing API limits).
- One Crisp integration per workspace (DB unique on `workspaceId`).
- All management procedures require the `workspace:manage` permission (same as the webhook router).
- The inbound endpoint authenticates ONLY by the secret in the URL path (Crisp website hooks are unsigned). Unknown token → 404. Everything else that isn't an actionable note → HTTP 200 (prevents Crisp retries).
- Card descriptions are **markdown** (tiptap-markdown), so markdown links are correct.
- Repo conventions: `publicId` via `generateUID()` from `@kan/shared/utils`; repos take `db: dbClient` as first arg; UI strings via lingui `` t`...` `` macros.
- Run all api tests with: `pnpm -F @kan/api test` (vitest).

---

### Task 1: DB schema, relations, migration, repository

**Files:**
- Create: `packages/db/src/schema/crispIntegrations.ts`
- Modify: `packages/db/src/schema/index.ts` (add one export line)
- Create: `packages/db/src/repository/crispIntegration.repo.ts`
- Create (generated): `packages/db/migrations/<timestamp>_*.sql` via drizzle-kit

**Interfaces:**
- Consumes: `workspaces`, `lists`, `users` tables from existing schema; `generateUID` from `@kan/shared/utils`.
- Produces (used by Tasks 3–4):
  - `crispIntegrationRepo.create(db, { workspaceId: number; crispWebsiteId: string; listId: number; webhookSecret: string; createdBy: string })` → `{ publicId, crispWebsiteId, webhookSecret, active, createdAt } | null`
  - `crispIntegrationRepo.getByWorkspaceId(db, workspaceId: number)` → `{ publicId, crispWebsiteId, webhookSecret, active, createdAt, list: { publicId, name, board: { publicId, name } } } | null`
  - `crispIntegrationRepo.getActiveBySecret(db, secret: string)` → `{ id, workspaceId, crispWebsiteId, listId, createdBy, list: { publicId, name, deletedAt, board: { publicId, name } } } | null`
  - `crispIntegrationRepo.hardDeleteByWorkspaceId(db, workspaceId: number)`

No unit tests for this task: existing repos have none (they are thin Drizzle wrappers needing a live DB); the logic is covered in Task 3's service tests with the repo mocked. Verification = migration generates + typecheck passes.

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/crispIntegrations.ts`:

```ts
import { relations } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { lists } from "./lists";
import { users } from "./users";
import { workspaces } from "./workspaces";

export const crispIntegrations = pgTable("crisp_integrations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  publicId: varchar("publicId", { length: 12 }).notNull().unique(),
  workspaceId: bigint("workspaceId", { mode: "number" })
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  crispWebsiteId: varchar("crispWebsiteId", { length: 255 }).notNull(),
  listId: bigint("listId", { mode: "number" })
    .notNull()
    .references(() => lists.id, { onDelete: "cascade" }),
  webhookSecret: text("webhookSecret").notNull().unique(),
  createdBy: uuid("createdBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt"),
}).enableRLS();

export const crispIntegrationsRelations = relations(
  crispIntegrations,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [crispIntegrations.workspaceId],
      references: [workspaces.id],
    }),
    list: one(lists, {
      fields: [crispIntegrations.listId],
      references: [lists.id],
    }),
    createdByUser: one(users, {
      fields: [crispIntegrations.createdBy],
      references: [users.id],
    }),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, add after the `./webhooks` export:

```ts
export * from "./crispIntegrations";
```

- [ ] **Step 3: Create the repository**

Create `packages/db/src/repository/crispIntegration.repo.ts`:

```ts
import { and, eq } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { crispIntegrations } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

export const create = async (
  db: dbClient,
  input: {
    workspaceId: number;
    crispWebsiteId: string;
    listId: number;
    webhookSecret: string;
    createdBy: string;
  },
) => {
  const [result] = await db
    .insert(crispIntegrations)
    .values({
      publicId: generateUID(),
      workspaceId: input.workspaceId,
      crispWebsiteId: input.crispWebsiteId,
      listId: input.listId,
      webhookSecret: input.webhookSecret,
      createdBy: input.createdBy,
    })
    .returning({
      publicId: crispIntegrations.publicId,
      crispWebsiteId: crispIntegrations.crispWebsiteId,
      webhookSecret: crispIntegrations.webhookSecret,
      active: crispIntegrations.active,
      createdAt: crispIntegrations.createdAt,
    });

  return result ?? null;
};

export const getByWorkspaceId = async (db: dbClient, workspaceId: number) => {
  const result = await db.query.crispIntegrations.findFirst({
    columns: {
      publicId: true,
      crispWebsiteId: true,
      webhookSecret: true,
      active: true,
      createdAt: true,
    },
    where: eq(crispIntegrations.workspaceId, workspaceId),
    with: {
      list: {
        columns: { publicId: true, name: true },
        with: {
          board: { columns: { publicId: true, name: true } },
        },
      },
    },
  });

  return result ?? null;
};

export const getActiveBySecret = async (db: dbClient, secret: string) => {
  const result = await db.query.crispIntegrations.findFirst({
    columns: {
      id: true,
      workspaceId: true,
      crispWebsiteId: true,
      listId: true,
      createdBy: true,
    },
    where: and(
      eq(crispIntegrations.webhookSecret, secret),
      eq(crispIntegrations.active, true),
    ),
    with: {
      list: {
        columns: { publicId: true, name: true, deletedAt: true },
        with: {
          board: { columns: { publicId: true, name: true } },
        },
      },
    },
  });

  return result ?? null;
};

export const hardDeleteByWorkspaceId = (db: dbClient, workspaceId: number) => {
  return db
    .delete(crispIntegrations)
    .where(eq(crispIntegrations.workspaceId, workspaceId));
};
```

- [ ] **Step 4: Generate the migration**

Run (from repo root):

```bash
pnpm -F @kan/db with-env drizzle-kit generate
```

Expected: a new SQL file in `packages/db/migrations/` containing `CREATE TABLE "crisp_integrations"` with unique constraints on `publicId`, `workspaceId`, `webhookSecret` and FKs to `workspaces`, `list`, `user`.

- [ ] **Step 5: Apply the migration**

Requires local Postgres running (docker-compose.yml at repo root). Run:

```bash
pnpm db:migrate
```

Expected: migration applied without error. (If Postgres isn't running, start it first: `docker compose up -d postgres` — check service name in docker-compose.yml.)

- [ ] **Step 6: Typecheck**

```bash
pnpm -F @kan/db typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/crispIntegrations.ts packages/db/src/schema/index.ts packages/db/src/repository/crispIntegration.repo.ts packages/db/migrations
git commit -m "feat(db): add crisp_integrations table and repository"
```

---

### Task 2: Crisp note parser + description builder (TDD)

**Files:**
- Create: `packages/api/src/utils/crisp.ts`
- Test: `packages/api/src/utils/crisp.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces (used by Task 3):
  - `CARD_COMMAND_PREFIX = "#card"`
  - `parseCardCommand(content: string): { title: string; body: string } | null`
  - `buildCardDescription(input: { body: string; websiteId: string; sessionId: string; operatorNickname?: string }): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/utils/crisp.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildCardDescription, parseCardCommand } from "./crisp";

describe("parseCardCommand", () => {
  it("returns null when content does not start with #card", () => {
    expect(parseCardCommand("hello world")).toBeNull();
    expect(parseCardCommand("please #card do thing")).toBeNull();
  });

  it("returns null for a bare #card with no title", () => {
    expect(parseCardCommand("#card")).toBeNull();
    expect(parseCardCommand("#card    ")).toBeNull();
  });

  it("extracts a single-line title with empty body", () => {
    expect(parseCardCommand("#card Fix login bug")).toEqual({
      title: "Fix login bug",
      body: "",
    });
  });

  it("trims surrounding whitespace before matching the prefix", () => {
    expect(parseCardCommand("  #card Fix login bug  ")).toEqual({
      title: "Fix login bug",
      body: "",
    });
  });

  it("uses the first line as title and the rest as body", () => {
    expect(
      parseCardCommand("#card Fix login bug\nUser cannot sign in\nwith SSO"),
    ).toEqual({
      title: "Fix login bug",
      body: "User cannot sign in\nwith SSO",
    });
  });

  it("truncates the title at 2000 characters", () => {
    const result = parseCardCommand(`#card ${"a".repeat(3000)}`);
    expect(result?.title).toHaveLength(2000);
  });
});

describe("buildCardDescription", () => {
  it("includes the conversation link", () => {
    const description = buildCardDescription({
      body: "",
      websiteId: "site-1",
      sessionId: "session_abc",
    });
    expect(description).toContain(
      "https://app.crisp.chat/website/site-1/inbox/session_abc/",
    );
  });

  it("includes body and operator nickname when provided", () => {
    const description = buildCardDescription({
      body: "Steps to reproduce",
      websiteId: "site-1",
      sessionId: "session_abc",
      operatorNickname: "Jane",
    });
    expect(description).toContain("Steps to reproduce");
    expect(description).toContain("Jane");
  });

  it("caps the description at 10000 characters", () => {
    const description = buildCardDescription({
      body: "x".repeat(20000),
      websiteId: "site-1",
      sessionId: "session_abc",
    });
    expect(description.length).toBeLessThanOrEqual(10000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm -F @kan/api exec vitest run src/utils/crisp.test.ts
```

Expected: FAIL — cannot resolve `./crisp`.

- [ ] **Step 3: Write the implementation**

Create `packages/api/src/utils/crisp.ts`:

```ts
export const CARD_COMMAND_PREFIX = "#card";

const MAX_TITLE_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 10000;

export function parseCardCommand(
  content: string,
): { title: string; body: string } | null {
  const trimmed = content.trim();

  if (!trimmed.startsWith(`${CARD_COMMAND_PREFIX} `)) return null;

  const rest = trimmed.slice(CARD_COMMAND_PREFIX.length + 1).trim();
  if (!rest) return null;

  const [firstLine = "", ...bodyLines] = rest.split("\n");
  const title = firstLine.trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) return null;

  return { title, body: bodyLines.join("\n").trim() };
}

export function buildCardDescription(input: {
  body: string;
  websiteId: string;
  sessionId: string;
  operatorNickname?: string;
}): string {
  const conversationUrl = `https://app.crisp.chat/website/${input.websiteId}/inbox/${input.sessionId}/`;

  const lines: string[] = [];
  if (input.body) lines.push(input.body, "");
  lines.push("---");
  lines.push(`Created from a [Crisp conversation](${conversationUrl})`);
  if (input.operatorNickname)
    lines.push(`Operator: ${input.operatorNickname}`);

  return lines.join("\n").slice(0, MAX_DESCRIPTION_LENGTH);
}
```

Note: `slice(0, 10000)` can cut through the trailing metadata when the body is huge — acceptable; the card still gets created with the full-as-possible body. Don't add smarter truncation.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm -F @kan/api exec vitest run src/utils/crisp.test.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/utils/crisp.ts packages/api/src/utils/crisp.test.ts
git commit -m "feat(api): add crisp note parser and description builder"
```

---

### Task 3: `handleCrispWebhook` service (TDD)

**Files:**
- Modify: `packages/api/src/utils/crisp.ts` (append)
- Test: `packages/api/src/utils/crisp.test.ts` (append)

**Interfaces:**
- Consumes: `crispIntegrationRepo.getActiveBySecret` (Task 1), `cardRepo.create` (existing — `(db, { title, description, createdBy, listId, workspaceId, position, dueDate? })`, returns object with `.id` and `.publicId`), `createCardWebhookPayload` / `sendWebhooksForWorkspace` from `./webhook` (existing), `parseCardCommand` / `buildCardDescription` (Task 2).
- Produces (used by Task 5):
  - `handleCrispWebhook(db: dbClient, token: string, body: unknown): Promise<{ status: 200 | 404 | 500; message: string }>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/src/utils/crisp.test.ts`. Add the mocks at the **top of the file** (before the existing imports — `vi.mock` calls are hoisted, but keep them physically first for readability), and the new describe block at the bottom:

```ts
// --- add at top of file, replacing the existing import line ---
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/crispIntegration.repo", () => ({
  getActiveBySecret: vi.fn(),
}));

vi.mock("@kan/db/repository/card.repo", () => ({
  create: vi.fn(),
}));

vi.mock("./webhook", () => ({
  createCardWebhookPayload: vi.fn(() => ({ event: "card.created" })),
  sendWebhooksForWorkspace: vi.fn(() => Promise.resolve()),
}));

import * as cardRepo from "@kan/db/repository/card.repo";
import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";

import {
  buildCardDescription,
  handleCrispWebhook,
  parseCardCommand,
} from "./crisp";

const mockGetActiveBySecret =
  crispIntegrationRepo.getActiveBySecret as ReturnType<typeof vi.fn>;
const mockCardCreate = cardRepo.create as ReturnType<typeof vi.fn>;
```

```ts
// --- add at bottom of file ---
describe("handleCrispWebhook", () => {
  const mockDb = {} as never;
  const mockIntegration = {
    id: 1,
    workspaceId: 7,
    crispWebsiteId: "site-1",
    listId: 42,
    createdBy: "user-123",
    list: {
      publicId: "list-abc12345",
      name: "Inbox",
      deletedAt: null,
      board: { publicId: "board-abc123", name: "Support" },
    },
  };

  const noteEvent = (content: string) => ({
    event: "message:received",
    data: {
      website_id: "site-1",
      session_id: "session_xyz",
      type: "note",
      from: "operator",
      content,
      user: { nickname: "Jane" },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCardCreate.mockResolvedValue({ id: 99, publicId: "card-abc12345" });
  });

  it("returns 404 for an unknown token", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(null);

    const result = await handleCrispWebhook(mockDb, "bad-token", noteEvent("#card X"));

    expect(result.status).toBe(404);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores non-note messages with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const event = noteEvent("#card X");
    event.data.type = "text";

    const result = await handleCrispWebhook(mockDb, "secret", event);

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes from a different crisp website with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const event = noteEvent("#card X");
    event.data.website_id = "other-site";

    const result = await handleCrispWebhook(mockDb, "secret", event);

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes without the #card prefix with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const result = await handleCrispWebhook(mockDb, "secret", noteEvent("just a note"));

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads with 200", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const result = await handleCrispWebhook(mockDb, "secret", { nope: true });

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("ignores notes when the target list is soft-deleted", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce({
      ...mockIntegration,
      list: { ...mockIntegration.list, deletedAt: new Date() },
    });

    const result = await handleCrispWebhook(mockDb, "secret", noteEvent("#card X"));

    expect(result.status).toBe(200);
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("creates a card from a valid #card note", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);

    const result = await handleCrispWebhook(
      mockDb,
      "secret",
      noteEvent("#card Fix login bug\nUser cannot sign in"),
    );

    expect(result.status).toBe(200);
    expect(mockCardCreate).toHaveBeenCalledWith(mockDb, {
      title: "Fix login bug",
      description: buildCardDescription({
        body: "User cannot sign in",
        websiteId: "site-1",
        sessionId: "session_xyz",
        operatorNickname: "Jane",
      }),
      createdBy: "user-123",
      listId: 42,
      workspaceId: 7,
      position: "end",
    });
  });

  it("returns 500 when card creation throws", async () => {
    mockGetActiveBySecret.mockResolvedValueOnce(mockIntegration);
    mockCardCreate.mockRejectedValueOnce(new Error("db down"));

    const result = await handleCrispWebhook(mockDb, "secret", noteEvent("#card X"));

    expect(result.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
pnpm -F @kan/api exec vitest run src/utils/crisp.test.ts
```

Expected: FAIL — `handleCrispWebhook` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/api/src/utils/crisp.ts` (and add the imports at the top of the file):

```ts
// --- imports at top of file ---
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import { createLogger } from "@kan/logger";

import { createCardWebhookPayload, sendWebhooksForWorkspace } from "./webhook";

const log = createLogger("crisp");
```

```ts
// --- appended below buildCardDescription ---
const crispEventSchema = z.object({
  event: z.string(),
  data: z
    .object({
      website_id: z.string(),
      session_id: z.string(),
      type: z.string().optional(),
      from: z.string().optional(),
      content: z.unknown().optional(),
      user: z.object({ nickname: z.string().optional() }).optional(),
    })
    .passthrough(),
});

export async function handleCrispWebhook(
  db: dbClient,
  token: string,
  body: unknown,
): Promise<{ status: 200 | 404 | 500; message: string }> {
  const integration = await crispIntegrationRepo.getActiveBySecret(db, token);
  if (!integration) return { status: 404, message: "Not found" };

  const parsed = crispEventSchema.safeParse(body);
  if (!parsed.success) return { status: 200, message: "Ignored" };

  const { event, data } = parsed.data;

  if (
    event !== "message:received" ||
    data.type !== "note" ||
    data.from !== "operator" ||
    data.website_id !== integration.crispWebsiteId ||
    typeof data.content !== "string"
  )
    return { status: 200, message: "Ignored" };

  const command = parseCardCommand(data.content);
  if (!command) return { status: 200, message: "Ignored" };

  // Target list was soft-deleted; don't create cards into a hidden list.
  if (integration.list.deletedAt) return { status: 200, message: "Ignored" };

  const description = buildCardDescription({
    body: command.body,
    websiteId: data.website_id,
    sessionId: data.session_id,
    operatorNickname: data.user?.nickname,
  });

  try {
    const newCard = await cardRepo.create(db, {
      title: command.title,
      description,
      createdBy: integration.createdBy,
      listId: integration.listId,
      workspaceId: integration.workspaceId,
      position: "end",
    });

    if (!newCard.id) return { status: 500, message: "Failed to create card" };

    // Fire outbound workspace webhooks (non-blocking), same as the card router
    sendWebhooksForWorkspace(
      db,
      integration.workspaceId,
      createCardWebhookPayload(
        "card.created",
        {
          id: String(newCard.id),
          publicId: newCard.publicId,
          title: command.title,
          description,
          dueDate: null,
          listId: integration.list.publicId,
        },
        {
          boardId: integration.list.board.publicId,
          boardName: integration.list.board.name,
          listName: integration.list.name,
        },
      ),
    ).catch((error) => {
      log.error({ err: error }, "Crisp card webhook fanout failed");
    });

    return { status: 200, message: "Card created" };
  } catch (error) {
    log.error({ err: error }, "Failed to create card from Crisp note");
    return { status: 500, message: "Internal error" };
  }
}
```

- [ ] **Step 4: Run all crisp tests to verify they pass**

```bash
pnpm -F @kan/api exec vitest run src/utils/crisp.test.ts
```

Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/utils/crisp.ts packages/api/src/utils/crisp.test.ts
git commit -m "feat(api): handle crisp webhook events and create cards"
```

---

### Task 4: tRPC router `crispIntegration` (TDD)

**Files:**
- Create: `packages/api/src/routers/crispIntegration.ts`
- Test: `packages/api/src/routers/crispIntegration.test.ts`
- Modify: `packages/api/src/root.ts` (register router)

**Interfaces:**
- Consumes: `crispIntegrationRepo` (Task 1), `workspaceRepo.getByPublicId`, `listRepo.getWorkspaceAndListIdByListPublicId` (existing — returns `{ id, publicId, name, createdBy, workspaceId, boardPublicId, boardName } | null`), `assertPermission`, `env("NEXT_PUBLIC_BASE_URL")` from `next-runtime-env`.
- Produces (used by Task 6 via `api.crispIntegration.*`):
  - `get({ workspacePublicId })` → connection object or `null`
  - `create({ workspacePublicId, crispWebsiteId, listPublicId })` → connection object
  - `disconnect({ workspacePublicId })` → `{ success: boolean }`
  - Connection object shape: `{ publicId, crispWebsiteId, webhookUrl, active, createdAt, list: { publicId, name }, board: { publicId, name } }`

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/routers/crispIntegration.test.ts` (same style as `webhook.test.ts`):

```ts
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/crispIntegration.repo", () => ({
  create: vi.fn(),
  getByWorkspaceId: vi.fn(),
  hardDeleteByWorkspaceId: vi.fn(),
}));

vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));

vi.mock("@kan/db/repository/list.repo", () => ({
  getWorkspaceAndListIdByListPublicId: vi.fn(),
}));

vi.mock("../utils/permissions", () => ({
  assertPermission: vi.fn(),
}));

import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { assertPermission } from "../utils/permissions";

const mockCreate = crispIntegrationRepo.create as ReturnType<typeof vi.fn>;
const mockGetByWorkspaceId =
  crispIntegrationRepo.getByWorkspaceId as ReturnType<typeof vi.fn>;
const mockHardDelete =
  crispIntegrationRepo.hardDeleteByWorkspaceId as ReturnType<typeof vi.fn>;
const mockWorkspaceGetByPublicId =
  workspaceRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockGetList =
  listRepo.getWorkspaceAndListIdByListPublicId as ReturnType<typeof vi.fn>;
const mockAssertPermission = assertPermission as ReturnType<typeof vi.fn>;

describe("crispIntegration router", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-123", name: "Test User", email: "t@e.st" };
  const mockWorkspace = { id: 7, publicId: "ws-123456789" };
  const mockList = {
    id: 42,
    publicId: "list-abc12345",
    name: "Inbox",
    createdBy: "user-123",
    workspaceId: 7,
    boardPublicId: "board-abc123",
    boardName: "Support",
  };
  const mockStoredIntegration = {
    publicId: "ci-123456789",
    crispWebsiteId: "site-1",
    webhookSecret: "s3cret",
    active: true,
    createdAt: new Date("2026-01-01"),
    list: {
      publicId: "list-abc12345",
      name: "Inbox",
      board: { publicId: "board-abc123", name: "Support" },
    },
  };

  const ctx = { user: mockUser, db: mockDb } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BASE_URL = "https://kan.test";
    mockAssertPermission.mockResolvedValue(undefined);
    mockWorkspaceGetByPublicId.mockResolvedValue(mockWorkspace);
  });

  it("get throws UNAUTHORIZED when unauthenticated", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    await expect(
      crispIntegrationRouter
        .createCaller({ user: null, db: mockDb } as never)
        .get({ workspacePublicId: "ws-123456789" }),
    ).rejects.toThrow(TRPCError);
  });

  it("get checks workspace:manage permission", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetByWorkspaceId.mockResolvedValueOnce(null);

    await crispIntegrationRouter
      .createCaller(ctx)
      .get({ workspacePublicId: "ws-123456789" });

    expect(mockAssertPermission).toHaveBeenCalledWith(
      mockDb,
      "user-123",
      7,
      "workspace:manage",
    );
  });

  it("get returns null when not connected", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetByWorkspaceId.mockResolvedValueOnce(null);

    const result = await crispIntegrationRouter
      .createCaller(ctx)
      .get({ workspacePublicId: "ws-123456789" });

    expect(result).toBeNull();
  });

  it("get returns connection with webhook URL containing the secret", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetByWorkspaceId.mockResolvedValueOnce(mockStoredIntegration);

    const result = await crispIntegrationRouter
      .createCaller(ctx)
      .get({ workspacePublicId: "ws-123456789" });

    expect(result?.webhookUrl).toBe(
      "https://kan.test/api/integrations/crisp/s3cret",
    );
    expect(result?.board.name).toBe("Support");
    expect(result?.list.name).toBe("Inbox");
  });

  it("create rejects when workspace already has a connection", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetList.mockResolvedValueOnce(mockList);
    mockGetByWorkspaceId.mockResolvedValueOnce(mockStoredIntegration);

    await expect(
      crispIntegrationRouter.createCaller(ctx).create({
        workspacePublicId: "ws-123456789",
        crispWebsiteId: "site-1",
        listPublicId: "list-abc12345",
      }),
    ).rejects.toThrow(TRPCError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create rejects a list from another workspace", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetList.mockResolvedValueOnce({ ...mockList, workspaceId: 999 });

    await expect(
      crispIntegrationRouter.createCaller(ctx).create({
        workspacePublicId: "ws-123456789",
        crispWebsiteId: "site-1",
        listPublicId: "list-abc12345",
      }),
    ).rejects.toThrow(TRPCError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create stores the integration and returns the webhook URL", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockGetList.mockResolvedValueOnce(mockList);
    mockGetByWorkspaceId.mockResolvedValueOnce(null);
    mockCreate.mockImplementationOnce((_db, input) =>
      Promise.resolve({
        publicId: "ci-123456789",
        crispWebsiteId: input.crispWebsiteId,
        webhookSecret: input.webhookSecret,
        active: true,
        createdAt: new Date("2026-01-01"),
      }),
    );

    const result = await crispIntegrationRouter.createCaller(ctx).create({
      workspacePublicId: "ws-123456789",
      crispWebsiteId: "site-1",
      listPublicId: "list-abc12345",
    });

    const createInput = mockCreate.mock.calls[0]?.[1] as {
      webhookSecret: string;
      workspaceId: number;
      listId: number;
      createdBy: string;
    };
    expect(createInput.workspaceId).toBe(7);
    expect(createInput.listId).toBe(42);
    expect(createInput.createdBy).toBe("user-123");
    expect(createInput.webhookSecret.length).toBeGreaterThanOrEqual(32);
    expect(result.webhookUrl).toBe(
      `https://kan.test/api/integrations/crisp/${createInput.webhookSecret}`,
    );
  });

  it("disconnect deletes the workspace connection", async () => {
    const { crispIntegrationRouter } = await import("./crispIntegration");

    mockHardDelete.mockResolvedValueOnce(undefined);

    const result = await crispIntegrationRouter
      .createCaller(ctx)
      .disconnect({ workspacePublicId: "ws-123456789" });

    expect(mockHardDelete).toHaveBeenCalledWith(mockDb, 7);
    expect(result).toEqual({ success: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm -F @kan/api exec vitest run src/routers/crispIntegration.test.ts
```

Expected: FAIL — cannot resolve `./crispIntegration`.

- [ ] **Step 3: Write the router**

Create `packages/api/src/routers/crispIntegration.ts`:

```ts
import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { env } from "next-runtime-env";
import { z } from "zod";

import * as crispIntegrationRepo from "@kan/db/repository/crispIntegration.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { assertPermission } from "../utils/permissions";

const connectionSchema = z.object({
  publicId: z.string(),
  crispWebsiteId: z.string(),
  webhookUrl: z.string(),
  active: z.boolean(),
  createdAt: z.date(),
  list: z.object({ publicId: z.string(), name: z.string() }),
  board: z.object({ publicId: z.string(), name: z.string() }),
});

function buildWebhookUrl(secret: string) {
  return `${env("NEXT_PUBLIC_BASE_URL")}/api/integrations/crisp/${secret}`;
}

async function getAuthorizedWorkspace(
  ctx: { db: never; user?: { id: string } | null },
  workspacePublicId: string,
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

  await assertPermission(ctx.db, userId, workspace.id, "workspace:manage");

  return { userId, workspace };
}

export const crispIntegrationRouter = createTRPCRouter({
  get: protectedProcedure
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(connectionSchema.nullable())
    .query(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx as never,
        input.workspacePublicId,
      );

      const integration = await crispIntegrationRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (!integration) return null;

      return {
        publicId: integration.publicId,
        crispWebsiteId: integration.crispWebsiteId,
        webhookUrl: buildWebhookUrl(integration.webhookSecret),
        active: integration.active,
        createdAt: integration.createdAt,
        list: {
          publicId: integration.list.publicId,
          name: integration.list.name,
        },
        board: {
          publicId: integration.list.board.publicId,
          name: integration.list.board.name,
        },
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        workspacePublicId: z.string().min(12),
        crispWebsiteId: z.string().min(1).max(255),
        listPublicId: z.string().min(12),
      }),
    )
    .output(connectionSchema)
    .mutation(async ({ ctx, input }) => {
      const { userId, workspace } = await getAuthorizedWorkspace(
        ctx as never,
        input.workspacePublicId,
      );

      const list = await listRepo.getWorkspaceAndListIdByListPublicId(
        ctx.db,
        input.listPublicId,
      );

      if (!list || list.workspaceId !== workspace.id)
        throw new TRPCError({
          message: "List not found",
          code: "NOT_FOUND",
        });

      const existing = await crispIntegrationRepo.getByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      if (existing)
        throw new TRPCError({
          message: "Crisp is already connected to this workspace",
          code: "CONFLICT",
        });

      const webhookSecret = crypto.randomBytes(32).toString("base64url");

      const result = await crispIntegrationRepo.create(ctx.db, {
        workspaceId: workspace.id,
        crispWebsiteId: input.crispWebsiteId,
        listId: list.id,
        webhookSecret,
        createdBy: userId,
      });

      if (!result)
        throw new TRPCError({
          message: "Unable to connect Crisp",
          code: "INTERNAL_SERVER_ERROR",
        });

      return {
        publicId: result.publicId,
        crispWebsiteId: result.crispWebsiteId,
        webhookUrl: buildWebhookUrl(result.webhookSecret),
        active: result.active,
        createdAt: result.createdAt,
        list: { publicId: list.publicId, name: list.name },
        board: { publicId: list.boardPublicId, name: list.boardName },
      };
    }),

  disconnect: protectedProcedure
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { workspace } = await getAuthorizedWorkspace(
        ctx as never,
        input.workspacePublicId,
      );

      await crispIntegrationRepo.hardDeleteByWorkspaceId(ctx.db, workspace.id);

      return { success: true };
    }),
});
```

Note: no `openapi` meta — internal-only per spec. If `ctx as never` fights the types, type the helper's first param as the actual context type used in the file (`{ db: dbClient; user?: { id: string } | null }` with `import type { dbClient } from "@kan/db/client"`) — match whatever the surrounding tRPC context type allows with minimal fuss.

- [ ] **Step 4: Register in root router**

In `packages/api/src/root.ts`:

```ts
import { crispIntegrationRouter } from "./routers/crispIntegration";
```

and inside `createTRPCRouter({ ... })` add:

```ts
  crispIntegration: crispIntegrationRouter,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm -F @kan/api exec vitest run src/routers/crispIntegration.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 6: Run the full api test suite + typecheck**

```bash
pnpm -F @kan/api test
pnpm -F @kan/api typecheck
```

Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routers/crispIntegration.ts packages/api/src/routers/crispIntegration.test.ts packages/api/src/root.ts
git commit -m "feat(api): add crispIntegration tRPC router"
```

---

### Task 5: Inbound webhook endpoint (thin wiring)

**Files:**
- Create: `apps/web/src/pages/api/integrations/crisp/[token].ts`

**Interfaces:**
- Consumes: `handleCrispWebhook` (Task 3), `createDrizzleClient` from `@kan/db/client`, `withApiLogging` / `withRateLimit` from `@kan/api/utils/*` (existing, same usage as `apps/web/src/pages/api/unsubscribe.ts`).
- Produces: public HTTP endpoint `POST /api/integrations/crisp/{secret}`.

No unit test: all decision logic lives in `handleCrispWebhook`, fully tested in Task 3. This file is wiring, verified by typecheck + a curl smoke test in Task 7.

- [ ] **Step 1: Create the route**

Create `apps/web/src/pages/api/integrations/crisp/[token].ts`:

```ts
import type { NextApiRequest, NextApiResponse } from "next";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { handleCrispWebhook } from "@kan/api/utils/crisp";
import { createDrizzleClient } from "@kan/db/client";

const db = createDrizzleClient();

export default withRateLimit(
  // ponytail: generous limit — Crisp delivers every subscribed message event
  // for the whole website here, not just #card notes
  { points: 600, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ message: "Method not allowed" });
    }

    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) return res.status(404).json({ message: "Not found" });

    const result = await handleCrispWebhook(db, token, req.body);
    return res.status(result.status).json({ message: result.message });
  }),
);
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -F @kan/web typecheck
```

Expected: no errors. (If `@kan/api/utils/crisp` fails to resolve, check `packages/api/package.json` `exports` — `./utils/apiLogging` resolves via a `./utils/*` pattern, so `./utils/crisp` should too.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/api/integrations/crisp
git commit -m "feat(web): add inbound crisp webhook endpoint"
```

---

### Task 6: Settings UI — Crisp section

**Files:**
- Create: `apps/web/src/views/settings/components/CrispIntegrationSection.tsx`
- Modify: `apps/web/src/views/settings/IntegrationsSettings.tsx`

**Interfaces:**
- Consumes: `api.crispIntegration.get/create/disconnect` (Task 4), `api.board.all.useQuery({ workspacePublicId })` and `api.board.byId.useQuery({ boardPublicId, type: "regular" })` (existing — `board.lists` is `{ publicId, name }[]`), `useWorkspace` from `~/providers/workspace`, `usePopup`, `Button`, `Input`.
- Produces: UI only.

No automated test: the repo has no component tests; verified by typecheck and Task 7's manual pass.

- [ ] **Step 1: Create the section component**

Create `apps/web/src/views/settings/components/CrispIntegrationSection.tsx`:

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { useForm } from "react-hook-form";
import { z } from "zod";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";

const crispFormSchema = z.object({
  crispWebsiteId: z.string().min(1, { message: t`Website ID is required` }),
  boardPublicId: z.string().min(12, { message: t`Board is required` }),
  listPublicId: z.string().min(12, { message: t`List is required` }),
});

type CrispFormValues = z.infer<typeof crispFormSchema>;

const selectClassName =
  "block w-full rounded-md border-0 bg-dark-300 bg-white/5 py-1.5 text-sm shadow-sm ring-1 ring-inset ring-light-600 focus:ring-2 focus:ring-inset focus:ring-light-700 dark:text-dark-1000 dark:ring-dark-700 dark:focus:ring-dark-700 sm:leading-6";

export function CrispIntegrationSection({
  workspacePublicId,
}: {
  workspacePublicId: string;
}) {
  const { showPopup } = usePopup();
  const utils = api.useUtils();

  const { data: integration, isLoading } = api.crispIntegration.get.useQuery({
    workspacePublicId,
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<CrispFormValues>({
    resolver: zodResolver(crispFormSchema),
    defaultValues: { crispWebsiteId: "", boardPublicId: "", listPublicId: "" },
  });

  const selectedBoardPublicId = watch("boardPublicId");

  const { data: boards } = api.board.all.useQuery(
    { workspacePublicId },
    { enabled: !isLoading && !integration },
  );

  const { data: selectedBoard } = api.board.byId.useQuery(
    { boardPublicId: selectedBoardPublicId, type: "regular" },
    { enabled: selectedBoardPublicId.length >= 12 },
  );

  const lists = selectedBoard?.lists ?? [];

  const createIntegration = api.crispIntegration.create.useMutation({
    onSuccess: async () => {
      await utils.crispIntegration.get.invalidate({ workspacePublicId });
      showPopup({
        header: t`Crisp connected`,
        message: t`Copy the webhook URL into your Crisp dashboard to finish setup.`,
        icon: "success",
      });
    },
    onError: () => {
      showPopup({
        header: t`Error connecting Crisp`,
        message: t`An error occurred while connecting Crisp.`,
        icon: "error",
      });
    },
  });

  const disconnectIntegration = api.crispIntegration.disconnect.useMutation({
    onSuccess: async () => {
      await utils.crispIntegration.get.invalidate({ workspacePublicId });
      showPopup({
        header: t`Crisp disconnected`,
        message: t`The Crisp integration has been removed.`,
        icon: "success",
      });
    },
    onError: () => {
      showPopup({
        header: t`Error disconnecting Crisp`,
        message: t`An error occurred while disconnecting Crisp.`,
        icon: "error",
      });
    },
  });

  const onSubmit = (values: CrispFormValues) => {
    createIntegration.mutate({
      workspacePublicId,
      crispWebsiteId: values.crispWebsiteId,
      listPublicId: values.listPublicId,
    });
  };

  const copyWebhookUrl = async () => {
    if (!integration) return;
    await navigator.clipboard.writeText(integration.webhookUrl);
    showPopup({
      header: t`Copied`,
      message: t`Webhook URL copied to clipboard.`,
      icon: "success",
    });
  };

  return (
    <div className="mb-8 border-t border-light-300 dark:border-dark-300">
      <h2 className="mb-4 mt-8 text-[14px] font-bold text-neutral-900 dark:text-dark-1000">
        {t`Crisp`}
      </h2>
      {integration ? (
        <>
          <p className="mb-4 text-sm text-neutral-500 dark:text-dark-900">
            {t`Crisp is connected. Operator notes starting with #card create cards in`}{" "}
            <span className="font-medium">
              {integration.board.name} / {integration.list.name}
            </span>
            .
          </p>
          <div className="mb-4 flex w-full max-w-[500px] items-center gap-2">
            <Input readOnly value={integration.webhookUrl} />
            <Button variant="secondary" onClick={() => void copyWebhookUrl()}>
              {t`Copy`}
            </Button>
          </div>
          <ol className="mb-8 list-decimal pl-5 text-sm text-neutral-500 dark:text-dark-900">
            <li>{t`In Crisp, go to Settings → Websites → your website → Web Hooks and paste this URL.`}</li>
            <li>{t`Subscribe the hook to message events.`}</li>
            <li>{t`In a conversation, write a private note starting with #card followed by the card title.`}</li>
            <li>{t`Optional: create a Crisp shortcut !card that expands to #card for faster typing.`}</li>
          </ol>
          <Button
            variant="secondary"
            onClick={() => disconnectIntegration.mutate({ workspacePublicId })}
          >
            {t`Disconnect Crisp`}
          </Button>
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-neutral-500 dark:text-dark-900">
            {t`Create cards from Crisp conversations: choose a target board and list, then paste the generated webhook URL into your Crisp dashboard.`}
          </p>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="flex max-w-[325px] flex-col gap-3"
          >
            <Input
              placeholder={t`Crisp Website ID`}
              {...register("crispWebsiteId")}
              errorMessage={errors.crispWebsiteId?.message}
            />
            <div className="flex flex-col gap-1">
              <select className={selectClassName} {...register("boardPublicId")}>
                <option value="">{t`Select a board`}</option>
                {(boards ?? []).map((board) => (
                  <option key={board.publicId} value={board.publicId}>
                    {board.name}
                  </option>
                ))}
              </select>
              {errors.boardPublicId && (
                <div className="text-xs text-red-500">
                  {errors.boardPublicId.message}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <select
                className={selectClassName}
                disabled={!lists.length}
                {...register("listPublicId")}
              >
                <option value="">{t`Select a list`}</option>
                {lists.map((list) => (
                  <option key={list.publicId} value={list.publicId}>
                    {list.name}
                  </option>
                ))}
              </select>
              {errors.listPublicId && (
                <div className="text-xs text-red-500">
                  {errors.listPublicId.message}
                </div>
              )}
            </div>
            <div>
              <Button
                variant="primary"
                type="submit"
                isLoading={createIntegration.isPending}
                disabled={createIntegration.isPending}
              >
                {t`Connect Crisp`}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in IntegrationsSettings**

In `apps/web/src/views/settings/IntegrationsSettings.tsx`:

Add imports:

```tsx
import { useWorkspace } from "~/providers/workspace";
import { CrispIntegrationSection } from "./components/CrispIntegrationSection";
```

Inside the component add (next to the other hooks at the top):

```tsx
  const { workspace } = useWorkspace();
```

After the closing `</div>` of the GitHub section (line ~227, before the `{/* Global modals */}` comment), add:

```tsx
      {workspace && (
        <CrispIntegrationSection workspacePublicId={workspace.publicId} />
      )}
```

(`useWorkspace` can return a falsy `workspace` — WebhookSettings guards with `if (!workspace) return null;` — hence the conditional render.)

- [ ] **Step 3: Typecheck + lint**

```bash
pnpm -F @kan/web typecheck
pnpm -F @kan/web lint
```

Expected: no errors. (`board.all` / `board.byId` output field names should be verified against the actual router output if typecheck complains — fix property names, not types.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/views/settings/components/CrispIntegrationSection.tsx apps/web/src/views/settings/IntegrationsSettings.tsx
git commit -m "feat(web): add Crisp section to integrations settings"
```

Note on i18n: new `` t`...` `` strings fall back to their English source text until translators run the usual `pnpm -F @kan/web lingui:extract` / `lingui:compile` chore. Do NOT run extract/compile in this plan — the working tree already has unrelated uncommitted locale changes and mixing them into this feature's commits would sweep them up.

---

### Task 7: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suites**

```bash
pnpm -F @kan/api test
pnpm -F @kan/web test
```

Expected: all PASS.

- [ ] **Step 2: Typecheck affected packages**

```bash
pnpm -F @kan/db typecheck && pnpm -F @kan/api typecheck && pnpm -F @kan/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Local smoke test of the endpoint**

Start the app (`pnpm dev:next`), connect Crisp in Settings → Integrations (use any string as Website ID, e.g. `test-site`, pick a board/list), copy the webhook URL, then:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "<webhookUrl>" \
  -H "Content-Type: application/json" \
  -d '{"event":"message:received","data":{"website_id":"test-site","session_id":"session_test","type":"note","from":"operator","content":"#card Test card from curl","user":{"nickname":"Tester"}}}'
```

Expected: `200`, and a card titled "Test card from curl" appears at the bottom of the configured list with a description linking to the Crisp conversation.

Also verify a bad token:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3000/api/integrations/crisp/wrong-token" \
  -H "Content-Type: application/json" -d '{}'
```

Expected: `404`.

- [ ] **Step 4: Real Crisp end-to-end (manual)**

1. In the Crisp dashboard, get the real Website ID (Settings → Workspace Settings → Setup instructions) and reconnect the integration with it.
2. Add the webhook URL in Crisp (Settings → Websites → your website → Web Hooks), subscribed to message events.
3. Open any conversation, write private note: `#card Customer reported login bug`.
4. Verify the card appears in the configured list in Kan.
5. Verify a regular chat message and a note without `#card` create nothing.

- [ ] **Step 5: Update the changelog if the repo convention asks for it**

Check `CHANGELOG.md` — if features are listed there per release, add a line under Unreleased; otherwise skip.
