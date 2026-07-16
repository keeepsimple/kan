# Realtime Board Updates (SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When another user changes a board, every open board view and card view updates within ~1 second, with zero new infrastructure.

**Architecture:** tRPC mutations emit `{boardPublicId, cardPublicId?}` signals into an in-process EventEmitter. A pages-router SSE endpoint streams those signals to authorized clients. A client hook receives signals and invalidates the existing `board.byId` / `card.byId` react-query caches (signals, not data — clients refetch through existing tRPC queries).

**Tech Stack:** Node `EventEmitter`, browser-native `EventSource`, Next.js pages-router API route, existing tRPC + react-query + Drizzle stack. **No new dependencies.**

Spec: `docs/superpowers/specs/2026-07-17-realtime-board-sse-design.md`

## Global Constraints

- No new npm dependencies anywhere.
- Redis stays optional and untouched (single-instance deployment; EventEmitter only).
- Events carry only `boardPublicId` (12-char publicId) and optional `cardPublicId` — never entity data.
- Emits are fire-and-forget: a realtime failure must NEVER fail or slow the mutation (no `await` on emit helpers, internal `.catch`).
- All data access goes through `packages/db/src/repository/*.repo.ts` functions (repo convention).
- Conventional commits (`feat:`, `test:`). Every commit message ends with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work happens on branch `feat/realtime-board-sse` (already created; spec + plan committed there).
- Tests: Vitest. Run a single file with `pnpm --filter @kan/api exec vitest run <path>` or `pnpm --filter @kan/web exec vitest run <path>` from repo root.
- The repo has unrelated uncommitted changes in the working tree (`card.ts`, `discord.ts`, `label.repo.ts`, `workspace.repo.ts`, etc.). Only `git add` the files each task names — never `git add -A`.

---

### Task 1: In-process board event bus

**Files:**
- Create: `packages/api/src/events/boardEvents.ts`
- Create: `packages/api/src/events/boardEvents.test.ts`
- Modify: `packages/api/package.json` (add `./events/boardEvents` to `exports`)

**Interfaces:**
- Consumes: nothing (pure Node stdlib).
- Produces (used by Tasks 2, 3, 4):
  - `interface BoardEvent { boardPublicId: string; cardPublicId?: string }`
  - `emitBoardEvent(event: BoardEvent): void`
  - `subscribeToBoard(boardPublicId: string, listener: (event: BoardEvent) => void): () => void` — returns unsubscribe.

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/events/boardEvents.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { emitBoardEvent, subscribeToBoard } from "./boardEvents";

describe("boardEvents bus", () => {
  it("delivers events to subscribers of the same board", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitBoardEvent({ boardPublicId: "board_aaaaaaaa", cardPublicId: "card_11111111" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      boardPublicId: "board_aaaaaaaa",
      cardPublicId: "card_11111111",
    });
    unsubscribe();
  });

  it("does not deliver events for other boards", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitBoardEvent({ boardPublicId: "board_bbbbbbbb" });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);
    unsubscribe();

    emitBoardEvent({ boardPublicId: "board_aaaaaaaa" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers on one board", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeToBoard("board_aaaaaaaa", a);
    const unsubB = subscribeToBoard("board_aaaaaaaa", b);

    emitBoardEvent({ boardPublicId: "board_aaaaaaaa" });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/events/boardEvents.test.ts`
Expected: FAIL — `Cannot find module './boardEvents'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `packages/api/src/events/boardEvents.ts`:

```ts
import { EventEmitter } from "events";

export interface BoardEvent {
  boardPublicId: string;
  cardPublicId?: string;
}

// Singleton on globalThis so Next.js dev hot-reload can't split emitters
// across module instances (same pattern as a typical db-client singleton).
const store = globalThis as unknown as { __kanBoardEvents?: EventEmitter };

function getEmitter(): EventEmitter {
  if (!store.__kanBoardEvents) {
    const emitter = new EventEmitter();
    // One listener per open SSE connection; the default cap of 10 would
    // log warnings with 11+ viewers on a board.
    emitter.setMaxListeners(0);
    store.__kanBoardEvents = emitter;
  }
  return store.__kanBoardEvents;
}

export function emitBoardEvent(event: BoardEvent): void {
  getEmitter().emit(`board:${event.boardPublicId}`, event);
}

export function subscribeToBoard(
  boardPublicId: string,
  listener: (event: BoardEvent) => void,
): () => void {
  const emitter = getEmitter();
  const channel = `board:${boardPublicId}`;
  emitter.on(channel, listener);
  return () => emitter.off(channel, listener);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kan/api exec vitest run src/events/boardEvents.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export the module from @kan/api**

In `packages/api/package.json`, inside the `"exports"` object, after the `"./utils/crisp"` entry, add:

```json
    "./events/boardEvents": {
      "types": "./src/events/boardEvents.ts",
      "default": "./src/events/boardEvents.ts"
    }
```

(Keep valid JSON — add a comma after the `"./utils/crisp"` block.)

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/events/boardEvents.ts packages/api/src/events/boardEvents.test.ts packages/api/package.json
git commit -m "feat(api): in-process board event bus for realtime updates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: boardPublicId resolvers + fire-and-forget emit helpers

**Files:**
- Modify: `packages/db/src/repository/card.repo.ts` (append one function)
- Modify: `packages/db/src/repository/list.repo.ts` (append one function)
- Modify: `packages/db/src/repository/label.repo.ts` (append one function)
- Modify: `packages/api/src/events/boardEvents.ts` (append emit helpers)
- Create: `packages/api/src/events/emitHelpers.test.ts`

**Interfaces:**
- Consumes: `emitBoardEvent`, `BoardEvent` from Task 1; `dbClient` type from `@kan/db/client`.
- Produces (used by Task 3):
  - `emitFromCard(db: dbClient, cardPublicId: string): void`
  - `emitFromList(db: dbClient, listPublicId: string): void`
  - `emitFromLabel(db: dbClient, labelPublicId: string): void`
- Produces (repo layer):
  - `cardRepo.getBoardPublicIdByCardPublicId(db, cardPublicId): Promise<string | undefined>`
  - `listRepo.getBoardPublicIdByListPublicId(db, listPublicId): Promise<string | undefined>`
  - `labelRepo.getBoardPublicIdByLabelPublicId(db, labelPublicId): Promise<string | undefined>`

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/events/emitHelpers.test.ts`. Repos are mocked, so these tests verify: resolution → emit with the right payload; missing entity → no emit; repo rejection → swallowed (no unhandled rejection).

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kan/db/repository/card.repo", () => ({
  getBoardPublicIdByCardPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/list.repo", () => ({
  getBoardPublicIdByListPublicId: vi.fn(),
}));
vi.mock("@kan/db/repository/label.repo", () => ({
  getBoardPublicIdByLabelPublicId: vi.fn(),
}));

import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as listRepo from "@kan/db/repository/list.repo";

import {
  emitFromCard,
  emitFromLabel,
  emitFromList,
  subscribeToBoard,
} from "./boardEvents";

const db = {} as dbClient;
const mockByCard = cardRepo.getBoardPublicIdByCardPublicId as ReturnType<typeof vi.fn>;
const mockByList = listRepo.getBoardPublicIdByListPublicId as ReturnType<typeof vi.fn>;
const mockByLabel = labelRepo.getBoardPublicIdByLabelPublicId as ReturnType<typeof vi.fn>;

// emit helpers are fire-and-forget; flush their internal promise chain
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("emit helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emitFromCard resolves the board and emits with cardPublicId", async () => {
    mockByCard.mockResolvedValue("board_aaaaaaaa");
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromCard(db, "card_11111111");
    await flush();

    expect(mockByCard).toHaveBeenCalledWith(db, "card_11111111");
    expect(listener).toHaveBeenCalledWith({
      boardPublicId: "board_aaaaaaaa",
      cardPublicId: "card_11111111",
    });
    unsubscribe();
  });

  it("emitFromList emits without cardPublicId", async () => {
    mockByList.mockResolvedValue("board_aaaaaaaa");
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromList(db, "list_22222222");
    await flush();

    expect(listener).toHaveBeenCalledWith({ boardPublicId: "board_aaaaaaaa" });
    unsubscribe();
  });

  it("emitFromLabel emits without cardPublicId", async () => {
    mockByLabel.mockResolvedValue("board_aaaaaaaa");
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromLabel(db, "label_33333333");
    await flush();

    expect(listener).toHaveBeenCalledWith({ boardPublicId: "board_aaaaaaaa" });
    unsubscribe();
  });

  it("does not emit when the entity is not found", async () => {
    mockByCard.mockResolvedValue(undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeToBoard("board_aaaaaaaa", listener);

    emitFromCard(db, "card_missing1");
    await flush();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("swallows repo errors (never throws into the mutation)", async () => {
    mockByCard.mockRejectedValue(new Error("db down"));

    expect(() => emitFromCard(db, "card_11111111")).not.toThrow();
    await flush(); // would surface an unhandled rejection if not caught
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/api exec vitest run src/events/emitHelpers.test.ts`
Expected: FAIL — `emitFromCard` (etc.) not exported from `./boardEvents`.

- [ ] **Step 3: Add the repo resolvers**

Append to `packages/db/src/repository/card.repo.ts` (it already imports `dbClient`, `eq`, and the `cards` table — reuse existing imports; add any that are missing to the existing import lines rather than duplicating):

```ts
export const getBoardPublicIdByCardPublicId = async (
  db: dbClient,
  cardPublicId: string,
): Promise<string | undefined> => {
  const result = await db.query.cards.findFirst({
    columns: {},
    where: eq(cards.publicId, cardPublicId),
    with: {
      list: {
        columns: {},
        with: { board: { columns: { publicId: true } } },
      },
    },
  });
  return result?.list.board.publicId;
};
```

Append to `packages/db/src/repository/list.repo.ts`:

```ts
export const getBoardPublicIdByListPublicId = async (
  db: dbClient,
  listPublicId: string,
): Promise<string | undefined> => {
  const result = await db.query.lists.findFirst({
    columns: {},
    where: eq(lists.publicId, listPublicId),
    with: { board: { columns: { publicId: true } } },
  });
  return result?.board.publicId;
};
```

Append to `packages/db/src/repository/label.repo.ts`:

```ts
export const getBoardPublicIdByLabelPublicId = async (
  db: dbClient,
  labelPublicId: string,
): Promise<string | undefined> => {
  const result = await db.query.labels.findFirst({
    columns: {},
    where: eq(labels.publicId, labelPublicId),
    with: { board: { columns: { publicId: true } } },
  });
  return result?.board.publicId;
};
```

(Relations `cards.list`, `lists.board`, `labels.board` all exist in `packages/db/src/schema/`. If a repo file doesn't already import its table or `eq`, add to its existing drizzle import.)

- [ ] **Step 4: Add the emit helpers**

Append to `packages/api/src/events/boardEvents.ts`:

```ts
import type { dbClient } from "@kan/db/client";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as listRepo from "@kan/db/repository/list.repo";
```

(Imports go at the top of the file with the existing `events` import.)

```ts
// Fire-and-forget: realtime is best-effort and must never fail a mutation.
function emitResolved(
  resolve: Promise<string | undefined>,
  cardPublicId?: string,
): void {
  resolve
    .then((boardPublicId) => {
      if (boardPublicId) emitBoardEvent({ boardPublicId, ...(cardPublicId ? { cardPublicId } : {}) });
    })
    .catch(() => undefined);
}

export function emitFromCard(db: dbClient, cardPublicId: string): void {
  emitResolved(
    cardRepo.getBoardPublicIdByCardPublicId(db, cardPublicId),
    cardPublicId,
  );
}

export function emitFromList(db: dbClient, listPublicId: string): void {
  emitResolved(listRepo.getBoardPublicIdByListPublicId(db, listPublicId));
}

export function emitFromLabel(db: dbClient, labelPublicId: string): void {
  emitResolved(labelRepo.getBoardPublicIdByLabelPublicId(db, labelPublicId));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @kan/api exec vitest run src/events/`
Expected: PASS (boardEvents.test.ts 4 tests + emitHelpers.test.ts 5 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @kan/db typecheck && pnpm --filter @kan/api typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/events/boardEvents.ts packages/api/src/events/emitHelpers.test.ts packages/db/src/repository/card.repo.ts packages/db/src/repository/list.repo.ts packages/db/src/repository/label.repo.ts
git commit -m "feat(api): board event emit helpers with publicId resolvers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Emit calls in mutation routers

**Files:**
- Modify: `packages/api/src/routers/card.ts`
- Modify: `packages/api/src/routers/list.ts`
- Modify: `packages/api/src/routers/board.ts`
- Modify: `packages/api/src/routers/label.ts`
- Modify: `packages/api/src/routers/checklist.ts`
- Modify: `packages/api/src/routers/attachment.ts`

**Interfaces:**
- Consumes: `emitBoardEvent`, `emitFromCard`, `emitFromList`, `emitFromLabel` from `../events/boardEvents` (Task 2 signatures).
- Produces: every board-visible mutation emits exactly one event on success.

**Placement rule (applies to every site below):** insert the emit line inside the `.mutation` handler, after the last database write / activity record, immediately before the successful `return` statement. Never inside a `try` that could convert emit issues into mutation failures (the helpers can't throw anyway), never before permission checks. `card.ts` has some mutations with multiple return paths — anchor on the *success* return only.

**Note:** `card.ts`, `packages/db/src/repository/label.repo.ts` and a few other files have unrelated uncommitted changes in the working tree. Line numbers below are approximate anchors from the current tree — locate the named procedure, don't trust raw line offsets. Stage only hunks you added if possible; at minimum verify `git diff --staged` shows only emit lines and imports before committing.

- [ ] **Step 1: Add imports**

Top of each router (with the other `../` imports):

`card.ts`:
```ts
import { emitFromCard, emitFromList } from "../events/boardEvents";
```
`list.ts`:
```ts
import { emitBoardEvent, emitFromList } from "../events/boardEvents";
```
`board.ts`:
```ts
import { emitBoardEvent } from "../events/boardEvents";
```
`label.ts`:
```ts
import { emitBoardEvent, emitFromLabel } from "../events/boardEvents";
```
`checklist.ts`:
```ts
import { emitFromCard } from "../events/boardEvents";
```
`attachment.ts`:
```ts
import { emitFromCard } from "../events/boardEvents";
```

- [ ] **Step 2: Add emit lines — card.ts (9 sites)**

| Procedure (approx. line) | Emit line |
|---|---|
| `create` (~41) | `emitFromList(ctx.db, input.listPublicId);` |
| `addComment` (~252) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `updateComment` (~329) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `deleteComment` (~419) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `addOrRemoveLabel` (~496) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `addOrRemoveMember` (~597) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `update` (~899) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `delete` (~1194) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `duplicate` (~1287) | `emitFromList(ctx.db, input.listPublicId);` |

(`delete` soft-deletes, so the resolver still finds the row. `duplicate` emits on the *target* list's board.)

- [ ] **Step 3: Add emit lines — list.ts (3 sites)**

| Procedure | Emit line |
|---|---|
| `create` (~14) | `emitBoardEvent({ boardPublicId: input.boardPublicId });` |
| `delete` (~68) | `emitFromList(ctx.db, input.listPublicId);` |
| `update` (~149) | `emitFromList(ctx.db, input.listPublicId);` |

(`delete` is a soft delete — resolver still finds the row.)

- [ ] **Step 4: Add emit lines — board.ts (3 sites)**

| Procedure | Emit line |
|---|---|
| `update` (~453) | `emitBoardEvent({ boardPublicId: input.boardPublicId });` |
| `delete` (~558) | `emitBoardEvent({ boardPublicId: input.boardPublicId });` |
| `move` (~653) | `emitBoardEvent({ boardPublicId: input.boardPublicId });` |

- [ ] **Step 5: Add emit lines — label.ts (3 sites)**

| Procedure | Emit line |
|---|---|
| `create` (~66) | `emitBoardEvent({ boardPublicId: input.boardPublicId });` |
| `update` (~125) | `emitFromLabel(ctx.db, input.labelPublicId);` |
| `delete` (~179) | `emitFromLabel(ctx.db, input.labelPublicId);` |

(`delete` is a soft delete — resolver still finds the row.)

- [ ] **Step 6: Add emit lines — checklist.ts (6 sites)**

These procedures already load the checklist/item with its card — reuse the variable each handler already has (it's the same one passed to the existing `syncDiscord(...)` call; put the emit right next to it):

| Procedure | Emit line |
|---|---|
| `create` (~34) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `update` (~96) | `emitFromCard(ctx.db, checklist.card.publicId);` |
| `delete` (~163) | `emitFromCard(ctx.db, checklist.card.publicId);` |
| `createItem` (~229) | `emitFromCard(ctx.db, checklist.card.publicId);` |
| `updateItem` (~296) | `emitFromCard(ctx.db, item.checklist.card.publicId);` |
| `deleteItem` (~395) | `emitFromCard(ctx.db, item.checklist.card.publicId);` |

- [ ] **Step 7: Add emit lines — attachment.ts (2 sites)**

| Procedure | Emit line |
|---|---|
| `confirm` (~92) | `emitFromCard(ctx.db, input.cardPublicId);` |
| `delete` (~163) | `emitFromCard(ctx.db, attachment.card.publicId);` |

(`generateUploadUrl` gets NO emit — nothing is visible until `confirm`. `attachment.card.publicId` is already selected by `cardAttachmentRepo.getByPublicId`.)

- [ ] **Step 8: Typecheck + existing tests still pass**

Run: `pnpm --filter @kan/api typecheck && pnpm --filter @kan/api test`
Expected: typecheck clean; all existing router tests PASS (emit helpers hit mocked repos or no-op — they must not break `card-completion.test.ts`, `list-completion.test.ts`, `board-move.test.ts`. If a test mocks `@kan/db/repository/card.repo` without the new function, the fire-and-forget catch swallows it — tests must not fail on unhandled rejections; if vitest reports one, add the missing mock function `getBoardPublicIdByCardPublicId: vi.fn(() => Promise.resolve(undefined))` to that test's existing `vi.mock` factory).

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/routers/card.ts packages/api/src/routers/list.ts packages/api/src/routers/board.ts packages/api/src/routers/label.ts packages/api/src/routers/checklist.ts packages/api/src/routers/attachment.ts
git commit -m "feat(api): emit board events from board-visible mutations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Warning:** `card.ts` has unrelated uncommitted changes — before this commit, run `git diff --staged packages/api/src/routers/card.ts` and confirm only emit lines + import were staged; if unrelated hunks got staged, unstage (`git restore --staged`) and re-stage selectively (`git add -p`).

---

### Task 4: SSE endpoint

**Files:**
- Create: `apps/web/src/pages/api/events/board/[boardPublicId].ts`
- Create: `apps/web/src/pages/api/events/board/board-events.test.ts`

**Interfaces:**
- Consumes: `subscribeToBoard`, `BoardEvent` from `@kan/api/events/boardEvents` (Task 1); `hasPermission` from `@kan/api/utils/permissions` (already exported: `(db, userId, workspaceId, permission) => Promise<boolean>`); `boardRepo.getWorkspaceAndBoardIdByBoardPublicId(db, boardPublicId)` → `{ id, workspaceId, createdBy } | undefined`; `initAuth` from `@kan/auth/server`; `createDrizzleClient` from `@kan/db/client`.
- Produces: `GET /api/events/board/<boardPublicId>` — SSE stream of `data: {"boardPublicId":"...","cardPublicId":"..."}` lines. 401 no session, 404 unknown board, 403 no `board:view` permission, 405 non-GET.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/pages/api/events/board/board-events.test.ts` (same mocking pattern as `apps/web/src/pages/api/cron/archive-completed.test.ts`):

```ts
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted: vi.mock factories are hoisted above top-level consts, so a
// plain `const mockGetSession = vi.fn()` would hit a TDZ error here.
const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));
vi.mock("@kan/auth/server", () => ({
  initAuth: () => ({ api: { getSession: mockGetSession } }),
}));
vi.mock("@kan/db/client", () => ({ createDrizzleClient: () => ({}) }));
vi.mock("@kan/db/repository/board.repo", () => ({
  getWorkspaceAndBoardIdByBoardPublicId: vi.fn(),
}));
vi.mock("@kan/api/utils/permissions", () => ({
  hasPermission: vi.fn(),
}));
vi.mock("@kan/api/events/boardEvents", () => ({
  subscribeToBoard: vi.fn(() => vi.fn()),
}));

import { subscribeToBoard } from "@kan/api/events/boardEvents";
import { hasPermission } from "@kan/api/utils/permissions";
import * as boardRepo from "@kan/db/repository/board.repo";

import handler from "./[boardPublicId]";

const mockGetBoard = boardRepo.getWorkspaceAndBoardIdByBoardPublicId as ReturnType<typeof vi.fn>;
const mockHasPermission = hasPermission as ReturnType<typeof vi.fn>;
const mockSubscribe = subscribeToBoard as ReturnType<typeof vi.fn>;

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

function mockRes(): MockResponse {
  const res = {} as MockResponse;
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  res.writeHead = vi.fn(() => res);
  res.write = vi.fn(() => true);
  return res;
}

function mockReq(overrides: Partial<NextApiRequest>): {
  req: NextApiRequest;
  close: () => void;
} {
  const closeHandlers: (() => void)[] = [];
  const req = {
    method: "GET",
    query: { boardPublicId: "board_aaaaaaaa" },
    headers: {},
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") closeHandlers.push(cb);
    }),
    ...overrides,
  } as unknown as NextApiRequest;
  return { req, close: () => closeHandlers.forEach((cb) => cb()) };
}

describe("board events SSE endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("rejects non-GET with 405", async () => {
    const { req } = mockReq({ method: "POST" });
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects a missing session with 401", async () => {
    mockGetSession.mockResolvedValue(null);
    const { req } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("rejects an unknown board with 404", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1" } });
    mockGetBoard.mockResolvedValue(undefined);
    const { req } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("rejects a member without board:view with 403", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1" } });
    mockGetBoard.mockResolvedValue({ id: 1, workspaceId: 7, createdBy: "u" });
    mockHasPermission.mockResolvedValue(false);
    const { req } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(mockHasPermission).toHaveBeenCalledWith({}, "user_1", 7, "board:view");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("opens a stream, forwards events, and cleans up on close", async () => {
    vi.useFakeTimers();
    mockGetSession.mockResolvedValue({ user: { id: "user_1" } });
    mockGetBoard.mockResolvedValue({ id: 1, workspaceId: 7, createdBy: "u" });
    mockHasPermission.mockResolvedValue(true);
    const unsubscribe = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribe);

    const { req, close } = mockReq({});
    const res = mockRes();
    await handler(req, res as unknown as NextApiResponse);

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
    expect(mockSubscribe).toHaveBeenCalledWith(
      "board_aaaaaaaa",
      expect.any(Function),
    );

    // forward an event through the captured listener
    const listener = mockSubscribe.mock.calls[0]![1] as (e: unknown) => void;
    listener({ boardPublicId: "board_aaaaaaaa", cardPublicId: "card_1" });
    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ boardPublicId: "board_aaaaaaaa", cardPublicId: "card_1" })}\n\n`,
    );

    // heartbeat fires
    const writesBefore = res.write.mock.calls.length;
    vi.advanceTimersByTime(25_000);
    expect(res.write.mock.calls.length).toBeGreaterThan(writesBefore);

    // close cleans up: unsubscribes and stops the heartbeat
    close();
    expect(unsubscribe).toHaveBeenCalled();
    const writesAfterClose = res.write.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(res.write.mock.calls.length).toBe(writesAfterClose);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @kan/web exec vitest run src/pages/api/events/board/board-events.test.ts`
Expected: FAIL — cannot resolve `./[boardPublicId]`.

- [ ] **Step 3: Write the endpoint**

Create `apps/web/src/pages/api/events/board/[boardPublicId].ts`:

```ts
import type { NextApiRequest, NextApiResponse } from "next";

import { subscribeToBoard } from "@kan/api/events/boardEvents";
import { hasPermission } from "@kan/api/utils/permissions";
import { initAuth } from "@kan/auth/server";
import { createDrizzleClient } from "@kan/db/client";
import * as boardRepo from "@kan/db/repository/board.repo";

// Long-lived stream: tell Next this route resolves outside the normal cycle.
export const config = { api: { externalResolver: true } };

const HEARTBEAT_MS = 25_000; // under common 30s proxy idle timeouts

const db = createDrizzleClient();
const auth = initAuth(db);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { boardPublicId } = req.query;
  if (typeof boardPublicId !== "string" || boardPublicId.length < 12) {
    return res.status(400).json({ message: "Invalid board id" });
  }

  // Same auth chain as the board.byId tRPC procedure.
  const session = await auth.api.getSession({
    headers: new Headers(req.headers as Record<string, string>),
  });
  if (!session?.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
    db,
    boardPublicId,
  );
  if (!board) {
    return res.status(404).json({ message: "Board not found" });
  }

  const allowed = await hasPermission(
    db,
    session.user.id,
    board.workspaceId,
    "board:view",
  );
  if (!allowed) {
    return res.status(403).json({ message: "Forbidden" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: don't buffer the stream
  });
  res.write(": connected\n\n");

  const unsubscribe = subscribeToBoard(boardPublicId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @kan/web exec vitest run src/pages/api/events/board/board-events.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kan/web typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/api/events/board/
git commit -m "feat(web): SSE endpoint streaming board events to authorized clients

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Client hook + mounting in board and card views

**Files:**
- Create: `apps/web/src/hooks/useBoardEvents.ts`
- Modify: `apps/web/src/views/board/index.tsx` (import + 1 hook call)
- Modify: `apps/web/src/views/card/index.tsx` (import + 1 hook call)

**Interfaces:**
- Consumes: `GET /api/events/board/<boardPublicId>` (Task 4); `api.useUtils()` from `~/utils/api`; `invalidateCard(utils, cardPublicId)` from `~/utils/cardInvalidation` (existing helper).
- Produces: `useBoardEvents(boardPublicId?: string | null, openCardPublicId?: string | null): void`.

- [ ] **Step 1: Write the hook**

No unit test for this hook: faking `EventSource` in jsdom tests the mock, not the behavior. It is covered by the Task 6 end-to-end verification. <!-- ponytail: manual E2E only; add a jsdom EventSource fake if this hook grows logic -->

Create `apps/web/src/hooks/useBoardEvents.ts`:

```ts
import { useEffect, useRef } from "react";

import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";

interface BoardEvent {
  boardPublicId: string;
  cardPublicId?: string;
}

const DEBOUNCE_MS = 300;

/**
 * Subscribes to server-sent board events and refetches the affected
 * queries. Events are signals only — data still flows through tRPC.
 * EventSource auto-reconnects; every (re)open triggers one invalidate
 * to cover events missed while disconnected.
 */
export function useBoardEvents(
  boardPublicId?: string | null,
  openCardPublicId?: string | null,
): void {
  const utils = api.useUtils();
  const openCardRef = useRef(openCardPublicId);
  openCardRef.current = openCardPublicId;

  useEffect(() => {
    if (!boardPublicId) return;

    const source = new EventSource(`/api/events/board/${boardPublicId}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cardChanged = false;

    const refresh = () => {
      void utils.board.byId.invalidate();
      if (cardChanged && openCardRef.current) {
        void invalidateCard(utils, openCardRef.current);
      }
      cardChanged = false;
    };

    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as BoardEvent;
      if (event.cardPublicId && event.cardPublicId === openCardRef.current) {
        cardChanged = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    };

    source.onopen = () => {
      // fires on connect and every auto-reconnect: catch up on missed events
      cardChanged = Boolean(openCardRef.current);
      refresh();
    };

    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [boardPublicId, utils]);
}
```

- [ ] **Step 2: Mount in the board view**

In `apps/web/src/views/board/index.tsx`:

Add to the `~/hooks` import block (around line 30, next to `useDragToScroll`):

```ts
import { useBoardEvents } from "~/hooks/useBoardEvents";
```

Directly after the `boardId` definition (currently lines 100–104: `const boardId = params?.boardId ? ... : null;`), add:

```ts
  useBoardEvents(boardId);
```

- [ ] **Step 3: Mount in the card view**

In `apps/web/src/views/card/index.tsx`:

Add to the `~/hooks`-style imports at the top:

```ts
import { useBoardEvents } from "~/hooks/useBoardEvents";
```

In the **main page component** (the one containing `const boardId = board?.publicId;` at ~line 215 — not `CardRightPanel`), directly after that line, add:

```ts
  useBoardEvents(boardId, cardId);
```

(`cardId` is already defined in that component — it's used at ~line 210 in `utils.card.byId.refetch({ cardPublicId: cardId })`.)

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @kan/web typecheck && pnpm --filter @kan/web lint`
Expected: clean. (If lint flags the floating `JSON.parse` type, keep the explicit `as BoardEvent` cast — matches codebase style.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useBoardEvents.ts apps/web/src/views/board/index.tsx apps/web/src/views/card/index.tsx
git commit -m "feat(web): live board/card refresh via SSE board events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suites + typecheck**

Run from repo root:

```bash
pnpm --filter @kan/api test
pnpm --filter @kan/web test
pnpm typecheck
```

Expected: all PASS / clean.

- [ ] **Step 2: Manual two-client check**

1. `pnpm dev:next`
2. Open the same board in two browsers (or one normal + one incognito window, both logged in as workspace members).
3. In DevTools → Network of browser B, confirm a pending `events/board/<id>` request of type `eventsource`.
4. In browser A: create a card, drag a card between lists, rename a list, toggle a label on a card. Each action appears in browser B within ~1s **without focusing the window**.
5. In browser B: open a card. In browser A: add a comment to that card. The comment appears in B's card view within ~1s.
6. Kill and restart the dev server while B stays open: B's stream reconnects (new `eventsource` request) and a subsequent change in A still shows up in B (invalidate-on-open catch-up).
7. Negative check: `curl -i http://localhost:3000/api/events/board/<boardPublicId>` (no cookie) → `401`.

- [ ] **Step 3: Report results**

Report each check with pass/fail. If step 4/5 latency exceeds a few seconds or events never arrive, debug before declaring done (check the server console for emit errors, the Network tab for stream state).

Include in the report this deployment note for the user: when self-hosting behind a reverse proxy, serve over HTTP/2 — on HTTP/1.1 browsers cap ~6 connections per origin, and each open board tab holds one SSE connection. (`X-Accel-Buffering: no` already handles nginx buffering.)

---

## Explicit non-goals (do not build)

- No Redis pub/sub (single instance; swap `boardEvents.ts` internals later if scaling out).
- No granular cache patching, presence, cursors, or actor filtering.
- No SSE for anonymous public-board viewers (endpoint requires a session).
- No emit on `import.ts` (creates brand-new boards nobody is viewing yet) or workspace/member/user routers (outside board view scope).
- No Vercel support for this feature (self-host only, per spec).
