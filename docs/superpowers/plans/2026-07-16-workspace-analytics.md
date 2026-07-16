# Workspace Analytics — Member Performance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-workspace analytics dashboard that tracks each member's performance (activity volume, completed cards, on-time/overdue, cycle time), backed by a new list-completion flag and an auto-archive automation.

**Architecture:** Reuse the existing `card_activity` log (no new event tracking). A list gains an `isCompleted` flag; when a card enters a completed list we stamp `card.completedAt`/`completedBy`. Analytics is a new tRPC router over a new `analytics.repo` that aggregates activities (attributed to the actor) and completed cards (attributed to assignees). Auto-archive is a secret-guarded Next.js API route hit by an external scheduler.

**Tech Stack:** TypeScript, Next.js 15 (pages router), React 18, tRPC v11, Drizzle ORM + Postgres, Tailwind + Headless UI, Lingui i18n, Vitest, recharts (new dependency).

## Global Constraints

- Node >= 20.18.1, pnpm 9.14.2. Run all commands from repo root unless noted.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- **publicId vs id:** every entity has an internal numeric `id` (never exposed) and a 12-char `publicId` used in all API inputs/outputs. Repos resolve publicId → id.
- **Soft deletes:** queries that read live rows filter `isNull(deletedAt)`.
- **Routers never touch Drizzle directly** — all data access goes through `packages/db/src/repository/*.repo.ts` functions that take `db` as the first argument.
- **New tRPC procedures** must include `.meta({ openapi: {...} })` plus zod `.input()`/`.output()` schemas (dual REST + tRPC transport), and use `protectedProcedure`.
- **New env vars** must be added to `turbo.json` `globalEnv` or turbo won't pass them through.
- **UI strings** use Lingui macros (`t\`...\`` from `@lingui/core/macro`, `<Trans>` from `@lingui/react/macro`); run `pnpm --filter @kan/web lingui:extract` then `lingui:compile` after adding strings.
- Chain order for Drizzle columns: type first, then `.notNull()`, then `.references(...)`; table ends with `.enableRLS()`.
- Attribution model (from spec): **activity** metrics → the acting member; **outcome** metrics (completed/on-time/cycle time) → the card's assignee(s).
- Completion definition (from spec): a card is completed when moved into a list with `isCompleted = true`; the moment is stored in `card.completedAt`. `card.archived` (manual delete) is NOT completion.

---

# PHASE 1 — Foundation: schema, completion tracking, list config, permissions

Independently shippable: after Phase 1 an admin can mark a list as "completed", and cards entering it get `completedAt` stamped. No dashboard yet.

---

### Task 1: Schema — add completion columns to `lists` and `cards`

**Files:**
- Modify: `packages/db/src/schema/lists.ts:2-11` (imports), `:18-38` (table)
- Modify: `packages/db/src/schema/cards.ts:58-88` (cards table)
- Create: `packages/db/migrations/<timestamp>_AddAnalyticsFields.sql` (generated)

**Interfaces:**
- Produces: `lists.isCompleted: boolean`, `lists.autoArchiveEnabled: boolean`, `lists.autoArchiveDays: number | null`; `cards.completedAt: Date | null`, `cards.completedBy: string | null`.

- [ ] **Step 1: Add `boolean` to the lists.ts import** — `packages/db/src/schema/lists.ts`. The current `drizzle-orm/pg-core` import block (lines 2-11) does not include `boolean`. Add it alphabetically:

```ts
import {
  bigint,
  bigserial,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Add the three columns to the `lists` table** — insert after the `discordRoleIds` line (currently line 37), before the closing `}).enableRLS();`:

```ts
  discordRoleIds: text("discordRoleIds"), // JSON array of Discord role ids
  isCompleted: boolean("isCompleted").notNull().default(false),
  autoArchiveEnabled: boolean("autoArchiveEnabled").notNull().default(false),
  autoArchiveDays: integer("autoArchiveDays"),
}).enableRLS();
```

- [ ] **Step 3: Add the two columns to the `cards` table** — `packages/db/src/schema/cards.ts`, inside the column object (after `dueDate` / `discordThreadId`, before the closing `},` of the columns object at ~line 84):

```ts
    dueDate: timestamp("dueDate"),
    discordThreadId: varchar("discordThreadId", { length: 32 }),
    completedAt: timestamp("completedAt"),
    completedBy: uuid("completedBy").references(() => users.id, {
      onDelete: "set null",
    }),
```

(`users` is already imported in cards.ts and `timestamp`/`uuid` are already used there — no new imports needed.)

- [ ] **Step 4: Generate the migration**

Run: `cd packages/db && pnpm with-env drizzle-kit generate --name AddAnalyticsFields`
Expected: a new file `packages/db/migrations/<timestamp>_AddAnalyticsFields.sql` containing `ALTER TABLE "list" ADD COLUMN "isCompleted" boolean DEFAULT false NOT NULL;` (and the other four columns), plus a new `meta/<timestamp>_snapshot.json` and an updated `meta/_journal.json`.

- [ ] **Step 5: Apply the migration and typecheck**

Run: `pnpm db:migrate`
Expected: migration applies with no error.
Run: `pnpm --filter @kan/db typecheck` (or `pnpm typecheck`)
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/lists.ts packages/db/src/schema/cards.ts packages/db/migrations
git commit -m "feat(db): add list completion flags and card completedAt columns"
```

---

### Task 2: Stamp `card.completedAt` when a card enters/leaves a completed list

**Files:**
- Modify: `packages/db/src/repository/list.repo.ts` (getByPublicId — include completion fields)
- Modify: `packages/db/src/repository/card.repo.ts` (getByPublicId `with.list` — include `isCompleted`; add `setCompletedAt`/`clearCompletedAt`)
- Modify: `packages/api/src/routers/card.ts:1047-1055` (hook into the list-change block)
- Test: `packages/api/src/routers/card-completion.test.ts` (create)

**Interfaces:**
- Consumes: `lists.isCompleted` (Task 1).
- Produces: `cardRepo.setCompletedAt(db, { cardId: number; completedAt: Date; completedBy: string })`, `cardRepo.clearCompletedAt(db, { cardId: number })`. `listRepo.getByPublicId` now returns `isCompleted`, `autoArchiveEnabled`, `autoArchiveDays`. `cardRepo.getByPublicId` now returns `list.isCompleted`.

- [ ] **Step 1: Write the failing test** — `packages/api/src/routers/card-completion.test.ts`. Mirror the mock style of `board-move.test.ts` (mock every repo the card router imports + `../utils/permissions`, lazy-import the router inside the test):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/card.repo", () => ({
  getByPublicId: vi.fn(),
  reorder: vi.fn(),
  update: vi.fn(),
  setCompletedAt: vi.fn(),
  clearCompletedAt: vi.fn(),
  create: vi.fn(),
  getWorkspaceAndListIdByListId: vi.fn(),
}));
vi.mock("@kan/db/repository/list.repo", () => ({ getByPublicId: vi.fn() }));
vi.mock("@kan/db/repository/cardActivity.repo", () => ({ create: vi.fn(), bulkCreate: vi.fn() }));
vi.mock("@kan/db/repository/label.repo", () => ({}));
vi.mock("@kan/db/repository/workspace.repo", () => ({ getByPublicId: vi.fn() }));
vi.mock("../utils/permissions", () => ({
  assertCanEdit: vi.fn(),
  assertCanDelete: vi.fn(),
  assertPermission: vi.fn(),
}));
vi.mock("@kan/shared/utils", () => ({ generateUID: vi.fn(() => "abc123") }));

import * as cardRepo from "@kan/db/repository/card.repo";
import * as listRepo from "@kan/db/repository/list.repo";

const mockCardGet = cardRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockReorder = cardRepo.reorder as ReturnType<typeof vi.fn>;
const mockListGet = listRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockSetCompleted = cardRepo.setCompletedAt as ReturnType<typeof vi.fn>;
const mockClearCompleted = cardRepo.clearCompletedAt as ReturnType<typeof vi.fn>;

describe("card.update completion tracking", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-1", name: "T", email: "t@e.com" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReorder.mockResolvedValue({ id: 5 });
  });

  it("stamps completedAt when moved into a completed list", async () => {
    const { cardRouter } = await import("./card");
    mockCardGet.mockResolvedValue({
      id: 5, publicId: "card-000000001", listId: 10,
      list: { publicId: "list-old0001", name: "Doing", isCompleted: false },
      title: "x", description: null, dueDate: null,
    });
    mockListGet.mockResolvedValue({ id: 20, publicId: "list-done0001", isCompleted: true });

    const ctx = { user: mockUser, db: mockDb } as never;
    await cardRouter.createCaller(ctx).update({
      cardPublicId: "card-000000001",
      listPublicId: "list-done0001",
    });

    expect(mockSetCompleted).toHaveBeenCalledWith(mockDb, {
      cardId: 5, completedAt: expect.any(Date), completedBy: "user-1",
    });
    expect(mockClearCompleted).not.toHaveBeenCalled();
  });

  it("clears completedAt when moved out of a completed list into a normal list", async () => {
    const { cardRouter } = await import("./card");
    mockCardGet.mockResolvedValue({
      id: 5, publicId: "card-000000001", listId: 20,
      list: { publicId: "list-done0001", name: "Done", isCompleted: true },
      title: "x", description: null, dueDate: null,
    });
    mockListGet.mockResolvedValue({ id: 10, publicId: "list-todo0001", isCompleted: false });

    const ctx = { user: mockUser, db: mockDb } as never;
    await cardRouter.createCaller(ctx).update({
      cardPublicId: "card-000000001",
      listPublicId: "list-todo0001",
    });

    expect(mockClearCompleted).toHaveBeenCalledWith(mockDb, { cardId: 5 });
    expect(mockSetCompleted).not.toHaveBeenCalled();
  });
});
```

> Note: the exact `vi.mock` list must cover every module `card.ts` imports — open `card.ts` head and add a `vi.fn()` for each named repo export it uses. Missing one throws at import time; add it and re-run.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/routers/card-completion.test.ts`
Expected: FAIL — `setCompletedAt`/`clearCompletedAt` not called (functions don't exist yet / hook not added).

- [ ] **Step 3: Extend `listRepo.getByPublicId` to return completion fields** — `packages/db/src/repository/list.repo.ts`. Find `getByPublicId` and add the three columns to its selected columns so the card router can read `newList.isCompleted`:

```ts
export const getByPublicId = (db: dbClient, listPublicId: string) => {
  return db.query.lists.findFirst({
    columns: {
      id: true,
      publicId: true,
      isCompleted: true,
      autoArchiveEnabled: true,
      autoArchiveDays: true,
    },
    where: and(eq(lists.publicId, listPublicId), isNull(lists.deletedAt)),
  });
};
```

(Keep any columns the existing implementation already returns; only ensure `isCompleted`, `autoArchiveEnabled`, `autoArchiveDays` are present.)

- [ ] **Step 4: Extend `cardRepo.getByPublicId`'s `list` sub-select** — `packages/db/src/repository/card.repo.ts:253-269`, add `isCompleted` to the nested list columns:

```ts
    with: {
      list: { columns: { publicId: true, name: true, isCompleted: true } },
    },
```

- [ ] **Step 5: Add `setCompletedAt` / `clearCompletedAt` to card.repo** — `packages/db/src/repository/card.repo.ts` (near `update`, ~line 230):

```ts
export const setCompletedAt = async (
  db: dbClient,
  args: { cardId: number; completedAt: Date; completedBy: string },
) => {
  await db
    .update(cards)
    .set({ completedAt: args.completedAt, completedBy: args.completedBy })
    .where(eq(cards.id, args.cardId));
};

export const clearCompletedAt = async (
  db: dbClient,
  args: { cardId: number },
) => {
  await db
    .update(cards)
    .set({ completedAt: null, completedBy: null })
    .where(eq(cards.id, args.cardId));
};
```

(`cards`, `db`, `eq` are already imported in card.repo.ts.)

- [ ] **Step 6: Hook the logic into the card router** — `packages/api/src/routers/card.ts`. Inside the existing list-change block (lines 1047-1055), after pushing the activity, add the completion maintenance. `existingCard` (from `cardRepo.getByPublicId`, ~line 916) now carries `existingCard.list.isCompleted`; `newList` (from `listRepo.getByPublicId`, ~line 934) now carries `newList.isCompleted`:

```ts
      if (newListId && existingCard.listId !== newListId) {
        activities.push({
          type: "card.updated.list" as const,
          cardId: result.id,
          createdBy: userId,
          fromListId: existingCard.listId,
          toListId: newListId,
        });

        if (newList?.isCompleted) {
          await cardRepo.setCompletedAt(ctx.db, {
            cardId: existingCard.id,
            completedAt: new Date(),
            completedBy: userId,
          });
        } else if (existingCard.list?.isCompleted) {
          await cardRepo.clearCompletedAt(ctx.db, { cardId: existingCard.id });
        }
      }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/routers/card-completion.test.ts`
Expected: PASS (both cases).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm typecheck`
Expected: passes.

```bash
git add packages/db/src/repository/list.repo.ts packages/db/src/repository/card.repo.ts packages/api/src/routers/card.ts packages/api/src/routers/card-completion.test.ts
git commit -m "feat(card): stamp completedAt when card enters or leaves a completed list"
```

---

### Task 3: List completion config — router/repo + backfill on toggle

**Files:**
- Modify: `packages/db/src/repository/list.repo.ts` (add `updateCompletionConfig`)
- Modify: `packages/db/src/repository/card.repo.ts` (add `backfillCompletedAtForList`, `clearCompletedAtForList`)
- Modify: `packages/api/src/routers/list.ts:160-224` (input schema + dispatch)
- Modify: `packages/api/src/schemas/list.ts:10-13` (output schema)
- Test: `packages/api/src/routers/list-completion.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 columns; `cardRepo` completion setters (Task 2).
- Produces: `listRepo.updateCompletionConfig(db, { listPublicId, isCompleted?, autoArchiveEnabled?, autoArchiveDays? })`; `cardRepo.backfillCompletedAtForList(db, { listId, completedBy })`; `cardRepo.clearCompletedAtForList(db, { listId })`. `list.update` accepts `isCompleted`/`autoArchiveEnabled`/`autoArchiveDays`.

- [ ] **Step 1: Write the failing test** — `packages/api/src/routers/list-completion.test.ts`. Mock list.repo, card.repo, workspace.repo, permissions; assert that toggling `isCompleted: true` calls `updateCompletionConfig` then `backfillCompletedAtForList`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/list.repo", () => ({
  getByPublicId: vi.fn(),
  getWorkspaceAndBoardIdByListPublicId: vi.fn(),
  updateCompletionConfig: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  updateDiscordConfig: vi.fn(),
}));
vi.mock("@kan/db/repository/card.repo", () => ({
  backfillCompletedAtForList: vi.fn(),
  clearCompletedAtForList: vi.fn(),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({ getByPublicId: vi.fn() }));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn(), assertCanEdit: vi.fn() }));

import * as listRepo from "@kan/db/repository/list.repo";
import * as cardRepo from "@kan/db/repository/card.repo";

const mockUpdateConfig = listRepo.updateCompletionConfig as ReturnType<typeof vi.fn>;
const mockGetListMeta = listRepo.getWorkspaceAndBoardIdByListPublicId as ReturnType<typeof vi.fn>;
const mockBackfill = cardRepo.backfillCompletedAtForList as ReturnType<typeof vi.fn>;
const mockClearAll = cardRepo.clearCompletedAtForList as ReturnType<typeof vi.fn>;

describe("list.update completion config", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-1", name: "T", email: "t@e.com" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetListMeta.mockResolvedValue({ id: 20, workspaceId: 7 });
    mockUpdateConfig.mockResolvedValue({ publicId: "list-done0001", name: "Done" });
  });

  it("backfills completedAt when a list is marked completed", async () => {
    const { listRouter } = await import("./list");
    const ctx = { user: mockUser, db: mockDb } as never;
    await listRouter.createCaller(ctx).update({
      listPublicId: "list-done0001",
      isCompleted: true,
    });
    expect(mockUpdateConfig).toHaveBeenCalledWith(mockDb, {
      listPublicId: "list-done0001",
      isCompleted: true,
      autoArchiveEnabled: undefined,
      autoArchiveDays: undefined,
    });
    expect(mockBackfill).toHaveBeenCalledWith(mockDb, { listId: 20, completedBy: "user-1" });
  });

  it("clears completedAt when a list is un-marked", async () => {
    const { listRouter } = await import("./list");
    const ctx = { user: mockUser, db: mockDb } as never;
    await listRouter.createCaller(ctx).update({
      listPublicId: "list-done0001",
      isCompleted: false,
    });
    expect(mockClearAll).toHaveBeenCalledWith(mockDb, { listId: 20 });
  });
});
```

> The helper `getWorkspaceAndBoardIdByListPublicId` may already exist under a different name in `list.repo.ts` (the list router already resolves a list's workspace for `assertPermission`). Reuse whatever the existing `list.update` procedure uses to get the list's numeric id + workspaceId; adjust the mock name to match. If none returns the numeric `id`, add `id` to that repo function's selection.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/routers/list-completion.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add repo `updateCompletionConfig`** — `packages/db/src/repository/list.repo.ts`, mirroring `updateDiscordConfig`'s optional-field spread style:

```ts
export const updateCompletionConfig = async (
  db: dbClient,
  args: {
    listPublicId: string;
    isCompleted?: boolean;
    autoArchiveEnabled?: boolean;
    autoArchiveDays?: number | null;
  },
) => {
  const [result] = await db
    .update(lists)
    .set({
      ...(args.isCompleted !== undefined && { isCompleted: args.isCompleted }),
      ...(args.autoArchiveEnabled !== undefined && {
        autoArchiveEnabled: args.autoArchiveEnabled,
      }),
      ...(args.autoArchiveDays !== undefined && {
        autoArchiveDays: args.autoArchiveDays,
      }),
    })
    .where(and(eq(lists.publicId, args.listPublicId), isNull(lists.deletedAt)))
    .returning({ publicId: lists.publicId, name: lists.name });
  return result;
};
```

- [ ] **Step 4: Add card.repo backfill helpers** — `packages/db/src/repository/card.repo.ts`. Use `sql` for the correlated backfill (import `sql` from `drizzle-orm` if not already imported):

```ts
export const backfillCompletedAtForList = async (
  db: dbClient,
  args: { listId: number; completedBy: string },
) => {
  await db.execute(sql`
    UPDATE "card" SET
      "completedAt" = COALESCE(
        (SELECT MAX(a."createdAt") FROM "card_activity" a
          WHERE a."cardId" = "card"."id" AND a."toListId" = ${args.listId}),
        "card"."createdAt"),
      "completedBy" = ${args.completedBy}
    WHERE "card"."listId" = ${args.listId}
      AND "card"."deletedAt" IS NULL
      AND "card"."completedAt" IS NULL
  `);
};

export const clearCompletedAtForList = async (
  db: dbClient,
  args: { listId: number },
) => {
  await db
    .update(cards)
    .set({ completedAt: null, completedBy: null })
    .where(and(eq(cards.listId, args.listId), isNull(cards.deletedAt)));
};
```

- [ ] **Step 5: Extend the list router `update` procedure** — `packages/api/src/routers/list.ts`. Add fields to the zod input (lines 160-168):

```ts
      z.object({
        listPublicId: z.string().min(12),
        name: z.string().min(1).optional(),
        index: z.number().optional(),
        discordBehaviour: z
          .enum(["create_thread", "notify"])
          .nullable()
          .optional(),
        discordRoleIds: z.array(z.string().max(32).regex(/^\d+$/)).max(25).optional(),
        isCompleted: z.boolean().optional(),
        autoArchiveEnabled: z.boolean().optional(),
        autoArchiveDays: z.number().int().min(1).max(365).nullable().optional(),
      }),
```

Then add a dispatch branch alongside the existing `if (input.name)` / `if (input.index)` blocks (after ~line 224). Use whatever the procedure already resolved for the list's numeric id + workspaceId (call it `listMeta` here):

```ts
      if (
        input.isCompleted !== undefined ||
        input.autoArchiveEnabled !== undefined ||
        input.autoArchiveDays !== undefined
      ) {
        result = await listRepo.updateCompletionConfig(ctx.db, {
          listPublicId: input.listPublicId,
          isCompleted: input.isCompleted,
          autoArchiveEnabled: input.autoArchiveEnabled,
          autoArchiveDays: input.autoArchiveDays,
        });

        if (input.isCompleted === true) {
          await cardRepo.backfillCompletedAtForList(ctx.db, {
            listId: listMeta.id,
            completedBy: userId,
          });
        } else if (input.isCompleted === false) {
          await cardRepo.clearCompletedAtForList(ctx.db, { listId: listMeta.id });
        }
      }
```

Add `import * as cardRepo from "@kan/db/repository/card.repo";` to list.ts if absent. Ensure the procedure resolves `listMeta` (numeric `id` + `workspaceId`) and calls `assertPermission(ctx.db, userId, listMeta.workspaceId, "list:edit")` before mutating — follow the existing pattern already in this procedure.

- [ ] **Step 6: Extend the output schema** — `packages/api/src/schemas/list.ts:10-13`. The `updateCompletionConfig` repo returns `{ publicId, name }`, matching the existing `listUpdateResponseSchema`, so no change is required unless you choose to return the new fields. Leave as-is:

```ts
export const listUpdateResponseSchema = z.object({
  publicId: z.string(),
  name: z.string(),
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/routers/list-completion.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm typecheck`

```bash
git add packages/db/src/repository/list.repo.ts packages/db/src/repository/card.repo.ts packages/api/src/routers/list.ts packages/api/src/routers/list-completion.test.ts
git commit -m "feat(list): configure completion + auto-archive, backfill completedAt on toggle"
```

---

### Task 4: Permissions — add `analytics:view` and `analytics:view:all`

**Files:**
- Modify: `packages/shared/src/permissions.ts:20-45` (allPermissions), `:60-86` (defaultRolePermissions.member)
- Test: `packages/shared/src/permissions.test.ts` (create, if none exists)

**Interfaces:**
- Produces: `Permission` union now includes `"analytics:view"` and `"analytics:view:all"`; `admin` gets both (via `allPermissions`), `member` gets `"analytics:view"`, `guest` gets neither.

- [ ] **Step 1: Write the failing test** — `packages/shared/src/permissions.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { defaultRolePermissions, getDefaultPermissions } from "./permissions";

describe("analytics permissions", () => {
  it("grants admin both analytics permissions", () => {
    const admin = getDefaultPermissions("admin");
    expect(admin).toContain("analytics:view");
    expect(admin).toContain("analytics:view:all");
  });
  it("grants member only own-view analytics", () => {
    expect(defaultRolePermissions.member).toContain("analytics:view");
    expect(defaultRolePermissions.member).not.toContain("analytics:view:all");
  });
  it("grants guest no analytics", () => {
    expect(defaultRolePermissions.guest).not.toContain("analytics:view");
    expect(defaultRolePermissions.guest).not.toContain("analytics:view:all");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kan/shared exec vitest run src/permissions.test.ts`
Expected: FAIL (`@kan/shared` may need a `vitest` devDep + a `test` script — if the filter errors with "no test script", run `pnpm --filter @kan/shared exec vitest run` and, if vitest is missing, place this test under `packages/api` instead importing from `@kan/shared`). Prefer keeping it in `@kan/api` if `@kan/shared` has no test tooling: create `packages/api/src/analytics-permissions.test.ts` with the same body importing from `@kan/shared`.

- [ ] **Step 3: Add the permissions to `allPermissions`** — `packages/shared/src/permissions.ts`, append inside the `as const` array (after `"member:remove"`):

```ts
  "member:remove",
  "analytics:view",
  "analytics:view:all",
] as const;
```

- [ ] **Step 4: Grant `analytics:view` to `member`** — in `defaultRolePermissions.member` (ends with `"member:view",`), add:

```ts
    "member:view",
    "analytics:view",
  ],
```

(admin already receives both via `admin: allPermissions`; guest is left unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: the command from Step 2.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/permissions.ts packages/api/src/analytics-permissions.test.ts packages/shared/src/permissions.test.ts
git commit -m "feat(shared): add analytics:view and analytics:view:all permissions"
```

(Only add the test file that actually exists.)

---

### Task 5: List config UI — "Mark as completed" + auto-archive controls

**Files:**
- Modify: the board list header/dropdown component under `apps/web/src/views/board/components/` (the menu that renders list rename/delete). Locate with: `grep -rl "listPublicId" apps/web/src/views/board/components/`.
- Uses: `api.list.update` mutation.

**Interfaces:**
- Consumes: `list.update` accepting `isCompleted`/`autoArchiveEnabled`/`autoArchiveDays` (Task 3).

- [ ] **Step 1: Find the list dropdown component**

Run: `grep -rln "api.list.update\|list.update.useMutation\|ListDropdown\|listPublicId" apps/web/src/views/board/components/`
Read the file that renders the per-list menu (rename/delete). Note how it obtains the list's `publicId` and `isCompleted` (you may need to thread `isCompleted`/`autoArchiveEnabled`/`autoArchiveDays` from the board query — see Step 4).

- [ ] **Step 2: Ensure the board query returns the new list fields**

Run: `grep -rn "isCompleted\|columns:\|with:" packages/db/src/repository/board.repo.ts | head`
In the repo function that loads a board with its lists (the one the board view uses), add `isCompleted`, `autoArchiveEnabled`, `autoArchiveDays` to the lists column selection so the UI can render current state. Add matching fields to the board output zod schema in `packages/api/src/schemas/` if the board procedure declares an explicit `.output()`.

- [ ] **Step 3: Add the toggle UI** — in the list dropdown component, add a menu item / toggle. Use the existing mutation + `api.useUtils()` invalidation pattern already in that file. Concrete control (Lingui `t` macro, Headless UI `Switch` if the codebase uses it — otherwise a checkbox styled with Tailwind):

```tsx
import { t } from "@lingui/core/macro";
// inside the component, near the existing update mutation:
const utils = api.useUtils();
const updateList = api.list.update.useMutation({
  onSuccess: () => utils.board.byId.invalidate(),
});

// menu content:
<label className="flex items-center justify-between px-3 py-2 text-sm">
  <span>{t`Mark as completed column`}</span>
  <input
    type="checkbox"
    checked={!!list.isCompleted}
    onChange={(e) =>
      updateList.mutate({
        listPublicId: list.publicId,
        isCompleted: e.target.checked,
      })
    }
  />
</label>

{list.isCompleted && (
  <div className="px-3 py-2 text-sm">
    <label className="flex items-center justify-between">
      <span>{t`Auto-archive completed cards`}</span>
      <input
        type="checkbox"
        checked={!!list.autoArchiveEnabled}
        onChange={(e) =>
          updateList.mutate({
            listPublicId: list.publicId,
            autoArchiveEnabled: e.target.checked,
          })
        }
      />
    </label>
    {list.autoArchiveEnabled && (
      <input
        type="number"
        min={1}
        max={365}
        defaultValue={list.autoArchiveDays ?? 3}
        className="mt-2 w-20 rounded border px-2 py-1"
        onBlur={(e) =>
          updateList.mutate({
            listPublicId: list.publicId,
            autoArchiveDays: Number(e.target.value),
          })
        }
      />
    )}
  </div>
)}
```

Match the surrounding component's exact class names / menu-item markup (Headless UI `Menu.Item` etc.) rather than the placeholder markup above; the logic (which mutation fields to send) is the fixed part.

- [ ] **Step 4: Extract + compile i18n strings**

Run: `pnpm --filter @kan/web lingui:extract && pnpm --filter @kan/web lingui:compile`
Expected: new message ids for the added strings appear in `apps/web/src/locales/en/messages.*`.

- [ ] **Step 5: Verify end-to-end** — use the `verify` skill (or manual): `pnpm dev:next`, open a board, mark a list as completed, confirm the toggle persists after reload and that moving a card into that list sets `completedAt` (check via `pnpm db:studio`).

Run: `pnpm typecheck && pnpm lint`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src packages/db/src/repository/board.repo.ts packages/api/src/schemas
git commit -m "feat(board): list config UI for completed column and auto-archive"
```

---

# PHASE 2 — Analytics dashboard

Depends on Phase 1. Delivers the `/analytics` route with KPIs, a trend chart, and a per-member table, respecting admin-vs-member access.

---

### Task 6: `analytics.repo` — aggregation queries

**Files:**
- Create: `packages/db/src/repository/analytics.repo.ts`

**Interfaces:**
- Consumes: `cards.completedAt`, `cardToWorkspaceMembers`, `cardActivities`, `lists`, `boards`, `workspaceMembers`.
- Produces (all take `db` first, then a filter object `F = { workspaceId: number; from: Date; to: Date; boardId?: number; memberId?: number }`):
  - `getActivityCountsByMember(db, F): Promise<{ workspaceMemberId: number; count: number }[]>`
  - `getCompletedCountByMember(db, F): Promise<{ workspaceMemberId: number; count: number }[]>`
  - `getOnTimeStatsByMember(db, F): Promise<{ workspaceMemberId: number; onTime: number; late: number }[]>`
  - `getCurrentlyOverdueByMember(db, { workspaceId, boardId?, memberId? }): Promise<{ workspaceMemberId: number; count: number }[]>`
  - `getAvgCycleTimeByMember(db, F): Promise<{ workspaceMemberId: number; avgSeconds: number }[]>`
  - `getActivityTimeSeries(db, F): Promise<{ day: string; count: number }[]>`

- [ ] **Step 1: Create the repo file with imports + filter type**

```ts
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";

import type { dbClient } from "../client";
import {
  boards,
  cardActivities,
  cards,
  cardToWorkspaceMembers,
  lists,
  workspaceMembers,
} from "../schema";

interface Filter {
  workspaceId: number;
  from: Date;
  to: Date;
  boardId?: number;
  memberId?: number;
}
```

- [ ] **Step 2: Activity counts by acting member** — activity attributed to the actor; map `cardActivities.createdBy` (userId) → `workspaceMembers.id` within the workspace:

```ts
export const getActivityCountsByMember = (db: dbClient, f: Filter) => {
  return db
    .select({
      workspaceMemberId: workspaceMembers.id,
      count: sql<number>`count(*)::int`,
    })
    .from(cardActivities)
    .innerJoin(cards, eq(cards.id, cardActivities.cardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, cardActivities.createdBy),
        eq(workspaceMembers.workspaceId, boards.workspaceId),
      ),
    )
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        gte(cardActivities.createdAt, f.from),
        lte(cardActivities.createdAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(workspaceMembers.id, f.memberId) : undefined,
      ),
    )
    .groupBy(workspaceMembers.id);
};
```

- [ ] **Step 3: Completed count by assignee** — outcome attributed to assignees via `cardToWorkspaceMembers`:

```ts
export const getCompletedCountByMember = (db: dbClient, f: Filter) => {
  return db
    .select({
      workspaceMemberId: cardToWorkspaceMembers.workspaceMemberId,
      count: sql<number>`count(*)::int`,
    })
    .from(cards)
    .innerJoin(cardToWorkspaceMembers, eq(cardToWorkspaceMembers.cardId, cards.id))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        isNotNull(cards.completedAt),
        gte(cards.completedAt, f.from),
        lte(cards.completedAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId) : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};
```

- [ ] **Step 4: On-time vs late by assignee** — compare `completedAt` to `dueDate` (cards with no `dueDate` are excluded from this ratio):

```ts
export const getOnTimeStatsByMember = (db: dbClient, f: Filter) => {
  return db
    .select({
      workspaceMemberId: cardToWorkspaceMembers.workspaceMemberId,
      onTime: sql<number>`count(*) filter (where ${cards.completedAt} <= ${cards.dueDate})::int`,
      late: sql<number>`count(*) filter (where ${cards.completedAt} > ${cards.dueDate})::int`,
    })
    .from(cards)
    .innerJoin(cardToWorkspaceMembers, eq(cardToWorkspaceMembers.cardId, cards.id))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        isNotNull(cards.completedAt),
        isNotNull(cards.dueDate),
        gte(cards.completedAt, f.from),
        lte(cards.completedAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId) : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};
```

- [ ] **Step 5: Currently overdue by assignee** — not completed, past due, still live (not date-range-bounded):

```ts
export const getCurrentlyOverdueByMember = (
  db: dbClient,
  f: { workspaceId: number; boardId?: number; memberId?: number },
) => {
  return db
    .select({
      workspaceMemberId: cardToWorkspaceMembers.workspaceMemberId,
      count: sql<number>`count(*)::int`,
    })
    .from(cards)
    .innerJoin(cardToWorkspaceMembers, eq(cardToWorkspaceMembers.cardId, cards.id))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        isNull(cards.completedAt),
        isNull(cards.deletedAt),
        isNotNull(cards.dueDate),
        sql`${cards.dueDate} < now()`,
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId) : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};
```

- [ ] **Step 6: Average cycle time by assignee** — seconds between `createdAt` and `completedAt`:

```ts
export const getAvgCycleTimeByMember = (db: dbClient, f: Filter) => {
  return db
    .select({
      workspaceMemberId: cardToWorkspaceMembers.workspaceMemberId,
      avgSeconds: sql<number>`coalesce(avg(extract(epoch from (${cards.completedAt} - ${cards.createdAt}))), 0)::float`,
    })
    .from(cards)
    .innerJoin(cardToWorkspaceMembers, eq(cardToWorkspaceMembers.cardId, cards.id))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        isNotNull(cards.completedAt),
        gte(cards.completedAt, f.from),
        lte(cards.completedAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId) : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};
```

- [ ] **Step 7: Activity time series** — per-day activity counts for the trend chart:

```ts
export const getActivityTimeSeries = (db: dbClient, f: Filter) => {
  return db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${cardActivities.createdAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(cardActivities)
    .innerJoin(cards, eq(cards.id, cardActivities.cardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, cardActivities.createdBy),
        eq(workspaceMembers.workspaceId, boards.workspaceId),
      ),
    )
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        gte(cardActivities.createdAt, f.from),
        lte(cardActivities.createdAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(workspaceMembers.id, f.memberId) : undefined,
      ),
    )
    .groupBy(sql`date_trunc('day', ${cardActivities.createdAt})`)
    .orderBy(sql`date_trunc('day', ${cardActivities.createdAt})`);
};
```

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @kan/db typecheck`
Expected: passes. (Drizzle's `and(...)` accepts `undefined` members and drops them, so the optional filters compile.)

> Correctness of these aggregations is verified end-to-end in Task 10's verification step (seed data → dashboard shows expected numbers) using the `verify` skill, since this repo's unit tests mock the DB and do not exercise SQL.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/repository/analytics.repo.ts
git commit -m "feat(db): analytics aggregation repository"
```

---

### Task 7: `analytics` router — procedures + access control

**Files:**
- Create: `packages/api/src/routers/analytics.ts`
- Create: `packages/api/src/schemas/analytics.ts`
- Modify: `packages/api/src/root.ts` (register router)
- Test: `packages/api/src/routers/analytics.test.ts` (create)

**Interfaces:**
- Consumes: `analytics.repo` (Task 6); `workspaceRepo.getByPublicId`; `permissionRepo.getMemberWithRole`; `hasPermission`; `memberRepo.getByPublicId`; `memberRepo` list-for-workspace.
- Produces: `analytics.getOverview`, `analytics.getMemberBreakdown`, `analytics.getTimeSeries`.

- [ ] **Step 1: Write the failing access-control test** — `packages/api/src/routers/analytics.test.ts`. The key testable behavior: a member WITHOUT `analytics:view:all` is forced to their own `memberId`; an admin WITH it may query any/all:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/analytics.repo", () => ({
  getActivityCountsByMember: vi.fn(async () => []),
  getCompletedCountByMember: vi.fn(async () => []),
  getOnTimeStatsByMember: vi.fn(async () => []),
  getCurrentlyOverdueByMember: vi.fn(async () => []),
  getAvgCycleTimeByMember: vi.fn(async () => []),
  getActivityTimeSeries: vi.fn(async () => []),
}));
vi.mock("@kan/db/repository/workspace.repo", () => ({ getByPublicId: vi.fn() }));
vi.mock("@kan/db/repository/member.repo", () => ({
  getByPublicId: vi.fn(),
  getAllByWorkspaceId: vi.fn(async () => []),
}));
vi.mock("@kan/db/repository/permission.repo", () => ({ getMemberWithRole: vi.fn() }));
vi.mock("../utils/permissions", () => ({
  assertPermission: vi.fn(),
  hasPermission: vi.fn(),
}));

import * as analyticsRepo from "@kan/db/repository/analytics.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import * as permissionRepo from "@kan/db/repository/permission.repo";
import { hasPermission } from "../utils/permissions";

const mockWsGet = workspaceRepo.getByPublicId as ReturnType<typeof vi.fn>;
const mockGetMemberWithRole = permissionRepo.getMemberWithRole as ReturnType<typeof vi.fn>;
const mockHasPermission = hasPermission as ReturnType<typeof vi.fn>;
const mockCompleted = analyticsRepo.getCompletedCountByMember as ReturnType<typeof vi.fn>;

describe("analytics.getMemberBreakdown access control", () => {
  const mockDb = {} as never;
  const mockUser = { id: "user-1", name: "T", email: "t@e.com" };
  const input = {
    workspacePublicId: "ws-0000000001",
    from: new Date("2026-06-01"),
    to: new Date("2026-07-01"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsGet.mockResolvedValue({ id: 7, publicId: "ws-0000000001" });
    mockGetMemberWithRole.mockResolvedValue({ id: 99, publicId: "mem-self0001", role: "member", roleId: null });
  });

  it("forces a non-admin member to their own memberId", async () => {
    const { analyticsRouter } = await import("./analytics");
    mockHasPermission.mockResolvedValue(false); // lacks analytics:view:all
    const ctx = { user: mockUser, db: mockDb } as never;

    await analyticsRouter.createCaller(ctx).getMemberBreakdown(input);

    // repo was called scoped to the caller's own member id (99), ignoring any memberPublicId
    expect(mockCompleted).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ workspaceId: 7, memberId: 99 }),
    );
  });

  it("lets an admin with view:all query the whole team (no member filter)", async () => {
    const { analyticsRouter } = await import("./analytics");
    mockHasPermission.mockResolvedValue(true);
    const ctx = { user: mockUser, db: mockDb } as never;

    await analyticsRouter.createCaller(ctx).getMemberBreakdown(input);

    expect(mockCompleted).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ workspaceId: 7, memberId: undefined }),
    );
  });

  it("rejects unauthenticated callers", async () => {
    const { analyticsRouter } = await import("./analytics");
    const ctx = { user: null, db: mockDb } as never;
    await expect(
      analyticsRouter.createCaller(ctx).getMemberBreakdown(input),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/routers/analytics.test.ts`
Expected: FAIL (router doesn't exist).

- [ ] **Step 3: Create the zod schemas** — `packages/api/src/schemas/analytics.ts`:

```ts
import { z } from "zod";

export const analyticsFilterSchema = z.object({
  workspacePublicId: z.string().min(12),
  from: z.coerce.date(),
  to: z.coerce.date(),
  boardPublicId: z.string().min(12).optional(),
  memberPublicId: z.string().min(12).optional(),
});

export const overviewResponseSchema = z.object({
  totalActivity: z.number(),
  completedCards: z.number(),
  onTimeRate: z.number(),
  avgCycleTimeSeconds: z.number(),
  previous: z.object({
    totalActivity: z.number(),
    completedCards: z.number(),
    onTimeRate: z.number(),
    avgCycleTimeSeconds: z.number(),
  }),
});

export const memberBreakdownResponseSchema = z.object({
  members: z.array(
    z.object({
      memberPublicId: z.string(),
      email: z.string(),
      activity: z.number(),
      completed: z.number(),
      onTime: z.number(),
      late: z.number(),
      overdue: z.number(),
      avgCycleTimeSeconds: z.number(),
    }),
  ),
});

export const timeSeriesResponseSchema = z.object({
  points: z.array(z.object({ day: z.string(), count: z.number() })),
});
```

- [ ] **Step 4: Create the router** — `packages/api/src/routers/analytics.ts`. Implements the shared resolve-and-scope helper (workspace lookup, caller member id, forced self-scoping), then the three procedures:

```ts
import { TRPCError } from "@trpc/server";

import * as analyticsRepo from "@kan/db/repository/analytics.repo";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import * as permissionRepo from "@kan/db/repository/permission.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import {
  analyticsFilterSchema,
  memberBreakdownResponseSchema,
  overviewResponseSchema,
  timeSeriesResponseSchema,
} from "../schemas/analytics";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { assertPermission, hasPermission } from "../utils/permissions";

// Resolve workspace + enforce member-vs-admin scoping. Returns the numeric
// filter object the repo expects, with memberId forced to the caller unless
// they hold analytics:view:all.
async function resolveScope(
  ctx: { db: never; user?: { id: string } | null },
  input: {
    workspacePublicId: string;
    from: Date;
    to: Date;
    boardPublicId?: string;
    memberPublicId?: string;
  },
) {
  const userId = ctx.user?.id;
  if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

  const workspace = await workspaceRepo.getByPublicId(ctx.db, input.workspacePublicId);
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });

  await assertPermission(ctx.db, userId, workspace.id, "analytics:view");

  const caller = await permissionRepo.getMemberWithRole(ctx.db, userId, workspace.id);
  if (!caller) throw new TRPCError({ code: "FORBIDDEN", message: "Not a member" });

  const canViewAll = await hasPermission(ctx.db, userId, workspace.id, "analytics:view:all");

  let memberId: number | undefined;
  if (!canViewAll) {
    memberId = caller.id; // forced to self
  } else if (input.memberPublicId) {
    const target = await memberRepo.getByPublicId(ctx.db, input.memberPublicId);
    if (!target || target.workspaceId !== workspace.id)
      throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    memberId = target.id;
  }

  let boardId: number | undefined;
  if (input.boardPublicId) {
    const board = await boardRepo.getByPublicId(ctx.db, input.boardPublicId);
    if (!board || board.workspaceId !== workspace.id)
      throw new TRPCError({ code: "NOT_FOUND", message: "Board not found" });
    boardId = board.id;
  }

  return {
    workspaceId: workspace.id,
    from: input.from,
    to: input.to,
    boardId,
    memberId,
    canViewAll,
  };
}

const sum = (rows: { count: number }[]) => rows.reduce((a, r) => a + r.count, 0);

export const analyticsRouter = createTRPCRouter({
  getOverview: protectedProcedure
    .meta({
      openapi: {
        summary: "Get workspace analytics overview",
        method: "GET",
        path: "/workspaces/{workspacePublicId}/analytics/overview",
        description: "KPI totals with previous-period comparison",
        tags: ["Analytics"],
        protect: true,
      },
    })
    .input(analyticsFilterSchema)
    .output(overviewResponseSchema)
    .query(async ({ ctx, input }) => {
      const scope = await resolveScope(ctx, input);
      const rangeMs = input.to.getTime() - input.from.getTime();
      const prevFrom = new Date(input.from.getTime() - rangeMs);
      const prevTo = input.from;

      const compute = async (from: Date, to: Date) => {
        const f = { ...scope, from, to };
        const [activity, completed, onTime, cycle] = await Promise.all([
          analyticsRepo.getActivityCountsByMember(ctx.db, f),
          analyticsRepo.getCompletedCountByMember(ctx.db, f),
          analyticsRepo.getOnTimeStatsByMember(ctx.db, f),
          analyticsRepo.getAvgCycleTimeByMember(ctx.db, f),
        ]);
        const onTimeTotal = onTime.reduce((a, r) => a + r.onTime, 0);
        const lateTotal = onTime.reduce((a, r) => a + r.late, 0);
        const denom = onTimeTotal + lateTotal;
        const avg =
          cycle.length > 0
            ? cycle.reduce((a, r) => a + r.avgSeconds, 0) / cycle.length
            : 0;
        return {
          totalActivity: sum(activity),
          completedCards: sum(completed),
          onTimeRate: denom > 0 ? onTimeTotal / denom : 0,
          avgCycleTimeSeconds: avg,
        };
      };

      const current = await compute(input.from, input.to);
      const previous = await compute(prevFrom, prevTo);
      return { ...current, previous };
    }),

  getMemberBreakdown: protectedProcedure
    .meta({
      openapi: {
        summary: "Get per-member analytics breakdown",
        method: "GET",
        path: "/workspaces/{workspacePublicId}/analytics/members",
        description: "Per-member performance rows",
        tags: ["Analytics"],
        protect: true,
      },
    })
    .input(analyticsFilterSchema)
    .output(memberBreakdownResponseSchema)
    .query(async ({ ctx, input }) => {
      const scope = await resolveScope(ctx, input);
      const [activity, completed, onTime, overdue, cycle, members] =
        await Promise.all([
          analyticsRepo.getActivityCountsByMember(ctx.db, scope),
          analyticsRepo.getCompletedCountByMember(ctx.db, scope),
          analyticsRepo.getOnTimeStatsByMember(ctx.db, scope),
          analyticsRepo.getCurrentlyOverdueByMember(ctx.db, scope),
          analyticsRepo.getAvgCycleTimeByMember(ctx.db, scope),
          memberRepo.getAllByWorkspaceId(ctx.db, scope.workspaceId),
        ]);

      const byId = <T extends { workspaceMemberId: number }>(rows: T[]) =>
        new Map(rows.map((r) => [r.workspaceMemberId, r]));
      const aMap = byId(activity);
      const cMap = byId(completed);
      const oMap = byId(onTime);
      const ovMap = byId(overdue);
      const cyMap = byId(cycle);

      const rows = members
        .filter((m) => (scope.memberId ? m.id === scope.memberId : true))
        .map((m) => ({
          memberPublicId: m.publicId,
          email: m.email,
          activity: aMap.get(m.id)?.count ?? 0,
          completed: cMap.get(m.id)?.count ?? 0,
          onTime: oMap.get(m.id)?.onTime ?? 0,
          late: oMap.get(m.id)?.late ?? 0,
          overdue: ovMap.get(m.id)?.count ?? 0,
          avgCycleTimeSeconds: cyMap.get(m.id)?.avgSeconds ?? 0,
        }));

      return { members: rows };
    }),

  getTimeSeries: protectedProcedure
    .meta({
      openapi: {
        summary: "Get analytics activity time series",
        method: "GET",
        path: "/workspaces/{workspacePublicId}/analytics/timeseries",
        description: "Per-day activity counts",
        tags: ["Analytics"],
        protect: true,
      },
    })
    .input(analyticsFilterSchema)
    .output(timeSeriesResponseSchema)
    .query(async ({ ctx, input }) => {
      const scope = await resolveScope(ctx, input);
      const points = await analyticsRepo.getActivityTimeSeries(ctx.db, scope);
      return { points };
    }),
});
```

> `memberRepo.getAllByWorkspaceId` and `boardRepo.getByPublicId` are assumed to exist. Verify names: `grep -n "export const get" packages/db/src/repository/member.repo.ts packages/db/src/repository/board.repo.ts`. If the member-list function has a different name (e.g. `getAllByWorkspacePublicId`), adjust the call and, if needed, resolve members by workspace numeric id (add a thin repo function returning `{ id, publicId, email }[]` for a workspace). Update the test mock name to match.

- [ ] **Step 5: Register the router** — `packages/api/src/root.ts`. Add the import and the `analytics` key:

```ts
import { analyticsRouter } from "./routers/analytics";
// ...
export const appRouter = createTRPCRouter({
  analytics: analyticsRouter,
  attachment: attachmentRouter,
  // ...existing keys...
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/routers/analytics.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck`

```bash
git add packages/api/src/routers/analytics.ts packages/api/src/schemas/analytics.ts packages/api/src/root.ts packages/api/src/routers/analytics.test.ts
git commit -m "feat(api): analytics router with member-scoped access control"
```

---

### Task 8: Add `recharts` + Analytics nav item

**Files:**
- Modify: `apps/web/package.json` (add recharts)
- Modify: `apps/web/src/components/ReactiveButton.tsx` (optional react-icons icon)
- Modify: `apps/web/src/components/SideNavigation.tsx` (nav entry)

**Interfaces:**
- Produces: `/analytics` nav link; `recharts` available in `apps/web`.

- [ ] **Step 1: Add recharts**

Run: `pnpm --filter @kan/web add recharts`
Expected: `recharts` appears in `apps/web/package.json` dependencies and installs.

- [ ] **Step 2: Let `ReactiveButton` accept a react-icons icon** — `apps/web/src/components/ReactiveButton.tsx`. It currently only renders a `<LottieIcon json={json} />`. Add an optional `iconComponent?: IconType` prop rendered when `json` is absent, sized to match. Add to the props type and imports:

```tsx
import type { IconType } from "react-icons";
// ...in props: iconComponent?: IconType;
// where the icon renders:
{json ? (
  <LottieIcon index={index} json={json} isPlaying={isHovered} />
) : Icon ? (
  <Icon className="h-5 w-5" />
) : null}
```

Destructure `iconComponent: Icon` in the component signature. Keep the existing Lottie path unchanged so current nav items are unaffected.

- [ ] **Step 3: Add the Analytics nav entry** — `apps/web/src/components/SideNavigation.tsx`. Import an icon and add an entry to the `navigation` array right after the Members entry (lines 127-138). Pass `iconComponent` instead of `icon` (Lottie `json`):

```tsx
import { HiChartBar } from "react-icons/hi2";
// ...inside the navigation array, after the Members entry:
{
  name: t`Analytics`,
  href: "/analytics",
  iconComponent: HiChartBar,
  keyboardShortcut: {
    type: "SEQUENCE",
    strokes: [{ key: "G" }, { key: "A" }],
    action: () => router.push("/analytics"),
    group: "NAVIGATION",
    description: t`Go to analytics`,
  },
},
```

In the render loop (lines 198-208) pass the new prop through: add `iconComponent={item.iconComponent}` to `<ReactiveButton .../>` and make `json={item.icon}` tolerate `undefined` (the Lottie item still has `icon`, the analytics item has `iconComponent`). Update the `navigation` array's TypeScript type if it's explicitly typed.

- [ ] **Step 4: Typecheck + i18n extract**

Run: `pnpm --filter @kan/web lingui:extract && pnpm --filter @kan/web lingui:compile && pnpm typecheck`
Expected: passes; "Analytics"/"Go to analytics" strings extracted.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src/components/ReactiveButton.tsx apps/web/src/components/SideNavigation.tsx pnpm-lock.yaml apps/web/src/locales
git commit -m "feat(web): add recharts and Analytics sidebar nav item"
```

---

### Task 9: Analytics page + view scaffold + filters

**Files:**
- Create: `apps/web/src/pages/analytics/index.tsx`
- Create: `apps/web/src/views/analytics/index.tsx`
- Create: `apps/web/src/views/analytics/components/AnalyticsFilters.tsx`

**Interfaces:**
- Consumes: `useWorkspace()`; `api.analytics.*`.
- Produces: `AnalyticsView` default export; filter state `{ from, to, boardPublicId?, memberPublicId? }`.

- [ ] **Step 1: Create the thin page** — `apps/web/src/pages/analytics/index.tsx` (copy the members page shape):

```tsx
import type { NextPageWithLayout } from "~/pages/_app";
import { getDashboardLayout } from "~/components/Dashboard";
import AnalyticsView from "~/views/analytics";

const AnalyticsPage: NextPageWithLayout = () => {
  return <AnalyticsView />;
};

AnalyticsPage.getLayout = (page) => getDashboardLayout(page);

export default AnalyticsPage;
```

- [ ] **Step 2: Create the view with filter state + data wiring** — `apps/web/src/views/analytics/index.tsx`:

```tsx
import { useState } from "react";

import { t } from "@lingui/core/macro";

import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";
import AnalyticsFilters from "./components/AnalyticsFilters";

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function AnalyticsView() {
  const { workspace } = useWorkspace();
  const [range, setRange] = useState(30);
  const [boardPublicId, setBoardPublicId] = useState<string | undefined>();
  const [memberPublicId, setMemberPublicId] = useState<string | undefined>();

  const filter = {
    workspacePublicId: workspace.publicId,
    from: daysAgo(range),
    to: new Date(),
    boardPublicId,
    memberPublicId,
  };
  const enabled = !!workspace.publicId && workspace.publicId.length >= 12;

  const overview = api.analytics.getOverview.useQuery(filter, { enabled });
  const breakdown = api.analytics.getMemberBreakdown.useQuery(filter, { enabled });
  const series = api.analytics.getTimeSeries.useQuery(filter, { enabled });

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-medium">{t`Analytics`}</h1>
      <AnalyticsFilters
        range={range}
        onRangeChange={setRange}
        boardPublicId={boardPublicId}
        onBoardChange={setBoardPublicId}
        memberPublicId={memberPublicId}
        onMemberChange={setMemberPublicId}
        workspacePublicId={workspace.publicId}
      />
      {/* KpiRow, TrendChart, MemberTable added in Task 10 */}
      <pre className="mt-4 text-xs opacity-50">
        {JSON.stringify(
          { overview: overview.data, breakdown: breakdown.data, series: series.data },
          null,
          2,
        )}
      </pre>
    </div>
  );
}
```

- [ ] **Step 3: Create the filters component** — `apps/web/src/views/analytics/components/AnalyticsFilters.tsx`. Time range as select (7/30/90); board select from `api.board.all`; member select from `api.member.list` (hidden when the member query is forbidden — a non-admin only sees themself, so render the member select only if more than one member is returned):

```tsx
import { t } from "@lingui/core/macro";

import { api } from "~/utils/api";

interface Props {
  range: number;
  onRangeChange: (n: number) => void;
  boardPublicId?: string;
  onBoardChange: (v: string | undefined) => void;
  memberPublicId?: string;
  onMemberChange: (v: string | undefined) => void;
  workspacePublicId: string;
}

export default function AnalyticsFilters(props: Props) {
  const enabled = props.workspacePublicId.length >= 12;
  const boards = api.board.all.useQuery(
    { workspacePublicId: props.workspacePublicId, type: "regular" },
    { enabled },
  );

  return (
    <div className="flex flex-wrap gap-3">
      <select
        value={props.range}
        onChange={(e) => props.onRangeChange(Number(e.target.value))}
        className="rounded border px-2 py-1 text-sm"
      >
        <option value={7}>{t`Last 7 days`}</option>
        <option value={30}>{t`Last 30 days`}</option>
        <option value={90}>{t`Last 90 days`}</option>
      </select>

      <select
        value={props.boardPublicId ?? ""}
        onChange={(e) => props.onBoardChange(e.target.value || undefined)}
        className="rounded border px-2 py-1 text-sm"
      >
        <option value="">{t`All boards`}</option>
        {boards.data?.map((b) => (
          <option key={b.publicId} value={b.publicId}>
            {b.name}
          </option>
        ))}
      </select>
    </div>
  );
}
```

> Confirm `api.board.all` returns `{ publicId, name }[]` (SideNavigation uses `api.board.all.useQuery({ workspacePublicId, type: "regular" })`). Adjust field access to the actual shape. The member select is added in Task 10 once admin-vs-member visibility is finalized.

- [ ] **Step 4: Verify the page loads**

Run: `pnpm dev:next`, navigate to `/analytics`.
Expected: the page renders, the JSON dump shows data (or empty structures) once a workspace is selected. Fix any query-shape errors surfaced here.

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/analytics apps/web/src/views/analytics apps/web/src/locales
git commit -m "feat(web): analytics page scaffold with filters"
```

---

### Task 10: Dashboard UI — KPI row, trend chart, member table

**Files:**
- Create: `apps/web/src/views/analytics/components/KpiRow.tsx`
- Create: `apps/web/src/views/analytics/components/TrendChart.tsx`
- Create: `apps/web/src/views/analytics/components/MemberTable.tsx`
- Modify: `apps/web/src/views/analytics/index.tsx` (render them), `AnalyticsFilters.tsx` (member select)

**Interfaces:**
- Consumes: `api.analytics.getOverview/getMemberBreakdown/getTimeSeries` data shapes (Task 7 schemas).

- [ ] **Step 1: Load the dataviz skill** — before writing chart code, invoke the `dataviz` skill for palette/label/legend guidance and apply it to `TrendChart`/`KpiRow`.

- [ ] **Step 2: KPI row** — `apps/web/src/views/analytics/components/KpiRow.tsx`. Four stat tiles with % change vs `previous`. Helper for delta:

```tsx
import { t } from "@lingui/core/macro";

interface Overview {
  totalActivity: number;
  completedCards: number;
  onTimeRate: number;
  avgCycleTimeSeconds: number;
  previous: {
    totalActivity: number;
    completedCards: number;
    onTimeRate: number;
    avgCycleTimeSeconds: number;
  };
}

function pctChange(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "0%" : "+100%";
  const d = ((cur - prev) / prev) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const days = seconds / 86400;
  if (days >= 1) return `${days.toFixed(1)}d`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export default function KpiRow({ data }: { data?: Overview }) {
  if (!data) return null;
  const tiles = [
    { label: t`Total activity`, value: String(data.totalActivity), delta: pctChange(data.totalActivity, data.previous.totalActivity) },
    { label: t`Completed cards`, value: String(data.completedCards), delta: pctChange(data.completedCards, data.previous.completedCards) },
    { label: t`On-time rate`, value: `${(data.onTimeRate * 100).toFixed(0)}%`, delta: pctChange(data.onTimeRate, data.previous.onTimeRate) },
    { label: t`Avg cycle time`, value: formatDuration(data.avgCycleTimeSeconds), delta: pctChange(data.avgCycleTimeSeconds, data.previous.avgCycleTimeSeconds) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-lg border border-light-300 p-4 dark:border-dark-300">
          <div className="text-xs text-neutral-500">{tile.label}</div>
          <div className="mt-1 text-2xl font-semibold">{tile.value}</div>
          <div className="text-xs text-neutral-400">{tile.delta}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Trend chart** — `apps/web/src/views/analytics/components/TrendChart.tsx` using recharts. Guard rendering to client (pages router SSR): recharts `ResponsiveContainer` is client-only, which is fine in a `useQuery`-driven component:

```tsx
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function TrendChart({ points }: { points?: { day: string; count: number }[] }) {
  if (!points?.length) return null;
  return (
    <div className="mt-4 h-64 w-full rounded-lg border border-light-300 p-4 dark:border-dark-300">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points}>
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Area type="monotone" dataKey="count" strokeWidth={2} fillOpacity={0.15} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

Apply the `dataviz` palette for stroke/fill colors (theme-aware) rather than recharts defaults.

- [ ] **Step 4: Member table** — `apps/web/src/views/analytics/components/MemberTable.tsx`:

```tsx
import { t } from "@lingui/core/macro";

interface Row {
  memberPublicId: string;
  email: string;
  activity: number;
  completed: number;
  onTime: number;
  late: number;
  overdue: number;
  avgCycleTimeSeconds: number;
}

export default function MemberTable({ rows }: { rows?: Row[] }) {
  if (!rows?.length) return null;
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-light-300 dark:border-dark-300">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-neutral-500">
          <tr>
            <th className="p-3">{t`Member`}</th>
            <th className="p-3">{t`Activity`}</th>
            <th className="p-3">{t`Completed`}</th>
            <th className="p-3">{t`On-time`}</th>
            <th className="p-3">{t`Overdue`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const done = r.onTime + r.late;
            return (
              <tr key={r.memberPublicId} className="border-t border-light-200 dark:border-dark-200">
                <td className="p-3">{r.email}</td>
                <td className="p-3">{r.activity}</td>
                <td className="p-3">{r.completed}</td>
                <td className="p-3">{done > 0 ? `${((r.onTime / done) * 100).toFixed(0)}%` : "—"}</td>
                <td className="p-3">{r.overdue}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Add the member select to filters** — `AnalyticsFilters.tsx`. Query `api.member.list` (confirm the real procedure name with `grep -n "list\|getAll" packages/api/src/routers/member.ts`). Render the select only when more than one member is returned (a non-admin sees only themself, so the select stays hidden for them):

```tsx
  const members = api.member.list.useQuery(
    { workspacePublicId: props.workspacePublicId },
    { enabled },
  );
  // ...in JSX, after the board select:
  {(members.data?.length ?? 0) > 1 && (
    <select
      value={props.memberPublicId ?? ""}
      onChange={(e) => props.onMemberChange(e.target.value || undefined)}
      className="rounded border px-2 py-1 text-sm"
    >
      <option value="">{t`All members`}</option>
      {members.data?.map((m) => (
        <option key={m.publicId} value={m.publicId}>
          {m.email}
        </option>
      ))}
    </select>
  )}
```

- [ ] **Step 6: Render the components in the view** — replace the `<pre>` dump in `index.tsx` with:

```tsx
      <KpiRow data={overview.data} />
      <TrendChart points={series.data?.points} />
      <MemberTable rows={breakdown.data?.members} />
```

and add the imports.

- [ ] **Step 7: Verify end-to-end (this validates Task 6's SQL)** — use the `verify` skill: `pnpm dev:next`, create a board with a "Done" list marked completed, assign members to cards, move some cards to Done (some before/after due dates), then open `/analytics`. Confirm: completed count matches, on-time rate reflects the due-date outcomes, activity totals are non-zero, the trend chart plots per-day activity, and the member table attributes completions to assignees (not the mover). Fix any aggregation discrepancies in `analytics.repo.ts`.

Run: `pnpm --filter @kan/web lingui:extract && pnpm --filter @kan/web lingui:compile && pnpm typecheck && pnpm lint`

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/views/analytics apps/web/src/locales
git commit -m "feat(web): analytics dashboard KPI row, trend chart, member table"
```

---

# PHASE 3 — Auto-archive automation

Depends on Phase 1. A secret-guarded endpoint archives cards that have sat in an auto-archive-enabled completed list past their configured days.

---

### Task 11: `CRON_SECRET` env wiring + stale-completed repo query

**Files:**
- Modify: `apps/web/src/env.ts` (server block)
- Modify: `turbo.json` (globalEnv)
- Modify: `.env.example`
- Modify: `packages/db/src/repository/card.repo.ts` (add `getStaleCompletedCards`)
- Test: `packages/db` has no unit harness for repos — validated in Task 12's endpoint test + verify.

**Interfaces:**
- Produces: `env.CRON_SECRET`; `cardRepo.getStaleCompletedCards(db): Promise<{ id: number }[]>`.

- [ ] **Step 1: Declare the env var** — `apps/web/src/env.ts`, add to the `server:` object:

```ts
    CRON_SECRET: z.string().optional(),
```

- [ ] **Step 2: Add to turbo globalEnv** — `turbo.json`. The array currently ends with `"KAN_API_TOKEN"` (no trailing comma). Add a comma and the new entry:

```json
    "KAN_API_TOKEN",
    "CRON_SECRET"
  ],
```

- [ ] **Step 3: Document in .env.example** — append under an appropriate section:

```
# Analytics auto-archive cron (optional)
CRON_SECRET= # Bearer token the scheduler sends to /api/cron/archive-completed
```

- [ ] **Step 4: Add the stale-completed query** — `packages/db/src/repository/card.repo.ts`. Selects live cards in auto-archive-enabled completed lists whose `completedAt` is older than the list's `autoArchiveDays`:

```ts
export const getStaleCompletedCards = (db: dbClient) => {
  return db
    .select({ id: cards.id })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(
      and(
        isNull(cards.deletedAt),
        isNotNull(cards.completedAt),
        eq(lists.isCompleted, true),
        eq(lists.autoArchiveEnabled, true),
        isNotNull(lists.autoArchiveDays),
        sql`${cards.completedAt} < now() - (${lists.autoArchiveDays} * interval '1 day')`,
      ),
    );
};
```

Ensure `lists`, `isNotNull`, and `sql` are imported in card.repo.ts (add to the existing `drizzle-orm` / schema imports if missing).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`

```bash
git add apps/web/src/env.ts turbo.json .env.example packages/db/src/repository/card.repo.ts
git commit -m "feat: CRON_SECRET env wiring and stale-completed card query"
```

---

### Task 12: Auto-archive cron endpoint

**Files:**
- Create: `apps/web/src/pages/api/cron/archive-completed.ts`
- Test: `apps/web/src/pages/api/cron/archive-completed.test.ts` (create)

**Interfaces:**
- Consumes: `cardRepo.getStaleCompletedCards`, `cardRepo.softDelete`, `cardActivityRepo.create`, `env.CRON_SECRET`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/pages/api/cron/archive-completed.test.ts`. Mock the db client + repos + env, drive the handler with a fake `req`/`res`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/client", () => ({ createDrizzleClient: () => ({}) }));
vi.mock("@kan/db/repository/card.repo", () => ({
  getStaleCompletedCards: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
  softDelete: vi.fn(async () => ({ id: 1, listId: 3, index: 0 })),
}));
vi.mock("@kan/db/repository/cardActivity.repo", () => ({ create: vi.fn() }));

import handler from "./archive-completed";
import * as cardRepo from "@kan/db/repository/card.repo";

const mockGetStale = cardRepo.getStaleCompletedCards as ReturnType<typeof vi.fn>;
const mockSoftDelete = cardRepo.softDelete as ReturnType<typeof vi.fn>;

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

describe("archive-completed cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects a missing/incorrect bearer token with 401", async () => {
    const req: any = { method: "POST", headers: { authorization: "Bearer wrong" } };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockGetStale).not.toHaveBeenCalled();
  });

  it("archives stale cards with a valid token", async () => {
    const req: any = { method: "POST", headers: { authorization: "Bearer s3cret" } };
    const res = mockRes();
    await handler(req, res);
    expect(mockSoftDelete).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ archived: 2 }));
  });
});
```

Run the file with: `pnpm --filter @kan/web exec vitest run src/pages/api/cron/archive-completed.test.ts`
Expected: FAIL (handler doesn't exist).

- [ ] **Step 2: Implement the endpoint** — `apps/web/src/pages/api/cron/archive-completed.ts`:

```ts
import { timingSafeEqual } from "crypto";

import type { NextApiRequest, NextApiResponse } from "next";

import { createDrizzleClient } from "@kan/db/client";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardRepo from "@kan/db/repository/card.repo";

const db = createDrizzleClient();

function validSecret(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ message: "CRON_SECRET not configured" });
  }

  if (!validSecret(req.headers.authorization)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const stale = await cardRepo.getStaleCompletedCards(db);
  const now = new Date();
  let archived = 0;

  for (const card of stale) {
    await cardRepo.softDelete(db, {
      cardId: card.id,
      deletedAt: now,
      deletedBy: null as unknown as string,
    });
    await cardActivityRepo.create(db, {
      type: "card.archived",
      cardId: card.id,
      createdBy: null as unknown as string,
    });
    archived += 1;
  }

  return res.status(200).json({ archived });
}
```

> `softDelete`'s current signature types `deletedBy: string`. Since auto-archive is a system action with no user, widen it to `deletedBy: string | null` in `card.repo.ts` (and pass `null`) rather than casting — update the signature to `{ cardId: number; deletedAt: Date; deletedBy: string | null }`. Likewise confirm `cardActivityRepo.create` accepts `createdBy: string` — the column is nullable in the schema, so widen `create`'s `createdBy` to `string | null` if you want a truthful system entry. Prefer widening the types over `as unknown as string`; the cast above is a fallback only if you choose not to touch the shared signatures.

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @kan/web exec vitest run src/pages/api/cron/archive-completed.test.ts`
Expected: PASS (both cases). If `apps/web` has no `exec vitest` wired, use the package's test script (`pnpm --filter @kan/web test -- src/pages/api/cron/archive-completed.test.ts`).

- [ ] **Step 4: Manual verify** — with `pnpm dev:next` running and `CRON_SECRET=s3cret` in `.env`, create a completed list with `autoArchiveEnabled` + `autoArchiveDays=1`, put a card there with `completedAt` older than 1 day (set via `db:studio`), then:

Run: `curl -X POST -H "Authorization: Bearer s3cret" http://localhost:3000/api/cron/archive-completed`
Expected: `{"archived":1}`, and the card is soft-deleted (gone from the board, `card.archived` activity created).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`

```bash
git add apps/web/src/pages/api/cron packages/db/src/repository/card.repo.ts packages/db/src/repository/cardActivity.repo.ts
git commit -m "feat(web): auto-archive completed cards via secret-guarded cron endpoint"
```

---

### Task 13: Scheduling docs

**Files:**
- Create: `apps/web/vercel.json` (or modify if present) — Vercel Cron entry
- Modify: `README.md` (self-host cron section)

**Interfaces:**
- Consumes: `/api/cron/archive-completed` (Task 12).

- [ ] **Step 1: Add a Vercel Cron entry** — `apps/web/vercel.json` (create if absent). Vercel Cron sends a GET by default; since the handler requires POST + bearer, document that Vercel Pro cron with a custom header is needed, OR change the handler to also accept Vercel's `Authorization` scheme. Simplest cross-platform: keep POST + bearer and document the self-host path as primary. Add:

```json
{
  "crons": [{ "path": "/api/cron/archive-completed", "schedule": "0 3 * * *" }]
}
```

> Note in the docs that Vercel Cron requires the endpoint to accept the request Vercel sends (GET, with `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set as a Vercel env var per their cron-security convention). If deploying on Vercel, adjust the handler's method guard to allow GET as well and rely on the bearer check. Keep POST for self-host/manual triggers.

- [ ] **Step 2: Document the self-host cron** — add a section to `README.md`:

```markdown
### Auto-archiving completed cards (optional)

Set `CRON_SECRET` in your environment, then schedule a daily request to the
archive endpoint. Example crontab (runs at 03:00):

    0 3 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-kan-host/api/cron/archive-completed

Cards sitting in a list marked "completed" with auto-archive enabled are
archived once they have been complete for the configured number of days.
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/vercel.json README.md
git commit -m "docs: schedule the auto-archive cron for Vercel and self-host"
```

---

## Self-Review notes (already applied)

- **Spec coverage:** activity/completed/on-time/cycle-time metrics → Tasks 6-7,10; completion definition + `completedAt` → Tasks 1-3; per-list auto-archive config → Tasks 3,5; admin-all/member-own access → Tasks 4,7; separate Analytics nav → Task 8; filters (time/board/member/period compare) → Tasks 9-10 (+`getOverview.previous`); auto-archive automation → Tasks 11-13; testing → each task's TDD steps.
- **Known testing limitation (stated honestly):** repo SQL aggregation is not unit-tested (this repo mocks the DB in unit tests); it is validated end-to-end via the `verify` skill in Task 10 Step 7. Router access-control, completion hooks, permission defaults, and the cron handler ARE unit-tested.
- **Type consistency:** filter object `{ workspaceId, from, to, boardId?, memberId? }` is used identically across `analytics.repo` (Task 6) and the router (Task 7); `workspaceMemberId`-keyed rows are joined by `m.id` in the breakdown; `setCompletedAt`/`clearCompletedAt` names match between Task 2 repo and card router.
- **Open items for the executor to confirm against live code (grep commands provided in-task):** exact `member.repo` list function name; `board.repo.getByPublicId` return shape; the list router's existing workspace-resolution helper name; `api.board.all`/`api.member.list` client shapes; `softDelete`/`cardActivityRepo.create` `deletedBy`/`createdBy` nullability (widen types rather than cast).
