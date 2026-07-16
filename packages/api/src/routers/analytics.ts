import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as analyticsRepo from "@kan/db/repository/analytics.repo";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import * as permissionRepo from "@kan/db/repository/permission.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import {
  analyticsFilterSchema,
  analyticsMembersResponseSchema,
  memberBreakdownResponseSchema,
  overviewResponseSchema,
  timeSeriesResponseSchema,
} from "../schemas/analytics";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { memberHasPermission } from "../utils/permissions";

// Resolve workspace + enforce member-vs-admin scoping. Returns the numeric
// filter object the repo expects, with memberId forced to the caller unless
// they hold analytics:view:all.
async function resolveScope(
  ctx: { db: dbClient; user?: { id: string } | null },
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

  const workspace = await workspaceRepo.getByPublicId(
    ctx.db,
    input.workspacePublicId,
  );
  if (!workspace)
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });

  const caller = await permissionRepo.getMemberWithRole(
    ctx.db,
    userId,
    workspace.id,
  );
  if (!caller)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Not a member of this workspace",
    });

  const canView = await memberHasPermission(
    ctx.db,
    caller.id,
    caller.roleId,
    caller.role,
    "analytics:view",
  );
  if (!canView)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to view analytics",
    });

  const canViewAll = await memberHasPermission(
    ctx.db,
    caller.id,
    caller.roleId,
    caller.role,
    "analytics:view:all",
  );

  let memberId: number | undefined;
  if (!canViewAll) {
    memberId = caller.id; // forced to self
  } else if (input.memberPublicId) {
    const target = await memberRepo.getByPublicId(ctx.db, input.memberPublicId);
    if (!target || target.workspaceId !== workspace.id || target.deletedAt)
      throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    memberId = target.id;
  }

  let boardId: number | undefined;
  if (input.boardPublicId) {
    const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
      ctx.db,
      input.boardPublicId,
    );
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

const sum = (rows: { count: number }[]) =>
  rows.reduce((a, r) => a + r.count, 0);

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

  getMembers: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workspaces/{workspacePublicId}/analytics/members-list",
        summary: "Get workspace member list for analytics filtering",
        description:
          "Lightweight member list (publicId + email) for populating the analytics member filter. Only available to callers with analytics:view:all.",
        tags: ["Analytics"],
        protect: true,
      },
    })
    .input(z.object({ workspacePublicId: z.string().min(12) }))
    .output(analyticsMembersResponseSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.user?.id;
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

      const workspace = await workspaceRepo.getByPublicId(
        ctx.db,
        input.workspacePublicId,
      );
      if (!workspace)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });

      const caller = await permissionRepo.getMemberWithRole(
        ctx.db,
        userId,
        workspace.id,
      );
      if (!caller)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a member of this workspace",
        });

      const canViewAll = await memberHasPermission(
        ctx.db,
        caller.id,
        caller.roleId,
        caller.role,
        "analytics:view:all",
      );
      if (!canViewAll)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to view all members",
        });

      const members = await memberRepo.getAllByWorkspaceId(
        ctx.db,
        workspace.id,
      );

      return {
        members: members.map((m) => ({
          publicId: m.publicId,
          email: m.email,
        })),
      };
    }),
});
