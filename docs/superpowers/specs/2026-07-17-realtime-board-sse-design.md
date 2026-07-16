# Realtime board updates via SSE — design

Date: 2026-07-17
Status: approved

## Goal

When another user changes a board (cards, lists, labels, checklists, comments,
attachments, board settings), every open board view and open card view
updates within ~1 second — at the lowest possible cost.

## Constraints (from brainstorming)

- Deployment: **self-host only, single Next.js instance** (Docker). No Vercel
  support required for this feature.
- Scope: **board view + open card view**. Not workspace lists, members, or
  settings pages.
- Cost: no new infrastructure. Redis stays optional (it is today —
  `getRedisClient()` may return `null`).
- Capacity target: a ~100-person company. SSE fan-out with an in-process
  emitter handles thousands of concurrent connections per instance; the
  binding resource is post-event `board.byId` refetch load on Postgres,
  bounded by client-side debounce.

## Chosen approach

**SSE + in-process EventEmitter + coarse cache invalidation.**

Rejected alternatives:

- *tRPC v11 subscriptions over SSE* — same result, more moving parts
  (splitLink client config, adapter work, trpc-to-openapi interference).
- *Polling (`refetchInterval`)* — least code but constant DB load per client
  regardless of activity, and 5s latency.

Events are **signals, not data**: `{ boardPublicId, cardPublicId? }` meaning
"this board changed". Clients refetch through existing tRPC queries. No new
state-sync protocol, no permission-sensitive payloads over the event channel.

## Architecture

```
User A mutation (tRPC router) ──► emitBoardEvent() ──► EventEmitter (in-RAM)
                                                          │ channel board:<publicId>
User B browser ◄── SSE GET /api/events/board/[boardPublicId] ◄┘
   └─► debounce 300ms ─► utils.board.byId.invalidate()
                       ─► utils.card.byId.invalidate(openCard) when cardPublicId matches
```

## Components

### 1. Event bus — `packages/api/src/events/boardEvents.ts` (~20 lines)

- `EventEmitter` singleton stored on `globalThis` so Next.js dev hot-reload
  doesn't duplicate it; `setMaxListeners(0)`.
- `emitBoardEvent(event: { boardPublicId: string; cardPublicId?: string })` —
  fire-and-forget, never throws into callers.
- `subscribeToBoard(boardPublicId, cb): () => void` — returns unsubscribe.
- Upgrade path (not built now): swap internals for Redis pub/sub when running
  multiple instances; API and client unchanged.

### 2. SSE endpoint — `apps/web/src/pages/api/events/board/[boardPublicId].ts` (~60 lines)

- Auth mirrors `board.byId` exactly: Better Auth session from request headers
  → `boardRepo.getWorkspaceAndBoardIdByBoardPublicId` →
  `assertPermission(db, userId, workspaceId, "board:view")`. 401 without
  session, 404/403 per existing conventions.
- Response headers: `Content-Type: text/event-stream`,
  `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
  `X-Accel-Buffering: no` (nginx buffering off).
- On subscribe: `subscribeToBoard`; each event written as one SSE `data:`
  line (JSON).
- Heartbeat comment (`:\n\n`) every 25s to survive proxy idle timeouts.
- Cleanup on `req` close: unsubscribe, clear heartbeat interval.

### 3. Emit calls in mutation routers (1 line per success path)

`emitBoardEvent(...)` after successful mutations in:

- `packages/api/src/routers/card.ts` (create/update/move/duplicate/archive/
  delete, comments, member assign — all live here)
- `packages/api/src/routers/list.ts`
- `packages/api/src/routers/board.ts` (rename/visibility/etc. — emit on the
  board itself)
- `packages/api/src/routers/label.ts`
- `packages/api/src/routers/checklist.ts`
- `packages/api/src/routers/attachment.ts`

Notes:
- `sendWebhooksForWorkspace` is only called from 3 sites in `card.ts`, so it
  is **not** a usable choke point — explicit per-mutation emits instead.
- Include `cardPublicId` when the mutation targets a card, so open modals can
  refresh.
- No actor filtering: receiving your own event costs one debounced refetch.

### 4. Client hook — `apps/web/src/hooks/useBoardEvents.ts` (~40 lines)

- `useBoardEvents(boardPublicId, openCardPublicId?)`.
- Opens `EventSource` to the endpoint; closes on unmount/board change.
- `onmessage` → 300ms debounce → `utils.board.byId.invalidate()`; if the
  event's `cardPublicId` equals `openCardPublicId`, also invalidate that card
  via the existing `invalidateCard()` helper
  (`apps/web/src/utils/cardInvalidation.ts`).
- `onopen` (fires on connect **and** every auto-reconnect) → invalidate once,
  covering events missed while disconnected. This is the whole recovery
  story — no replay, no queue.
- Mounted in **two** places (the card is a separate route, not a modal
  inside the board view):
  - `apps/web/src/views/board/index.tsx`: `useBoardEvents(boardPublicId)`
  - `apps/web/src/views/card/index.tsx`: `useBoardEvents(boardId,
    cardPublicId)` — `boardId` is already available there.

## Resilience & limits

- Reconnect: browser-native `EventSource` retry + invalidate-on-open ⇒
  eventual consistency.
- Reverse proxy: `X-Accel-Buffering: no` handles nginx; recommend HTTP/2 to
  avoid the 6-connections-per-origin HTTP/1.1 cap (documented, not code).
- Dev mode: hot reload kills connections; EventSource reconnects — no
  special handling.
- Explicit non-goals (YAGNI): granular cache patching, presence/cursors,
  actor filtering, event replay, multi-instance support, Vercel support.

## Testing

- Vitest, `packages/api`: `boardEvents.ts` — emit reaches subscriber,
  unsubscribe stops delivery, events scoped per board.
- Vitest, `apps/web`: SSE route auth — 401 without session (follow the
  existing cron-route 401 test pattern).
- Manual verification: two browsers on the same board; drag a card in one,
  the other updates in ~1s; same for an open card view receiving a comment.
