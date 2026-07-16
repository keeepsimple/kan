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
