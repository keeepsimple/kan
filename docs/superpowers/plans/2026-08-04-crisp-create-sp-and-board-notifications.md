# Crisp `!create-sp` → Discord forum + board notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Crisp operator writes `!create-sp #board-slug Title` in a private note; Kan creates the card in that board's first list and posts it to Discord as a forum post, and anyone with that board open gets a sound, a tab badge, and a desktop notification.

**Architecture:** Part 1 rewires the existing `handleCrispWebhook` (`packages/api/src/utils/crisp.ts`) to resolve a board by slug and to call the same `notifyCardCreated` + `emitFromList` the card router already calls — no new Discord code. Part 2 adds an `actorUserId` to every SSE board event so the SSE route can tell each connection whether a change was its own, and adds a dependency-injected notifier module in `apps/web` that the board/card views drive.

**Tech Stack:** TypeScript, tRPC v11, Drizzle ORM, Next.js 15 (pages router), React 18, Vitest, Lingui.

**Spec:** `docs/superpowers/specs/2026-08-04-crisp-create-sp-and-board-notifications-design.md`

## Global Constraints

- Never expose internal numeric `id`s in API inputs/outputs or client payloads — use the 12-char `publicId`.
- Repositories are the only place that touches Drizzle; routers and utils call repo functions.
- Soft deletes: every query filters `isNull(deletedAt)`.
- Webhook handlers must never throw to the caller — log and return HTTP 200.
- All user-facing strings go through Lingui macros (`t\`…\``), then `pnpm --filter @kan/web lingui:extract && pnpm --filter @kan/web lingui:compile`.
- Command prefix is exactly `!create-sp` followed by a space, matched after `trim()`, case-sensitive.
- Board slug token regex is exactly `/^#([a-z0-9-]{1,255})$/i`; the captured slug is lowercased.
- `THROTTLE_MS = 5000`; localStorage key is exactly `kan:board-notify`.
- Tests live only in `apps/web` and `packages/api` (`packages/db` has no test runner).
- Run `pnpm typecheck` and `pnpm lint` before every commit.

## Deviations from the spec (decided while planning)

1. **Tab badge is rendered through `PageHead`, not by assigning `document.title`.**
   `apps/web/src/components/PageHead.tsx` sets the title via `next/head`. An
   imperative `document.title = …` would be overwritten on the next React
   render. Instead `useBoardEvents` returns an `unreadCount` and the views
   prefix their existing `PageHead` title. Same visible behaviour, no fight
   with React.
2. **The notification logic lives in a plain module, not inside the hook.**
   `apps/web` has no jsdom or `@testing-library/react`, and adding them for one
   hook is not worth it. `apps/web/src/utils/boardNotifier.ts` takes its
   browser dependencies by injection so it is fully testable under the existing
   node-environment Vitest; `useBoardNotifications` stays a thin untested
   wrapper.
3. **The spec says "~37 emit call sites"; the real number is 28** (that count
   included import lines and the definitions themselves). Task 5 lists all 28.

---

## Part 1 — Crisp `!create-sp`

### Task 1: Command parser

**Files:**
- Modify: `packages/api/src/utils/crisp.ts:12-32`
- Test: `packages/api/src/utils/crisp.test.ts:30-70` (rewrite the `parseCardCommand` describe block)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const CARD_COMMAND_PREFIX = "!create-sp";
  export interface ParsedCardCommand {
    boardSlug: string | null;  // lowercased, no leading "#"
    title: string;             // title with the #slug token removed
    rawTitle: string;          // first line verbatim, #slug token included
    body: string;
  }
  export function parseCardCommand(content: string): ParsedCardCommand | null;
  ```

- [ ] **Step 1: Replace the `parseCardCommand` tests**

Replace the whole `describe("parseCardCommand", …)` block in
`packages/api/src/utils/crisp.test.ts` with:

```ts
describe("parseCardCommand", () => {
  it("returns null when content does not start with the prefix", () => {
    expect(parseCardCommand("hello world")).toBeNull();
    expect(parseCardCommand("please !create-sp do thing")).toBeNull();
  });

  it("no longer accepts the old #card prefix", () => {
    expect(parseCardCommand("#card Fix login bug")).toBeNull();
  });

  it("returns null for a bare prefix with no title", () => {
    expect(parseCardCommand("!create-sp")).toBeNull();
    expect(parseCardCommand("!create-sp    ")).toBeNull();
  });

  it("extracts a single-line title with empty body and no slug", () => {
    expect(parseCardCommand("!create-sp Fix login bug")).toEqual({
      boardSlug: null,
      title: "Fix login bug",
      rawTitle: "Fix login bug",
      body: "",
    });
  });

  it("trims surrounding whitespace before matching the prefix", () => {
    expect(parseCardCommand("  !create-sp Fix login bug  ")).toEqual({
      boardSlug: null,
      title: "Fix login bug",
      rawTitle: "Fix login bug",
      body: "",
    });
  });

  it("uses the first line as title and the rest as body", () => {
    expect(
      parseCardCommand(
        "!create-sp Fix login bug\nUser cannot sign in\nwith SSO",
      ),
    ).toEqual({
      boardSlug: null,
      title: "Fix login bug",
      rawTitle: "Fix login bug",
      body: "User cannot sign in\nwith SSO",
    });
  });

  it("extracts a board slug from the first token", () => {
    expect(parseCardCommand("!create-sp #support Fix login bug\nbody")).toEqual({
      boardSlug: "support",
      title: "Fix login bug",
      rawTitle: "#support Fix login bug",
      body: "body",
    });
  });

  it("lowercases the slug and accepts hyphens and digits", () => {
    expect(parseCardCommand("!create-sp #Bug-Tracker-2 Crash")).toEqual({
      boardSlug: "bug-tracker-2",
      title: "Crash",
      rawTitle: "#Bug-Tracker-2 Crash",
      body: "",
    });
  });

  it("preserves internal spacing of the title after a slug", () => {
    expect(parseCardCommand("!create-sp #support Fix   login  bug")).toEqual({
      boardSlug: "support",
      title: "Fix   login  bug",
      rawTitle: "#support Fix   login  bug",
      body: "",
    });
  });

  it("returns null for a slug with no title after it", () => {
    expect(parseCardCommand("!create-sp #support")).toBeNull();
    expect(parseCardCommand("!create-sp #support   ")).toBeNull();
  });

  it("keeps a non-slug-shaped # token as part of the title", () => {
    expect(parseCardCommand("!create-sp #lỗi nặng ở checkout")).toEqual({
      boardSlug: null,
      title: "#lỗi nặng ở checkout",
      rawTitle: "#lỗi nặng ở checkout",
      body: "",
    });
  });

  it("caps the title at 2000 characters", () => {
    const long = "a".repeat(2500);
    const parsed = parseCardCommand(`!create-sp ${long}`);
    expect(parsed?.title).toHaveLength(2000);
    expect(parsed?.rawTitle).toHaveLength(2000);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @kan/api exec vitest run src/utils/crisp.test.ts -t "parseCardCommand"`
Expected: FAIL — the current parser still matches `#card` and returns `{ title, body }` without `boardSlug`/`rawTitle`.

- [ ] **Step 3: Rewrite the parser**

Replace `packages/api/src/utils/crisp.ts` lines 12–32 with:

```ts
export const CARD_COMMAND_PREFIX = "!create-sp";

/** A leading `#board-slug` token selects the target board. */
const BOARD_SLUG_RE = /^#([a-z0-9-]{1,255})$/i;

const MAX_TITLE_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 10000;

export interface ParsedCardCommand {
  boardSlug: string | null;
  title: string;
  /** First line verbatim, `#slug` token included — used when the slug
   *  does not resolve, so no typed words are silently dropped. */
  rawTitle: string;
  body: string;
}

export function parseCardCommand(content: string): ParsedCardCommand | null {
  const trimmed = content.trim();

  if (!trimmed.startsWith(`${CARD_COMMAND_PREFIX} `)) return null;

  const rest = trimmed.slice(CARD_COMMAND_PREFIX.length + 1).trim();
  if (!rest) return null;

  const [firstLineRaw = "", ...bodyLines] = rest.split("\n");
  const firstLine = firstLineRaw.trim();
  const body = bodyLines.join("\n").trim();

  const rawTitle = firstLine.slice(0, MAX_TITLE_LENGTH);
  if (!rawTitle) return null;

  const [firstToken = ""] = firstLine.split(/\s+/);
  const slug = BOARD_SLUG_RE.exec(firstToken)?.[1];

  if (slug) {
    // slice, not split/join — keeps the title's internal spacing intact
    const title = firstLine.slice(firstToken.length).trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) return null;
    return { boardSlug: slug.toLowerCase(), title, rawTitle, body };
  }

  return { boardSlug: null, title: rawTitle, rawTitle, body };
}
```

Leave `buildCardDescription` and everything below it untouched for now.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @kan/api exec vitest run src/utils/crisp.test.ts -t "parseCardCommand"`
Expected: PASS (the `handleCrispWebhook` describe block will still fail — Task 3 fixes it).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/utils/crisp.ts packages/api/src/utils/crisp.test.ts
git commit -m "feat(crisp): !create-sp prefix with optional #board-slug"
```

---

### Task 2: Resolve a board's first list by slug

**Files:**
- Modify: `packages/db/src/repository/list.repo.ts:1` (imports), append the new function after `getWorkspaceAndListIdByListPublicId` (ends line 506)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const getFirstListByBoardSlug: (
    db: dbClient,
    args: { boardSlug: string; workspaceId: number },
  ) => Promise<{
    id: number;
    publicId: string;
    name: string;
    createdBy: string;
    workspaceId: number;
    boardPublicId: string;
    boardName: string;
    discordBehaviour: string | null;
    discordRoleIds: string | null;
    boardDiscordChannelId: string | null;
  } | null>;
  ```
  This is deliberately the **same shape** `getWorkspaceAndListIdByListPublicId`
  (line 473) already returns, so Task 3 can treat both branches identically.

`packages/db` has no Vitest runner, so this task has no unit test. It is
covered indirectly by Task 3's mocked handler tests and verified here by
`pnpm typecheck` plus the manual smoke check in Step 3.

- [ ] **Step 1: Widen the imports**

`packages/db/src/repository/list.repo.ts` line 1 and 4 become:

```ts
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { boards, lists } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";
```

- [ ] **Step 2: Append the function**

Add after `getWorkspaceAndListIdByListPublicId` (i.e. after line 506):

```ts
/**
 * The first (lowest-index) live list of a live board identified by its slug,
 * scoped to one workspace. Returns the same shape as
 * getWorkspaceAndListIdByListPublicId so callers can use either
 * interchangeably. Used by the Crisp `!create-sp #slug` command.
 */
export const getFirstListByBoardSlug = async (
  db: dbClient,
  args: { boardSlug: string; workspaceId: number },
) => {
  const [result] = await db
    .select({
      id: lists.id,
      publicId: lists.publicId,
      name: lists.name,
      createdBy: lists.createdBy,
      workspaceId: boards.workspaceId,
      boardPublicId: boards.publicId,
      boardName: boards.name,
      discordBehaviour: lists.discordBehaviour,
      discordRoleIds: lists.discordRoleIds,
      boardDiscordChannelId: boards.discordChannelId,
    })
    .from(lists)
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.slug, args.boardSlug),
        eq(boards.workspaceId, args.workspaceId),
        isNull(boards.deletedAt),
        isNull(lists.deletedAt),
      ),
    )
    .orderBy(asc(lists.index))
    .limit(1);

  return result ?? null;
};
```

- [ ] **Step 3: Typecheck and smoke-check the SQL**

Run: `pnpm typecheck`
Expected: PASS.

Then verify the query shape against a real database (the repo's dev Postgres
must be running):

```bash
pnpm db:studio
```

In Drizzle Studio, confirm a board you own has a `slug`, note its
`workspaceId`, and confirm its lists have distinct `index` values. This is a
read-only sanity check that the column names used above exist; no data changes.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/repository/list.repo.ts
git commit -m "feat(db): getFirstListByBoardSlug for Crisp board targeting"
```

---

### Task 3: Wire the Crisp handler to the board, Discord, and SSE

**Files:**
- Modify: `packages/api/src/utils/crisp.ts:66-142` (`handleCrispWebhook`)
- Test: `packages/api/src/utils/crisp.test.ts` (extend the mock block at the top and the `handleCrispWebhook` describe block)

**Interfaces:**
- Consumes: `parseCardCommand` (Task 1), `listRepo.getFirstListByBoardSlug` (Task 2),
  `notifyCardCreated` from `packages/api/src/utils/discord.ts:164`,
  `emitFromList` from `packages/api/src/events/boardEvents.ts:66`.
- Produces: no new exports. `handleCrispWebhook` keeps its
  `(db, token, body) => Promise<{ status: 200 | 404 | 500; message: string }>`
  signature.

**Note on `emitFromList`'s third argument:** Task 5 adds a required
`actorUserId` parameter. This task is written against the *post-Task-5*
signature. If you execute tasks strictly in order, write
`emitFromList(db, target.publicId, null)` here and expect a TypeScript error
until Task 5 lands — or simply do Task 5 first. Either order works; the
committed end state is the same.

- [ ] **Step 1: Add the new mocks at the top of the test file**

In `packages/api/src/utils/crisp.test.ts`, add below the existing `vi.mock`
calls (after the `./webhook` mock, before the imports):

```ts
vi.mock("@kan/db/repository/list.repo", () => ({
  getFirstListByBoardSlug: vi.fn(),
  getWorkspaceAndListIdByListPublicId: vi.fn(),
}));

vi.mock("./discord", () => ({
  notifyCardCreated: vi.fn(() => Promise.resolve()),
}));

vi.mock("../events/boardEvents", () => ({
  emitFromList: vi.fn(),
}));
```

and below the existing imports:

```ts
import * as listRepo from "@kan/db/repository/list.repo";

import { emitFromList } from "../events/boardEvents";
import { notifyCardCreated } from "./discord";

const mockGetFirstListByBoardSlug =
  listRepo.getFirstListByBoardSlug as ReturnType<typeof vi.fn>;
const mockGetListByPublicId =
  listRepo.getWorkspaceAndListIdByListPublicId as ReturnType<typeof vi.fn>;
const mockNotifyCardCreated = notifyCardCreated as ReturnType<typeof vi.fn>;
const mockEmitFromList = emitFromList as ReturnType<typeof vi.fn>;
```

- [ ] **Step 2: Add the handler tests**

Add this describe block to `packages/api/src/utils/crisp.test.ts`:

```ts
describe("handleCrispWebhook target resolution", () => {
  const DEFAULT_LIST = {
    id: 10,
    publicId: "list_default",
    name: "Inbox",
    createdBy: "user-1",
    workspaceId: 1,
    boardPublicId: "board_default",
    boardName: "Default Board",
    discordBehaviour: null,
    discordRoleIds: null,
    boardDiscordChannelId: null,
  };

  const SLUG_LIST = {
    id: 20,
    publicId: "list_support",
    name: "Triage",
    createdBy: "user-1",
    workspaceId: 1,
    boardPublicId: "board_support",
    boardName: "Support",
    discordBehaviour: "create_thread",
    discordRoleIds: '["123"]',
    boardDiscordChannelId: "999",
  };

  const noteBody = (content: string) => ({
    event: "message:received",
    data: {
      website_id: "site-1",
      session_id: "session-1",
      type: "note",
      from: "operator",
      content,
      user: { nickname: "Alice" },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveBySecret.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      crispWebsiteId: "site-1",
      listId: 10,
      createdBy: "user-1",
      list: {
        publicId: "list_default",
        name: "Inbox",
        deletedAt: null,
        board: { publicId: "board_default", name: "Default Board" },
      },
    });
    mockGetListByPublicId.mockResolvedValue(DEFAULT_LIST);
    mockGetFirstListByBoardSlug.mockResolvedValue(SLUG_LIST);
    mockCardCreate.mockResolvedValue({ id: 77, publicId: "card_abc" });
  });

  it("creates the card in the slug board's first list", async () => {
    const result = await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(result).toEqual({ status: 200, message: "Card created" });
    expect(mockGetFirstListByBoardSlug).toHaveBeenCalledWith({}, {
      boardSlug: "support",
      workspaceId: 1,
    });
    expect(mockCardCreate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ listId: 20, title: "Payment fails" }),
    );
  });

  it("falls back to the default list and keeps the #slug in the title", async () => {
    mockGetFirstListByBoardSlug.mockResolvedValue(null);

    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #nope Payment fails"),
    );

    expect(mockCardCreate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ listId: 10, title: "#nope Payment fails" }),
    );
  });

  it("uses the default list when no slug is given", async () => {
    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp Payment fails"),
    );

    expect(mockGetFirstListByBoardSlug).not.toHaveBeenCalled();
    expect(mockCardCreate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ listId: 10, title: "Payment fails" }),
    );
  });

  it("ignores the note when the default list is soft-deleted", async () => {
    mockGetListByPublicId.mockResolvedValue(null);

    const result = await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp Payment fails"),
    );

    expect(result).toEqual({ status: 200, message: "Ignored" });
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("refuses to create a card in a Discord notify list", async () => {
    mockGetFirstListByBoardSlug.mockResolvedValue({
      ...SLUG_LIST,
      discordBehaviour: "notify",
    });

    const result = await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(result).toEqual({ status: 200, message: "Ignored" });
    expect(mockCardCreate).not.toHaveBeenCalled();
  });

  it("notifies Discord with the resolved list's config and the operator name", async () => {
    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(mockNotifyCardCreated).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        cardId: 77,
        cardPublicId: "card_abc",
        cardTitle: "Payment fails",
        boardName: "Support",
        workspaceId: 1,
        discordChannelId: "999",
        discordBehaviour: "create_thread",
        discordRoleIds: '["123"]',
        listName: "Triage",
        createdBy: "Alice",
      }),
    );
  });

  it("emits an SSE event for the resolved list with a null actor", async () => {
    await handleCrispWebhook(
      {} as never,
      "secret",
      noteBody("!create-sp #support Payment fails"),
    );

    expect(mockEmitFromList).toHaveBeenCalledWith({}, "list_support", null);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm --filter @kan/api exec vitest run src/utils/crisp.test.ts`
Expected: FAIL — `getFirstListByBoardSlug`, `notifyCardCreated` and
`emitFromList` are never called by the current handler.

- [ ] **Step 4: Rewrite the handler body**

In `packages/api/src/utils/crisp.ts`, extend the imports:

```ts
import * as listRepo from "@kan/db/repository/list.repo";

import { emitFromList } from "../events/boardEvents";
import { notifyCardCreated } from "./discord";
```

Then replace everything in `handleCrispWebhook` from the
`const command = parseCardCommand(...)` line to the end of the function with:

```ts
  const command = parseCardCommand(data.content);
  if (!command) return { status: 200, message: "Ignored" };

  let resolvedBySlug = false;
  let target = null as Awaited<
    ReturnType<typeof listRepo.getWorkspaceAndListIdByListPublicId>
  >;

  if (command.boardSlug) {
    target = await listRepo.getFirstListByBoardSlug(db, {
      boardSlug: command.boardSlug,
      workspaceId: integration.workspaceId,
    });
    resolvedBySlug = target !== null;
  }

  if (!target) {
    // Also covers a soft-deleted default list: the repo filters deletedAt.
    target = await listRepo.getWorkspaceAndListIdByListPublicId(
      db,
      integration.list.publicId,
    );
  }

  if (!target) return { status: 200, message: "Ignored" };

  // Mirrors assertListAllowsCardCreation, which the card router enforces for
  // every other creation path. A webhook must not throw, so log and 200.
  if (target.discordBehaviour === "notify") {
    log.warn(
      { listPublicId: target.publicId },
      "Crisp note targeted a Discord notify list — skipped",
    );
    return { status: 200, message: "Ignored" };
  }

  // Slug did not resolve: keep the #slug token in the title so no typed
  // words are silently dropped.
  const title = resolvedBySlug ? command.title : command.rawTitle;

  const description = buildCardDescription({
    body: command.body,
    websiteId: data.website_id,
    sessionId: data.session_id,
    operatorNickname: data.user?.nickname,
  });

  try {
    const newCard = await cardRepo.create(db, {
      title,
      description,
      createdBy: integration.createdBy,
      listId: target.id,
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
          title,
          description,
          dueDate: null,
          listId: target.publicId,
        },
        {
          boardId: target.boardPublicId,
          boardName: target.boardName,
          listName: target.name,
        },
      ),
    ).catch((error) => {
      log.error({ err: error }, "Crisp card webhook fanout failed");
    });

    // Same Discord path as the card router: forum channels get a forum post,
    // text channels get a thread.
    notifyCardCreated(db, {
      cardId: newCard.id,
      cardPublicId: newCard.publicId,
      cardTitle: title,
      boardName: target.boardName,
      workspaceId: integration.workspaceId,
      discordChannelId: target.boardDiscordChannelId,
      discordBehaviour: target.discordBehaviour,
      discordRoleIds: target.discordRoleIds,
      description,
      listName: target.name,
      createdBy: data.user?.nickname ?? null,
    }).catch((error) => {
      log.error({ err: error }, "Crisp Discord notify failed");
    });

    // No acting viewer — an integration created this, so notify everyone.
    emitFromList(db, target.publicId, null);

    return { status: 200, message: "Card created" };
  } catch (error) {
    log.error({ err: error }, "Failed to create card from Crisp note");
    return { status: 500, message: "Internal error" };
  }
}
```

Delete the old `if (integration.list.deletedAt) …` guard — the repo lookup
replaces it.

- [ ] **Step 5: Run the whole Crisp test file**

Run: `pnpm --filter @kan/api exec vitest run src/utils/crisp.test.ts`
Expected: PASS (all describe blocks).

If Task 5 has not run yet, `emitFromList(db, target.publicId, null)` will fail
typecheck with "Expected 2 arguments, but got 3". That is expected; it resolves
in Task 5.

- [ ] **Step 6: Update the stale comment in the webhook route**

`apps/web/src/pages/api/integrations/crisp/[token].ts:13` says "not just #card
notes". Change it to "not just !create-sp notes".

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/utils/crisp.ts packages/api/src/utils/crisp.test.ts \
  apps/web/src/pages/api/integrations/crisp/[token].ts
git commit -m "feat(crisp): route !create-sp cards to a board by slug and post to Discord"
```

---

### Task 4: Settings copy for the new command

**Files:**
- Modify: `apps/web/src/views/settings/components/CrispIntegrationSection.tsx:123,138,139,151`
- Modify: `apps/web/src/locales/*/messages.{json,ts}` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Update the three command strings**

Line 123:

```tsx
{t`Crisp is connected. Operator notes starting with !create-sp create cards in`}{" "}
```

Line 138:

```tsx
<li>{t`In a conversation, write a private note starting with !create-sp followed by the card title.`}</li>
```

Line 139 — replace the stale `!card` shortcut hint (the command is already a
`!` command, so the shortcut suggestion no longer makes sense) with the board
targeting hint:

```tsx
<li>{t`Add #board-slug before the title to send the card to that board's first list, for example: !create-sp #support Payment failed.`}</li>
```

- [ ] **Step 2: Relabel the picker as the default target**

Line 151:

```tsx
{t`Create cards from Crisp conversations: choose the default board and list used when no #board-slug is given, then paste the generated webhook URL into your Crisp dashboard.`}
```

- [ ] **Step 3: Extract and compile catalogs**

Run:
```bash
pnpm --filter @kan/web lingui:extract
pnpm --filter @kan/web lingui:compile
```
Expected: the four changed messages appear in `apps/web/src/locales/en/messages.json`;
other locales get empty translations for them (normal — translators fill them in).

- [ ] **Step 4: Verify the build still typechecks**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/settings/components/CrispIntegrationSection.tsx apps/web/src/locales
git commit -m "feat(crisp): settings copy for !create-sp and #board-slug"
```

---

## Part 2 — Board notifications

### Task 5: Carry the acting user on every board event

**Files:**
- Modify: `packages/api/src/events/boardEvents.ts:7-72`
- Modify (call sites): `packages/api/src/routers/card.ts:256,345,447,526,606,631,716,747,1240,1335,1551`
- Modify (call sites): `packages/api/src/routers/checklist.ts:94,162,229,297,397,458`
- Modify (call sites): `packages/api/src/routers/label.ts:120,176,226`
- Modify (call sites): `packages/api/src/routers/board.ts:557,654,769`
- Modify (call sites): `packages/api/src/routers/list.ts:67,150,262`
- Modify (call sites): `packages/api/src/routers/attachment.ts:162,227`
- Modify (call site): `packages/api/src/utils/crisp.ts` (already written in Task 3)

28 existing call sites in total.

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface BoardEvent {
    boardPublicId: string;
    cardPublicId?: string;
    actorUserId: string | null;
  }
  export function emitBoardEvent(event: BoardEvent): void;
  export function emitFromCard(db: dbClient, cardPublicId: string, actorUserId: string | null): void;
  export function emitFromList(db: dbClient, listPublicId: string, actorUserId: string | null): void;
  export function emitFromLabel(db: dbClient, labelPublicId: string, actorUserId: string | null): void;
  ```
  `actorUserId` is **required**, not optional, so the compiler forces every call
  site to state the actor instead of silently defaulting to "nobody".

- [ ] **Step 1: Change the event type and emit helpers**

In `packages/api/src/events/boardEvents.ts`, replace the interface (lines 7–10)
and the emit helpers (lines 44–72) with:

```ts
export interface BoardEvent {
  boardPublicId: string;
  cardPublicId?: string;
  /** Who caused the change; null for integrations (Crisp) and cron jobs.
   *  The SSE route uses this to tell a connection "this was you". */
  actorUserId: string | null;
}
```

```ts
// Fire-and-forget: realtime is best-effort and must never fail a mutation.
function emitResolved(
  resolve: Promise<string | undefined>,
  actorUserId: string | null,
  cardPublicId?: string,
): void {
  resolve
    .then((boardPublicId) => {
      if (boardPublicId)
        emitBoardEvent({
          boardPublicId,
          actorUserId,
          ...(cardPublicId ? { cardPublicId } : {}),
        });
    })
    .catch(() => undefined);
}

export function emitFromCard(
  db: dbClient,
  cardPublicId: string,
  actorUserId: string | null,
): void {
  emitResolved(
    cardRepo.getBoardPublicIdByCardPublicId(db, cardPublicId),
    actorUserId,
    cardPublicId,
  );
}

export function emitFromList(
  db: dbClient,
  listPublicId: string,
  actorUserId: string | null,
): void {
  emitResolved(
    listRepo.getBoardPublicIdByListPublicId(db, listPublicId),
    actorUserId,
  );
}

export function emitFromLabel(
  db: dbClient,
  labelPublicId: string,
  actorUserId: string | null,
): void {
  emitResolved(
    labelRepo.getBoardPublicIdByLabelPublicId(db, labelPublicId),
    actorUserId,
  );
}
```

- [ ] **Step 2: Run typecheck to enumerate every broken call site**

Run: `pnpm typecheck`
Expected: FAIL with one error per call site ("Expected 3 arguments, but got 2"
for `emitFrom*`, and a missing-property error for each `emitBoardEvent({…})`).
Use this list as the worklist for Step 3.

- [ ] **Step 3: Fix every call site**

In all tRPC routers the acting user is `ctx.user?.id ?? null`.

- `emitFromCard(ctx.db, X)` → `emitFromCard(ctx.db, X, ctx.user?.id ?? null)`
- `emitFromList(ctx.db, X)` → `emitFromList(ctx.db, X, ctx.user?.id ?? null)`
- `emitFromLabel(ctx.db, X)` → `emitFromLabel(ctx.db, X, ctx.user?.id ?? null)`
- `emitBoardEvent({ boardPublicId: X })` → `emitBoardEvent({ boardPublicId: X, actorUserId: ctx.user?.id ?? null })`

Apply to each of the 28 sites listed under **Files** above. `packages/api/src/utils/crisp.ts`
already passes `null` from Task 3.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm --filter @kan/api test`
Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat(events): carry actorUserId on board events"
```

---

### Task 6: Tell each SSE connection whether a change was its own

**Files:**
- Modify: `apps/web/src/pages/api/events/board/[boardPublicId].ts` (the `subscribeToBoard` listener near the end)
- Test: `apps/web/src/pages/api/events/board/board-events.test.ts`

**Interfaces:**
- Consumes: `BoardEvent` with `actorUserId` (Task 5).
- Produces: the SSE wire payload, which the client parses in Task 8:
  ```ts
  { boardPublicId: string; cardPublicId?: string; notify: boolean }
  ```
  `actorUserId` is stripped and never reaches the browser.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/pages/api/events/board/board-events.test.ts`:

```ts
describe("notify flag", () => {
  async function connectAndEmit(
    sessionUserId: string,
    event: { boardPublicId: string; actorUserId: string | null },
  ) {
    mockGetSession.mockResolvedValue({ user: { id: sessionUserId } });
    mockGetBoard.mockResolvedValue({ workspaceId: 1, id: 5 });
    mockHasPermission.mockResolvedValue(true);

    let listener: ((e: unknown) => void) | undefined;
    mockSubscribe.mockImplementation(
      (_board: string, cb: (e: unknown) => void) => {
        listener = cb;
        return vi.fn();
      },
    );

    const { req } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    listener?.({ ...event, cardPublicId: "card_1" });

    const dataWrite = res.write.mock.calls
      .map((call) => String(call[0]))
      .find((chunk) => chunk.startsWith("data: "));
    return JSON.parse(dataWrite!.replace("data: ", "").trim()) as Record<
      string,
      unknown
    >;
  }

  it("sets notify false for the connection that caused the change", async () => {
    const payload = await connectAndEmit("user-1", {
      boardPublicId: "board_aaaaaaaa",
      actorUserId: "user-1",
    });
    expect(payload.notify).toBe(false);
  });

  it("sets notify true for a change made by someone else", async () => {
    const payload = await connectAndEmit("user-1", {
      boardPublicId: "board_aaaaaaaa",
      actorUserId: "user-2",
    });
    expect(payload.notify).toBe(true);
  });

  it("sets notify true for integration changes with no actor", async () => {
    const payload = await connectAndEmit("user-1", {
      boardPublicId: "board_aaaaaaaa",
      actorUserId: null,
    });
    expect(payload.notify).toBe(true);
  });

  it("never leaks actorUserId to the client", async () => {
    const payload = await connectAndEmit("user-1", {
      boardPublicId: "board_aaaaaaaa",
      actorUserId: "user-2",
    });
    expect(payload).not.toHaveProperty("actorUserId");
    expect(payload.cardPublicId).toBe("card_1");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @kan/web exec vitest run src/pages/api/events/board/board-events.test.ts -t "notify flag"`
Expected: FAIL — `payload.notify` is `undefined` and `actorUserId` is present.

- [ ] **Step 3: Strip the actor and add the flag**

In `apps/web/src/pages/api/events/board/[boardPublicId].ts`, replace the
`subscribeToBoard` call with:

```ts
  const unsubscribe = subscribeToBoard(boardPublicId, (event) => {
    // actorUserId identifies who made the change; it must not reach the
    // browser. Each connection only learns whether the change was its own.
    const { actorUserId, ...signal } = event;
    res.write(
      `data: ${JSON.stringify({
        ...signal,
        notify: actorUserId !== session.user.id,
      })}\n\n`,
    );
  });
```

Extend the existing comment block above it with one sentence:

```ts
  // The payload still carries no entity data — only a boolean saying whether
  // this connection caused the change — so notification text is built
  // client-side from data the client already holds.
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @kan/web exec vitest run src/pages/api/events/board/board-events.test.ts`
Expected: PASS (all describes, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/api/events/board
git commit -m "feat(events): send a self-authored notify flag over SSE"
```

---

### Task 7: The notifier module

**Files:**
- Create: `apps/web/src/utils/boardNotifier.ts`
- Test: `apps/web/src/utils/boardNotifier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const NOTIFY_STORAGE_KEY = "kan:board-notify";
  export const THROTTLE_MS = 5000;

  export interface BoardNotifierDeps {
    now: () => number;
    isHidden: () => boolean;
    isEnabled: () => boolean;
    permission: () => NotificationPermission | "unsupported";
    playSound: () => void;
    showDesktop: (args: { title: string; body: string; tag: string }) => void;
    onUnreadChange: (unread: number) => void;
  }

  export interface BoardNotifier {
    notify(args: { boardPublicId: string; boardName: string; body: string }): void;
    reset(): void;
  }

  export function createBoardNotifier(deps: BoardNotifierDeps): BoardNotifier;
  export function readNotifyPref(): boolean;
  export function writeNotifyPref(enabled: boolean): void;
  ```

Everything the browser provides is injected, so this module runs under the
existing node-environment Vitest with no jsdom.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/utils/boardNotifier.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardNotifierDeps } from "./boardNotifier";
import { createBoardNotifier, THROTTLE_MS } from "./boardNotifier";

function setup(overrides: Partial<BoardNotifierDeps> = {}) {
  const state = { time: 0, hidden: true, enabled: true };
  const deps = {
    now: () => state.time,
    isHidden: () => state.hidden,
    isEnabled: () => state.enabled,
    permission: () => "granted" as const,
    playSound: vi.fn(),
    showDesktop: vi.fn(),
    onUnreadChange: vi.fn(),
    ...overrides,
  };
  return { state, deps, notifier: createBoardNotifier(deps) };
}

const EVENT = {
  boardPublicId: "board_aaaaaaaa",
  boardName: "Support",
  body: "This board has new changes",
};

describe("createBoardNotifier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("plays a sound, counts unread, and shows a desktop notification", () => {
    const { deps, notifier } = setup();

    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
    expect(deps.onUnreadChange).toHaveBeenCalledWith(1);
    expect(deps.showDesktop).toHaveBeenCalledWith({
      title: "Support",
      body: "This board has new changes",
      tag: "kan-board-board_aaaaaaaa",
    });
  });

  it("does nothing at all when disabled", () => {
    const { state, deps, notifier } = setup();
    state.enabled = false;

    notifier.notify(EVENT);

    expect(deps.playSound).not.toHaveBeenCalled();
    expect(deps.showDesktop).not.toHaveBeenCalled();
    expect(deps.onUnreadChange).not.toHaveBeenCalled();
  });

  it("throttles a second notification inside the window", () => {
    const { state, deps, notifier } = setup();

    notifier.notify(EVENT);
    state.time += THROTTLE_MS - 1;
    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
  });

  it("notifies again once the throttle window has passed", () => {
    const { state, deps, notifier } = setup();

    notifier.notify(EVENT);
    state.time += THROTTLE_MS;
    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(2);
    expect(deps.onUnreadChange).toHaveBeenLastCalledWith(2);
  });

  it("plays sound but does not count unread while the tab is visible", () => {
    const { state, deps, notifier } = setup();
    state.hidden = false;

    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
    expect(deps.onUnreadChange).not.toHaveBeenCalled();
    expect(deps.showDesktop).not.toHaveBeenCalled();
  });

  it("still plays sound and counts unread when permission is denied", () => {
    const { deps, notifier } = setup({ permission: () => "denied" as const });

    notifier.notify(EVENT);

    expect(deps.playSound).toHaveBeenCalledTimes(1);
    expect(deps.onUnreadChange).toHaveBeenCalledWith(1);
    expect(deps.showDesktop).not.toHaveBeenCalled();
  });

  it("skips the desktop notification when Notification is unsupported", () => {
    const { deps, notifier } = setup({
      permission: () => "unsupported" as const,
    });

    notifier.notify(EVENT);

    expect(deps.showDesktop).not.toHaveBeenCalled();
  });

  it("reset clears the unread count", () => {
    const { deps, notifier } = setup();

    notifier.notify(EVENT);
    notifier.reset();

    expect(deps.onUnreadChange).toHaveBeenLastCalledWith(0);
  });

  it("reset does not fire onUnreadChange when already zero", () => {
    const { deps, notifier } = setup();

    notifier.reset();

    expect(deps.onUnreadChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @kan/web exec vitest run src/utils/boardNotifier.test.ts`
Expected: FAIL — `Cannot find module './boardNotifier'`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/utils/boardNotifier.ts`:

```ts
export const NOTIFY_STORAGE_KEY = "kan:board-notify";

/** Floor between two chimes so a busy board cannot ring continuously. */
export const THROTTLE_MS = 5000;

export interface BoardNotifierDeps {
  now: () => number;
  isHidden: () => boolean;
  isEnabled: () => boolean;
  permission: () => NotificationPermission | "unsupported";
  playSound: () => void;
  showDesktop: (args: { title: string; body: string; tag: string }) => void;
  onUnreadChange: (unread: number) => void;
}

export interface BoardNotifier {
  notify(args: {
    boardPublicId: string;
    boardName: string;
    body: string;
  }): void;
  reset(): void;
}

/**
 * Decides what a board change should do to the browser: chime, bump the tab
 * badge, raise a desktop notification. Every browser API is injected so this
 * stays testable without a DOM.
 */
export function createBoardNotifier(deps: BoardNotifierDeps): BoardNotifier {
  let lastNotifiedAt = -Infinity;
  let unread = 0;

  return {
    notify({ boardPublicId, boardName, body }) {
      if (!deps.isEnabled()) return;

      const at = deps.now();
      if (at - lastNotifiedAt < THROTTLE_MS) return;
      lastNotifiedAt = at;

      deps.playSound();

      // The badge and the popup only make sense when the user isn't looking.
      if (!deps.isHidden()) return;

      unread += 1;
      deps.onUnreadChange(unread);

      if (deps.permission() === "granted")
        deps.showDesktop({
          title: boardName,
          body,
          // One live notification per board: a new one replaces the old.
          tag: `kan-board-${boardPublicId}`,
        });
    },

    reset() {
      if (unread === 0) return;
      unread = 0;
      deps.onUnreadChange(0);
    },
  };
}

export function readNotifyPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(NOTIFY_STORAGE_KEY) === "true";
  } catch {
    // Safari private mode and blocked-storage settings throw on access.
    return false;
  }
}

export function writeNotifyPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, String(enabled));
  } catch {
    // Preference simply does not persist; the in-memory state still applies.
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @kan/web exec vitest run src/utils/boardNotifier.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/utils/boardNotifier.ts apps/web/src/utils/boardNotifier.test.ts
git commit -m "feat(web): board notifier with throttle, badge count, and desktop gating"
```

---

### Task 8: The sound asset

**Files:**
- Create: `apps/web/public/sounds/notification.mp3`
- Create: `apps/web/public/sounds/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the URL path `/sounds/notification.mp3`, used by Task 9.

- [ ] **Step 1: Obtain a CC0 chime**

Download a short (0.2–0.4 s) CC0 / public-domain notification chime — for
example from Pixabay's sound effects (CC0) or Freesound filtered to CC0.
Requirements: mono or stereo MP3, ≤ 25 KB, no silence padding at the start.

Save it as `apps/web/public/sounds/notification.mp3`.

- [ ] **Step 2: Record its provenance**

Create `apps/web/public/sounds/README.md`:

```markdown
# Notification sounds

| File | Source | License |
|---|---|---|
| `notification.mp3` | <paste the exact source URL> | CC0 / public domain |

Kan is AGPLv3; only assets under a permissive or public-domain licence belong
here. Record the source URL and licence for anything added to this folder.
```

Replace the placeholder URL with the real one you downloaded from — do not
leave it unfilled.

- [ ] **Step 3: Verify it is served**

Run: `pnpm dev:next`, then open `http://localhost:3000/sounds/notification.mp3`.
Expected: the browser plays the sound (or downloads it), not a 404.

- [ ] **Step 4: Commit**

```bash
git add apps/web/public/sounds
git commit -m "chore(web): add CC0 notification chime"
```

---

### Task 9: Hook the notifier into the SSE stream

**Files:**
- Create: `apps/web/src/hooks/useBoardNotifications.ts`
- Modify: `apps/web/src/hooks/useBoardEvents.ts` (whole file)

**Interfaces:**
- Consumes: `createBoardNotifier`, `readNotifyPref` (Task 7); the SSE payload
  `{ boardPublicId, cardPublicId?, notify }` (Task 6).
- Produces:
  ```ts
  // useBoardNotifications.ts
  export const NOTIFY_PREF_EVENT = "kan:board-notify-changed";
  export function useBoardNotifications(args: {
    boardPublicId?: string | null;
    boardName?: string | null;
  }): { unreadCount: number; notify: () => void };

  // useBoardEvents.ts
  export function useBoardEvents(
    boardPublicId?: string | null,
    openCardPublicId?: string | null,
    boardName?: string | null,
  ): { unreadCount: number };
  ```
  `NOTIFY_PREF_EVENT` is a `window` CustomEvent the toggle in Task 10 dispatches
  so an already-mounted hook picks up the new preference without a reload.

These are thin React wrappers with no unit tests (see Deviations, item 2);
Task 11 covers them with a manual verification script.

- [ ] **Step 1: Write the notification hook**

Create `apps/web/src/hooks/useBoardNotifications.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@lingui/core/macro";

import type { BoardNotifier } from "~/utils/boardNotifier";
import { createBoardNotifier, readNotifyPref } from "~/utils/boardNotifier";

export const NOTIFY_PREF_EVENT = "kan:board-notify-changed";

const SOUND_URL = "/sounds/notification.mp3";
const SOUND_VOLUME = 0.4;

/**
 * Turns board changes into a chime, a tab badge count, and a desktop
 * notification. The badge count is returned rather than written to
 * document.title, because PageHead owns the title through next/head.
 */
export function useBoardNotifications({
  boardPublicId,
  boardName,
}: {
  boardPublicId?: string | null;
  boardName?: string | null;
}): { unreadCount: number; notify: () => void } {
  const [unreadCount, setUnreadCount] = useState(0);
  const [enabled, setEnabled] = useState(false);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const boardNameRef = useRef(boardName);
  boardNameRef.current = boardName;

  // localStorage is not readable during SSR; read it after mount, and follow
  // the toggle in the board header while mounted.
  useEffect(() => {
    setEnabled(readNotifyPref());
    const sync = () => setEnabled(readNotifyPref());
    window.addEventListener(NOTIFY_PREF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NOTIFY_PREF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const notifier: BoardNotifier = useMemo(
    () =>
      createBoardNotifier({
        now: () => performance.now(),
        isHidden: () => document.hidden,
        isEnabled: () => enabledRef.current,
        permission: () =>
          typeof Notification === "undefined"
            ? "unsupported"
            : Notification.permission,
        playSound: () => {
          const audio = new Audio(SOUND_URL);
          audio.volume = SOUND_VOLUME;
          // Autoplay policies reject until the user has interacted with the
          // page; a silent notification is fine, a crash is not.
          void audio.play().catch(() => undefined);
        },
        showDesktop: ({ title, body, tag }) => {
          const notification = new Notification(title, { body, tag, icon: "/icon-512.png" });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        },
        onUnreadChange: setUnreadCount,
      }),
    [],
  );

  // Clear the badge as soon as the user comes back to the tab.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) notifier.reset();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [notifier]);

  // A different board means a different badge.
  useEffect(() => {
    notifier.reset();
  }, [boardPublicId, notifier]);

  const notify = useCallback(() => {
    if (!boardPublicId) return;
    notifier.notify({
      boardPublicId,
      boardName: boardNameRef.current ?? t`Kan`,
      body: t`This board has new changes`,
    });
  }, [boardPublicId, notifier]);

  return { unreadCount, notify };
}
```

- [ ] **Step 2: Rewrite `useBoardEvents` to use it**

Replace `apps/web/src/hooks/useBoardEvents.ts` in full:

```ts
import { useEffect, useRef } from "react";

import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import { useBoardNotifications } from "./useBoardNotifications";

interface BoardEventSignal {
  boardPublicId: string;
  cardPublicId?: string;
  /** False when this connection caused the change — refetch, but stay quiet. */
  notify: boolean;
}

const DEBOUNCE_MS = 300;

/**
 * Subscribes to server-sent board events and refetches the affected
 * queries. Events are signals only — data still flows through tRPC.
 * EventSource auto-reconnects; every (re)open triggers one invalidate
 * to cover events missed while disconnected.
 *
 * Returns the number of changes seen while the tab was hidden, for the
 * caller to render as a title badge.
 */
export function useBoardEvents(
  boardPublicId?: string | null,
  openCardPublicId?: string | null,
  boardName?: string | null,
): { unreadCount: number } {
  const utils = api.useUtils();
  const openCardRef = useRef(openCardPublicId);
  openCardRef.current = openCardPublicId;

  const { unreadCount, notify } = useBoardNotifications({
    boardPublicId,
    boardName,
  });
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    if (!boardPublicId) return;

    const source = new EventSource(`/api/events/board/${boardPublicId}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cardChanged = false;
    let shouldNotify = false;

    const refresh = () => {
      void utils.board.byId.invalidate();
      if (cardChanged && openCardRef.current) {
        void invalidateCard(utils, openCardRef.current);
      }
      cardChanged = false;
      // One chime per debounced burst, never for our own edits.
      if (shouldNotify) notifyRef.current();
      shouldNotify = false;
    };

    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as BoardEventSignal;
      if (event.cardPublicId && event.cardPublicId === openCardRef.current) {
        cardChanged = true;
      }
      if (event.notify) shouldNotify = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    };

    source.onopen = () => {
      // fires on connect and every auto-reconnect: catch up on missed events
      cardChanged = Boolean(openCardRef.current);
      // A reconnect is not a change — never chime for it.
      shouldNotify = false;
      refresh();
    };

    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [boardPublicId, utils]);

  return { unreadCount };
}
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm typecheck`
Expected: PASS. (Both call sites — `views/board/index.tsx:107` and
`views/card/index.tsx:217` — ignore the return value, which is valid
TypeScript; Task 10 wires them up.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks
git commit -m "feat(web): chime and count board changes from the SSE stream"
```

---

### Task 10: Bell toggle and tab badge

**Files:**
- Create: `apps/web/src/views/board/components/BoardNotificationToggle.tsx`
- Modify: `apps/web/src/views/board/index.tsx:107,607,700`
- Modify: `apps/web/src/views/card/index.tsx:217,322`

**Interfaces:**
- Consumes: `readNotifyPref`, `writeNotifyPref` (Task 7); `NOTIFY_PREF_EVENT`
  (Task 9); `useBoardEvents(...).unreadCount` (Task 9).
- Produces:
  ```tsx
  export default function BoardNotificationToggle(): JSX.Element;
  ```

- [ ] **Step 1: Write the toggle component**

Create `apps/web/src/views/board/components/BoardNotificationToggle.tsx`:

```tsx
import { useEffect, useState } from "react";
import { t } from "@lingui/core/macro";
import { HiOutlineBell, HiOutlineBellSlash } from "react-icons/hi2";

import Button from "~/components/Button";
import { Tooltip } from "~/components/Tooltip";
import { NOTIFY_PREF_EVENT } from "~/hooks/useBoardNotifications";
import { readNotifyPref, writeNotifyPref } from "~/utils/boardNotifier";

/**
 * One switch for sound, tab badge and desktop popup. Sound and badge need no
 * browser permission, so a denied permission does not disable the toggle —
 * only the desktop popup is skipped.
 */
export default function BoardNotificationToggle() {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");

  useEffect(() => {
    setEnabled(readNotifyPref());
    setPermission(
      typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission,
    );
  }, []);

  const toggle = async () => {
    const next = !enabled;

    // Browsers require requestPermission() to run inside a user gesture, so
    // this must stay in the click handler. Turning on succeeds either way —
    // sound and badge work without permission.
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      try {
        setPermission(await Notification.requestPermission());
      } catch {
        setPermission("denied");
      }
    }

    setEnabled(next);
    writeNotifyPref(next);
    window.dispatchEvent(new CustomEvent(NOTIFY_PREF_EVENT));
  };

  const label = !enabled
    ? t`Turn on notifications for this board`
    : permission === "denied"
      ? t`Desktop notifications are blocked by your browser — sound and tab badge still work.`
      : t`Turn off notifications for this board`;

  return (
    <Tooltip content={label}>
      <Button
        variant="secondary"
        iconOnly
        iconLeft={
          enabled ? (
            <HiOutlineBell className="h-5 w-5" aria-hidden="true" />
          ) : (
            <HiOutlineBellSlash className="h-5 w-5" aria-hidden="true" />
          )
        }
        onClick={() => void toggle()}
        aria-label={label}
        aria-pressed={enabled}
      />
    </Tooltip>
  );
}
```

Prop names verified against the real components: `Button` is a default export
whose `iconOnly` branch renders `iconLeft ?? iconRight` and no children
(`apps/web/src/components/Button.tsx:64-71`), and `Tooltip` is a **named**
export taking `content` (`apps/web/src/components/Tooltip.tsx:15`).

- [ ] **Step 2: Wire the board view**

In `apps/web/src/views/board/index.tsx`:

Line 107 becomes:

```tsx
  const { unreadCount } = useBoardEvents(boardId, null, boardData?.name);
```

Line 607's `PageHead` becomes:

```tsx
      <PageHead
        title={`${unreadCount > 0 ? `(${unreadCount}) ` : ""}${boardData?.name ?? (isTemplate ? t`Board` : t`Template`)} | ${workspace.name ?? t`Workspace`}`}
      />
```

Add the toggle next to `<BoardDropdown>` (line 700), inside the same flex
container:

```tsx
            <BoardNotificationToggle />
            <BoardDropdown
```

and import it at the top:

```tsx
import BoardNotificationToggle from "./components/BoardNotificationToggle";
```

- [ ] **Step 3: Wire the card view**

In `apps/web/src/views/card/index.tsx`, line 217 becomes:

```tsx
  const { unreadCount } = useBoardEvents(boardId, cardId);
```

The card view's `PageHead` (line 322) currently wraps the whole title in the
`t` macro, so prefix it from **outside** the macro — otherwise the count
becomes part of the translated message id:

```tsx
      <PageHead
        title={`${unreadCount > 0 ? `(${unreadCount}) ` : ""}${t`${card?.title ?? t`Card`} | ${board?.name ?? t`Board`}`}`}
      />
```

The card view intentionally does not render the toggle — one switch, in the
board header, governs both.

- [ ] **Step 4: Extract and compile catalogs**

Run:
```bash
pnpm --filter @kan/web lingui:extract
pnpm --filter @kan/web lingui:compile
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @kan/web test`
Expected: PASS on all three.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/views apps/web/src/locales
git commit -m "feat(web): bell toggle and unread tab badge for board changes"
```

---

### Task 11: End-to-end verification

**Files:** none changed — this task only runs and records checks.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the full test and check suite**

Run:
```bash
pnpm typecheck
pnpm lint
pnpm --filter @kan/api test
pnpm --filter @kan/web test
```
Expected: all PASS. Record the actual output; do not claim success without it.

- [ ] **Step 2: Verify the Crisp → card → Discord chain**

With `pnpm dev` running and a workspace that has a Crisp integration, a board
whose slug is `support`, and that board linked to a Discord **forum** channel
with its first list set to `create_thread`:

```bash
curl -X POST "http://localhost:3000/api/integrations/crisp/<webhookSecret>" \
  -H "Content-Type: application/json" \
  -d '{"event":"message:received","data":{"website_id":"<crispWebsiteId>","session_id":"test-session","type":"note","from":"operator","content":"!create-sp #support Payment fails\nVisa declined","user":{"nickname":"Alice"}}}'
```

Expected: `{"message":"Card created"}`; a card titled "Payment fails" in the
first list of the `support` board; a new forum post in the linked Discord
channel titled `Payment fails - 📋 Support` with the card embed.

Repeat with `#nope` in place of `#support` and confirm the card lands in the
configured default list with the title `#nope Payment fails`.

- [ ] **Step 3: Verify the notifications**

1. Open the `support` board in browser A, click the bell, accept the browser
   permission prompt.
2. Switch to another tab so the board tab is hidden.
3. In browser B (a different signed-in user) or via the curl in Step 2, change
   something on that board.
4. Expected in browser A: one chime, the tab title becomes `(1) Support | …`,
   and a desktop notification titled "Support". Clicking it focuses the tab.
5. Return to the tab: the `(1)` disappears.
6. With the board tab focused, drag a card yourself. Expected: no chime — your
   own change never notifies you.
7. Trigger two changes within 5 seconds. Expected: one chime, not two.

- [ ] **Step 4: Record the results**

Note anything that did not behave as expected. If everything passed, the
branch is ready for `superpowers:requesting-code-review`.

---

## Spec coverage

| Spec section | Task |
|---|---|
| 1.1 Command parser | 1 |
| 1.2 `getFirstListByBoardSlug` | 2 |
| 1.3 Handler: resolution, notify guard, Discord, SSE, webhook payload | 3 |
| 1.4 Settings UI copy | 4 |
| 1.5 Crisp tests | 1, 3 |
| 2.1 `actorUserId` on events | 5 |
| 2.2 SSE `notify` flag | 6 |
| 2.3 Notifier behaviour (throttle, sound, badge, desktop) | 7, 9 |
| 2.4 `useBoardEvents` changes | 9 |
| 2.5 Bell toggle | 10 |
| 2.6 Sound asset | 8 |
| 2.7 Tests | 6, 7, 11 |
