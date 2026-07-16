# Workspace Analytics — Member Performance

**Date:** 2026-07-16
**Status:** Approved (design)
**Scope:** Per-workspace analytics dashboard to track each member's performance, plus a
list-completion flag and an auto-archive automation that the analytics build depends on.

## Goal

Give a workspace a dashboard that answers "how is each member performing?" using data the app
already records — no new event tracking. Four metric groups (all requested):

1. **Activity volume** — cards created, list moves, comments, checklist items completed, etc.
2. **Completed cards** — cards moved into a list marked as "completed".
3. **On-time vs overdue** — completed-before-`dueDate` vs late; count of currently-overdue cards.
4. **Cycle time** — average time from card creation to completion.

## Two core concepts

### Attribution model (approved)

Two metric families, attributed differently on purpose:

| Family | Attributed to | Source |
|---|---|---|
| **Activity** (card created, moved, commented, checklist completed…) | the **actor** who performed it (`cardActivities.createdBy` / `cardActivities.workspaceMemberId`) | `card_activity` |
| **Outcome** (completed cards, on-time/overdue, cycle time) | the card's **assignee(s)** (`card_to_workspace_members`) | `card` |

Rationale: attributing a completion to whoever dragged the card to Done would credit a manager for
an assignee's work. A card with multiple assignees counts once per assignee. A card with no
assignee is grouped as "Unassigned" in team totals and excluded from per-member rows.

### Completion definition (approved)

A card is **completed** when it is moved into a list whose `isCompleted` flag is true. That moment
is stored in `card.completedAt`. This single timestamp powers cycle time, on-time/overdue, and the
auto-archive countdown. `card.archived` (manual delete) is **not** treated as completion — in this
codebase archive == soft-delete, which usually means "removed", not "done".

## 1. Schema changes (`packages/db`)

**`lists` table** — per-list config:
- `isCompleted: boolean` NOT NULL default `false` — marks a "done" column.
- `autoArchiveEnabled: boolean` NOT NULL default `false`.
- `autoArchiveDays: integer` (nullable) — N days before auto-archive.

**`cards` table** — cheap outcome queries (avoids scanning activities):
- `completedAt: timestamp` (nullable) — when the card entered a completed list.
- `completedBy: uuid` (nullable, `references users.id onDelete set null`) — who moved it in
  (fallback attribution when the card has no assignee).

Drizzle migration. Because `isCompleted` defaults `false`, no list is "completed" at migration
time, so **no historical backfill is required by the migration**.

## 2. `completedAt` maintenance logic

- **On card move** (in the `card` router update/move procedure that already writes a
  `card.updated.list` activity):
  - entering an `isCompleted` list from a non-completed list → set `completedAt = now`,
    `completedBy = userId`.
  - leaving all completed lists → clear `completedAt` and `completedBy` to `null`.
  - moving between two completed lists → keep behaviour simple: set `completedAt = now` (latest
    completion).
- **On toggling a list's `isCompleted`** (list update procedure):
  - `false → true`: backfill `completedAt` for cards currently in that list, using the most recent
    `card.updated.list` activity with `toListId = list.id` (fallback `card.createdAt`).
  - `true → false`: clear `completedAt`/`completedBy` for cards currently in that list.

## 3. API layer (`packages/api`)

**New repository** `src/repository/analytics.repo.ts` — function-per-operation SQL aggregation,
routers never touch Drizzle directly:
- `getMemberActivityCounts(db, { workspaceId, from, to, boardId?, memberId? })` — activity counts
  grouped by acting member (+ breakdown by activity type).
- `getCompletedCardsByAssignee(db, { workspaceId, from, to, boardId?, memberId? })` — completed
  count grouped by assignee, filtered by `completedAt` in range.
- `getOnTimeStats(db, {...})` — on-time vs late (`completedAt <= dueDate`), plus currently-overdue
  (`completedAt IS NULL AND dueDate < now AND deletedAt IS NULL`).
- `getCycleTimeByAssignee(db, {...})` — avg `completedAt - createdAt` grouped by assignee.
- `getActivityTimeSeries(db, {...})` — per-day series for trend charts.

Board filtering joins `card_activity → card → list → board` (and `card → list → board` for
outcomes). Date filters use `createdAt` (activities) / `completedAt` (outcomes).

**New router** `analyticsRouter` (registered in `root.ts` as `analytics`). All `protectedProcedure`
with `.meta({ openapi })` + zod `.input()`/`.output()` so they surface on REST `/api/v1` too.
Shared input: `{ workspacePublicId, from: Date, to: Date, boardPublicId?: string, memberPublicId?: string }`.
- `getOverview` — workspace KPI totals + percent change vs the immediately preceding period of equal
  length.
- `getMemberBreakdown` — per-member leaderboard rows (activity, completed, on-time %, avg cycle time).
- `getTimeSeries` — trend chart data.

**Access control (approved):** add two permissions to the shared permission enum + default role map:
- `analytics:view` — view own stats (admin, member).
- `analytics:view:all` — view the whole team (admin only). Guest gets neither.

Each procedure resolves the caller's workspace membership. If the caller lacks `analytics:view:all`,
the server forces `memberPublicId` to the caller's own member id (a member cannot read another
member's numbers by passing a different id). Enforced server-side via the existing permission
helpers in `src/utils/permissions.ts`.

## 4. Auto-archive automation

**Endpoint** `apps/web/src/pages/api/cron/archive-completed.ts`:
- Auth: require `Authorization: Bearer ${CRON_SECRET}`; reject otherwise. `CRON_SECRET` is a new env
  var — add to `.env.example` and `turbo.json` `globalEnv`.
- Logic: select cards where `deletedAt IS NULL`, current list has `isCompleted = true` and
  `autoArchiveEnabled = true`, and `now - completedAt >= autoArchiveDays days`. For each: soft-delete
  (set `deletedAt = now`, `deletedBy = null` since it is a system action) and write a `card.archived`
  activity with `createdBy = null`. Return the archived count. Reuses the existing card soft-delete +
  activity path so behaviour matches manual archive.
- Scheduling: documented, deployment-agnostic — Vercel Cron entry in `vercel.json`, or a system
  cron / `curl` for self-host, running once per day.
- Auto-archived completed cards keep `completedAt`, so analytics **still counts them as completed**.
  Manually-deleted non-completed cards have `completedAt IS NULL` and are never miscounted.

## 5. Frontend (`apps/web`)

- **Nav item "Analytics"** in the sidebar alongside Boards/Members, following the existing
  `src/views/<feature>/` + thin `src/pages/` route pattern (`src/views/analytics/`).
- **Dashboard layout**: KPI row (total activity, completed cards, on-time rate, avg cycle time,
  each with % vs previous period) → trend chart over time → per-member breakdown table. Filters:
  time range (7 / 30 / 90 / custom), board, member. Members without `analytics:view:all` see only
  their own data and the member filter is hidden.
- **List config UI**: in the board list dropdown/edit, add a "Mark as completed" toggle and, when
  on, an auto-archive toggle + days input.
- Charts follow the `dataviz` skill for a consistent, theme-aware look. All strings use Lingui
  macros; catalogs updated via `lingui:extract`/`compile`.

## 6. Testing

Vitest in `packages/api` and `apps/web`, TDD-first:
- `analytics.repo` / router: correct counts under the attribution model; member vs admin access
  (a member cannot read another member's numbers); date-range boundaries; board filter.
- `completedAt` maintenance: set on entering completed list, cleared on leaving, backfilled on
  toggling `isCompleted`.
- Auto-archive: archives only cards past N days, skips already-deleted cards, respects
  `autoArchiveEnabled`.

## Build order

1. Schema + `completedAt` maintenance + list-config UI (independently shippable).
2. Analytics repo/router + dashboard UI.
3. Auto-archive cron endpoint + scheduling docs.

Each phase runs independently; each gets its own plan → implementation cycle if desired.

## Non-goals (YAGNI)

- No new per-action event tracking — reuse `card_activity`.
- No custom report builder / CSV export in v1.
- No real-time streaming; dashboard is request/response.
- No org-wide (cross-workspace) analytics — scoped to a single workspace.
