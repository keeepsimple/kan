# Crisp `!create-sp` → board → Discord forum + board notifications — design

Date: 2026-08-04

## Context

Two pieces already exist and work independently:

- **Crisp → card.** `handleCrispWebhook` (`packages/api/src/utils/crisp.ts`) parses an
  operator private note prefixed `#card` and creates a card in the single list
  configured per workspace (`crisp_integrations.listId`).
- **Card → Discord forum post.** `notifyCardCreated`
  (`packages/api/src/utils/discord.ts:164`) fetches the board's linked channel,
  and for a forum channel (type 15) calls `createForumPost` with card labels
  mapped to forum tags; for a text channel it falls back to `createThread` +
  `postMessage`.

They are not connected: `handleCrispWebhook` calls `cardRepo.create` directly and
only fans out workspace webhooks. It never calls `notifyCardCreated`, so a card
born in Crisp never reaches Discord, and it never calls `emitFromList`, so an open
board does not refresh.

This spec covers two parts, shipped together:

1. Rename the Crisp command to `!create-sp`, let the operator pick the target
   board inline, and wire the Crisp path into the existing Discord + SSE paths.
2. Sound / tab-badge / desktop notifications for board changes while the board
   tab is open.

Decisions taken during brainstorming:

- `!create-sp` **replaces** `#card` (not an alias).
- Target board is named in the command as `#<board-slug>`; the card lands in that
  board's **first list**; missing or unresolvable slug falls back to the
  configured default list.
- Discord behaviour follows **the existing rules unchanged** — no forced-forum
  branch for Crisp cards.
- Notifications fire on **any** board change, excluding the viewer's own actions,
  and only while that board's tab is open (no Web Push).

---

## Part 1 — Crisp `!create-sp`

### 1.1 Command parser (`packages/api/src/utils/crisp.ts`)

```
CARD_COMMAND_PREFIX = "!create-sp"          // replaces "#card"
BOARD_SLUG_RE       = /^#([a-z0-9-]{1,255})$/i
```

`parseCardCommand(content)` returns
`{ boardSlug: string | null; title: string; rawTitle: string; body: string } | null`.

Rules, applied to the trimmed content:

1. Content must start with `!create-sp ` (prefix + a space). Otherwise `null`.
2. `rest` = everything after the prefix, trimmed. Empty → `null`.
3. Split `rest` on `\n`: `firstLine` and `bodyLines`.
4. `rawTitle` = `firstLine.trim()` capped at `MAX_TITLE_LENGTH` (2000) — the
   first line **as typed**, `#slug` token included.
5. If the first whitespace-delimited token of `firstLine` matches `BOARD_SLUG_RE`:
   - `boardSlug` = captured group, lowercased.
   - `title` = remainder of `firstLine`, trimmed, capped at `MAX_TITLE_LENGTH`.
   - If that remainder is empty → return `null` (a slug with no title creates
     nothing).
6. Otherwise `boardSlug = null` and `title = rawTitle`. A `#` token that is not a
   valid slug shape (e.g. `#lỗi nặng`) stays part of the title.
7. `body` = `bodyLines.join("\n").trim()`.

`buildCardDescription` is unchanged.

### 1.2 Target list resolution (`packages/db/src/repository/list.repo.ts`)

New `getFirstListByBoardSlug(db, { boardSlug, workspaceId })`.

Drizzle `select().from(lists).innerJoin(boards, eq(lists.boardId, boards.id))`
with `eq(boards.slug, boardSlug)`, `eq(boards.workspaceId, workspaceId)`,
`isNull(boards.deletedAt)`, `isNull(lists.deletedAt)`, ordered by
`asc(lists.index)`, `limit(1)`.

It returns **the same shape** `getWorkspaceAndListIdByListPublicId` already
returns, so both resolution branches feed one downstream code path:

```
{ id, publicId, name, createdBy, workspaceId,
  boardPublicId, boardName,
  discordBehaviour, discordRoleIds, boardDiscordChannelId } | null
```

### 1.3 Handler changes (`handleCrispWebhook`)

Event filtering (`message:received`, `type === "note"`, `from === "operator"`,
matching `website_id`, string content) is unchanged.

After `parseCardCommand` succeeds:

```
resolvedBySlug = false
target = null

if (command.boardSlug) {
  target = await listRepo.getFirstListByBoardSlug(db, {
    boardSlug: command.boardSlug,
    workspaceId: integration.workspaceId,
  })
  resolvedBySlug = target !== null
}

if (!target) {
  target = await listRepo.getWorkspaceAndListIdByListPublicId(
    db, integration.list.publicId)
}

if (!target) return { status: 200, message: "Ignored" }   // default list deleted
if (target.discordBehaviour === "notify") {
  log.warn(...)
  return { status: 200, message: "Ignored" }
}

title = resolvedBySlug ? command.title : command.rawTitle
```

Notes:

- `getWorkspaceAndListIdByListPublicId` already filters `isNull(lists.deletedAt)`,
  so it returns `null` for a soft-deleted default list. This **replaces** the
  current explicit `integration.list.deletedAt` check.
- A slug that names a board in a different workspace does not resolve (the query
  is scoped by `workspaceId`) and therefore falls back to the default list.
- On fallback the title keeps the `#slug` token (`rawTitle`), so no typed words
  are silently dropped.
- The `notify` guard mirrors `assertListAllowsCardCreation`, which the card router
  enforces for every other creation path. A webhook must not throw, so it logs and
  returns 200 instead.

Card creation is unchanged (`cardRepo.create` with `position: "end"`,
`createdBy: integration.createdBy`, `listId: target.id`).

After creation, three fire-and-forget calls:

1. **Workspace webhook fanout** — as today, but sourced from `target` instead of
   `integration.list`: `listId: target.publicId`, `boardId: target.boardPublicId`,
   `boardName: target.boardName`, `listName: target.name`. (Today it hardcodes the
   default list, which would be wrong once a slug can redirect the card.)
2. **Discord**:
   ```ts
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
     createdBy: data.user?.nickname ?? null,   // the Crisp operator
   }).catch((error) => log.error({ err: error }, "Crisp Discord notify failed"));
   ```
   No label or member names — a Crisp card has none, so `matchForumTags` receives
   an empty list and applies the `REQUIRE_TAG` fallback where the forum demands it.
   Everything after creation (embed sync, mention pings, due reminders) already
   works off `discordThreadId` / `discordMessageId` and needs no change.
3. **SSE**: `emitFromList(db, target.publicId, null)` — see §2.1 for the new
   `actorUserId` parameter; an integration has no acting viewer, so `null`.

### 1.4 Settings UI (`apps/web/src/views/settings/components/CrispIntegrationSection.tsx`)

Three Lingui strings change (lines 123, 138, 139):

- connected state → *"Crisp is connected. Operator notes starting with `!create-sp`
  create cards in"* + the default list name.
- instructions → *"In a conversation, write a private note starting with
  `!create-sp` followed by the card title. Add `#board-slug` before the title to
  send the card to that board's first list."*
- shortcut hint → drop the stale `!card`→`#card` shortcut suggestion; `!create-sp`
  is already typed as a `!` command.

The board/list picker keeps its role but is relabelled as the **default target**
used when no `#board-slug` is given.

Run `pnpm --filter @kan/web lingui:extract` then `lingui:compile`.

### 1.5 Tests (`packages/api/src/utils/crisp.test.ts`)

Parser:
- `!create-sp Title` → `{ boardSlug: null, title: "Title", rawTitle: "Title" }`
- `#card Title` → `null` (old prefix no longer triggers)
- `!create-sp #support Title\nbody` → slug `"support"`, title `"Title"`, body `"body"`
- `!create-sp #SUPPORT Title` → slug lowercased
- `!create-sp #support` → `null`
- `!create-sp #lỗi nặng ở checkout` → `boardSlug: null`, title keeps the `#` token
- title/description length caps still applied

Handler (Discord client and `notifyCardCreated` mocked):
- slug resolves → card created in that board's first list by `index`
- unknown slug → default list, title is `rawTitle` (still contains `#slug`)
- slug of a board in another workspace → default list
- resolved list has `discordBehaviour = "notify"` → no card created
- default list soft-deleted and no slug → no card created
- `notifyCardCreated` receives the **resolved** list's `discordBehaviour`,
  `discordRoleIds`, `boardDiscordChannelId`, and `createdBy` = operator nickname
- `emitFromList` called with the resolved list's `publicId`
- webhook payload carries the resolved board/list, not the default one

**No migration.**

---

## Part 2 — Board notifications (sound + tab badge + desktop)

Scope: the viewer has that board's tab open (possibly hidden or in the
background). No Web Push, no service worker.

### 2.1 Event carries its actor (`packages/api/src/events/boardEvents.ts`)

```ts
export interface BoardEvent {
  boardPublicId: string;
  cardPublicId?: string;
  actorUserId: string | null;
}
```

`emitBoardEvent`, `emitFromCard`, `emitFromList`, `emitFromLabel` and the internal
`emitResolved` all take `actorUserId: string | null` as a **required** parameter.
Required, not optional, so TypeScript forces every one of the ~37 existing call
sites (`card.ts` 12, `checklist.ts` 7, `list.ts` 4, `label.ts` 4, `board.ts` 4,
`attachment.ts` 3, plus the Crisp path) to state the actor rather than silently
inherit a default.

- tRPC routers pass `ctx.user?.id ?? null`.
- The Crisp webhook passes `null`.

### 2.2 Server-side self-filtering (`apps/web/src/pages/api/events/board/[boardPublicId].ts`)

The route already resolves `session.user.id`. In the `subscribeToBoard` listener:

```ts
const { actorUserId, ...signal } = event;
res.write(`data: ${JSON.stringify({
  ...signal,
  notify: actorUserId !== session.user.id,
})}\n\n`);
```

`actorUserId` never reaches the client — the connection that caused the change
simply receives `notify: false`.

The payload deliberately carries **no entity data** (no card title), preserving the
invariant documented in that file: authorization is checked once at connect, and
signals must stay content-free so a revoked viewer learns nothing. Notification
text is built client-side from the board name the client already holds.

### 2.3 Notification hook (`apps/web/src/hooks/useBoardNotifications.ts`)

New hook, returns a `notify()` callback for `useBoardEvents` to call.

```ts
useBoardNotifications(args: {
  boardPublicId: string;
  boardName?: string | null;
}): { notify: () => void }
```

Behaviour:

- **Coalescing** — `notify()` is called from inside the existing 300 ms debounce in
  `useBoardEvents`, so one burst of changes produces at most one notification.
- **Throttle** — a floor of `THROTTLE_MS = 5000` between two notifications, so a
  busy board cannot chime continuously.
- **Enabled check** — does nothing unless the user turned notifications on (§2.5).
- **Sound** — `new Audio("/sounds/notification.mp3")`, `volume = 0.4`, `.play()`
  with `.catch(() => undefined)` to swallow browser autoplay rejections.
- **Tab badge** — a counter incremented only while `document.hidden`, written as
  `document.title = "(" + n + ") " + baseTitle`. `baseTitle` is captured on mount.
  A `visibilitychange` listener resets the counter to 0 and restores `baseTitle`
  when the tab becomes visible. The original title is also restored on unmount.
- **Desktop** — only when `document.hidden` **and** `Notification.permission ===
  "granted"`:
  ```ts
  new Notification(boardName ?? t`Kan`, {
    body: t`This board has new changes`,
    tag: `kan-board-${boardPublicId}`,
    icon: "/icon-512.png",
  })
  ```
  The fixed `tag` makes a new notification replace the previous one for that board
  instead of stacking. `onclick` → `window.focus()` then `notification.close()`.

All strings go through Lingui.

### 2.4 `useBoardEvents` changes

- `BoardEvent` in the hook gains `notify: boolean`.
- `onmessage`: if `event.notify` is true, mark the pending burst as notifiable.
- In the debounced `refresh()`: refetch exactly as today, then call `notify()` if
  the burst was notifiable. Refetching is unconditional — only the chime is gated.
- `onopen`'s catch-up refresh never notifies (it is a reconnect, not a change).
- New optional argument for the board name, passed through to
  `useBoardNotifications`.

### 2.5 Toggle (`apps/web/src/views/board/index.tsx` + new component)

A bell button in the board header, next to `<BoardDropdown>` (`index.tsx:700`),
with three states:

| State | Icon | Click |
|---|---|---|
| off (default) | bell-slash | `Notification.requestPermission()`, then turn on regardless of the answer |
| on | bell | turn off |

- Preference persisted in `localStorage["kan:board-notify"]` — one global setting,
  not per board.
- **Default off.** Nothing chimes and no permission prompt appears until the user
  opts in; `Notification.requestPermission()` is only called from that click,
  which browsers require to be a user gesture.
- The toggle governs all three channels. Sound and tab badge need no browser
  permission, so a `denied` permission does **not** disable the toggle — only the
  desktop popup is skipped (§2.3 already gates it on `permission === "granted"`).
  When permission is `denied` while the toggle is on, the button shows a tooltip:
  *"Desktop notifications are blocked by your browser — sound and tab badge still
  work."*

### 2.6 Asset

`apps/web/public/sounds/notification.mp3` — a CC0 chime, roughly 0.2–0.3 s,
alongside `apps/web/public/sounds/README.md` recording source and license.

### 2.7 Tests

`apps/web/src/pages/api/events/board/board-events.test.ts`:
- event whose `actorUserId` equals the session user → payload has `notify: false`
- event from another user, and one with `actorUserId: null` → `notify: true`
- `actorUserId` never appears in the serialized payload

New `apps/web/src/hooks/useBoardNotifications.test.ts` (vitest + testing-library,
fake timers, stubbed `Audio` / `Notification` / `document.hidden`):
- second call within 5 s does not chime
- badge increments only while `document.hidden`
- title restored on `visibilitychange` back to visible, and on unmount
- disabled toggle → no sound, no badge, no `Notification`
- `Notification` constructed only when hidden and permission granted
- toggle on but permission `denied` → sound plays and badge increments, no
  `Notification` constructed

`packages/api` router tests keep passing after the `actorUserId` parameter is
threaded through (compile-time change, no behavioural assertions to update).

**No migration.**

---

## Non-goals (YAGNI)

- Replying back into the Crisp conversation to confirm the card was created —
  needs Crisp REST credentials the integration does not store.
- Per-board configured target lists (a `crisp_board_targets` table).
- Setting Discord forum tags from the Crisp command.
- Web Push / service worker notifications when no Kan tab is open.
- Notifications while viewing a different page of Kan.
- Separate notification rules for mentions or assignments.
- Per-user sound or volume settings in Settings.
