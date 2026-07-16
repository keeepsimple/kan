import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";

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

// Canonical member: one row per userId within the given workspace,
// preferring the active membership, then the most recent id. A user can
// have multiple workspace_members rows for the same workspace (e.g.
// remove-then-reinvite leaves a soft-deleted row alongside a new active
// one, since there is no unique constraint on (userId, workspaceId)).
// Joining cardActivities directly to workspaceMembers would fan out one
// activity into multiple rows in that case, double-counting and
// mis-attributing activity. This subquery collapses those duplicates down
// to a single canonical row before joining. Scoped to a single workspaceId,
// so DISTINCT ON userId alone suffices.
const getCanonicalMemberSubquery = (db: dbClient, workspaceId: number) =>
  db
    .selectDistinctOn([workspaceMembers.userId], {
      id: workspaceMembers.id,
      userId: workspaceMembers.userId,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(
      workspaceMembers.userId,
      sql`(${workspaceMembers.deletedAt} is null) desc`,
      desc(workspaceMembers.id),
    )
    .as("canonical_member");

export const getActivityCountsByMember = (db: dbClient, f: Filter) => {
  const canonicalMember = getCanonicalMemberSubquery(db, f.workspaceId);

  return db
    .select({
      workspaceMemberId: canonicalMember.id,
      count: sql<number>`count(*)::int`,
    })
    .from(cardActivities)
    .innerJoin(cards, eq(cards.id, cardActivities.cardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .innerJoin(
      canonicalMember,
      eq(canonicalMember.userId, cardActivities.createdBy),
    )
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        gte(cardActivities.createdAt, f.from),
        lte(cardActivities.createdAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(canonicalMember.id, f.memberId) : undefined,
      ),
    )
    .groupBy(canonicalMember.id);
};

// Outcome metrics attribute to the workspace member the card was ASSIGNED to
// (cardToWorkspaceMembers). Unlike activity metrics, these are NOT de-duplicated
// across a user's multiple membership rows: if a member is removed and re-invited,
// outcomes earned under the prior membership stay attributed to that prior member id.
// This avoids dropping cards assigned to not-yet-accepted invitees (whose userId is null).
export const getCompletedCountByMember = (db: dbClient, f: Filter) => {
  return db
    .select({
      workspaceMemberId: cardToWorkspaceMembers.workspaceMemberId,
      count: sql<number>`count(*)::int`,
    })
    .from(cards)
    .innerJoin(
      cardToWorkspaceMembers,
      eq(cardToWorkspaceMembers.cardId, cards.id),
    )
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        isNotNull(cards.completedAt),
        gte(cards.completedAt, f.from),
        lte(cards.completedAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId
          ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId)
          : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};

export const getOnTimeStatsByMember = (db: dbClient, f: Filter) => {
  return db
    .select({
      workspaceMemberId: cardToWorkspaceMembers.workspaceMemberId,
      onTime: sql<number>`count(*) filter (where ${cards.completedAt} <= ${cards.dueDate})::int`,
      late: sql<number>`count(*) filter (where ${cards.completedAt} > ${cards.dueDate})::int`,
    })
    .from(cards)
    .innerJoin(
      cardToWorkspaceMembers,
      eq(cardToWorkspaceMembers.cardId, cards.id),
    )
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
        f.memberId
          ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId)
          : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};

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
    .innerJoin(
      cardToWorkspaceMembers,
      eq(cardToWorkspaceMembers.cardId, cards.id),
    )
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
        f.memberId
          ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId)
          : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};

export const getAvgCycleTimeByMember = (db: dbClient, f: Filter) => {
  return db
    .select({
      workspaceMemberId: cardToWorkspaceMembers.workspaceMemberId,
      avgSeconds: sql<number>`coalesce(avg(extract(epoch from (${cards.completedAt} - ${cards.createdAt}))), 0)::float`,
    })
    .from(cards)
    .innerJoin(
      cardToWorkspaceMembers,
      eq(cardToWorkspaceMembers.cardId, cards.id),
    )
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        isNotNull(cards.completedAt),
        gte(cards.completedAt, f.from),
        lte(cards.completedAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId
          ? eq(cardToWorkspaceMembers.workspaceMemberId, f.memberId)
          : undefined,
      ),
    )
    .groupBy(cardToWorkspaceMembers.workspaceMemberId);
};

export const getActivityTimeSeries = (db: dbClient, f: Filter) => {
  const canonicalMember = getCanonicalMemberSubquery(db, f.workspaceId);

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
      canonicalMember,
      eq(canonicalMember.userId, cardActivities.createdBy),
    )
    .where(
      and(
        eq(boards.workspaceId, f.workspaceId),
        gte(cardActivities.createdAt, f.from),
        lte(cardActivities.createdAt, f.to),
        f.boardId ? eq(boards.id, f.boardId) : undefined,
        f.memberId ? eq(canonicalMember.id, f.memberId) : undefined,
      ),
    )
    .groupBy(sql`date_trunc('day', ${cardActivities.createdAt})`)
    .orderBy(sql`date_trunc('day', ${cardActivities.createdAt})`);
};
